import type { SourcesExecution } from './sources-execution.ts'
import type { PreviewExecution } from './preview-execution.ts'
import type { ControllersExecution } from './controllers-execution.ts'
import type { PresenceExecution } from './presence-execution.ts'
import type { LayoutExecution } from './layout-execution.ts'
import { restoredStyle, writeOwnedStyle, type OwnedElement } from './style-ownership.ts'
import { isLayoutStyleProperty } from '../layout/style-properties.ts'
import {
  observeLayoutStyles,
  trackLayoutStyleSource,
  changeLayoutStyleSource,
} from '../layout/style-observation.ts'
import type { LayoutCandidate } from '../layout/layout-participant.ts'
import { releaseResources } from '../evaluation/resource-cleanup.ts'
import type { PreviewOperation } from './preview-operation.ts'
import { materializeEffect } from './native-effect.ts'
import { layerPropertyKey } from '../model/presentation.ts'
import {
  type SpringPlayback,
  prepareLayerChange,
  planLayerChange,
  planTrackObservations,
  planTrack,
  trackTiming,
  planPresentation,
  planEffectCompletion,
  presentationWrites,
} from './presentation-planner.ts'
import type {
  TrackPlan,
  PresentationPlan,
  PresentationFacts,
  ReceiverAddresses,
  StyleWrite,
  TrackCandidate,
  TrackObservationRequest,
  TrackSnapshot,
} from './presentation-planner.ts'
import type {
  RuntimeDiagnostic,
  BindingFacts,
  ExecutionEnvironment,
  DisplayedRequest,
  DisplayedValue,
} from './execution-contracts.ts'
import { propertyReference, propertyAddresses, canonicalTracks } from '../motion/property-codec.ts'
import {
  declarationTargets,
  composeEvaluatedLayers,
  type EvaluatedLayer,
  type LayerResolution,
} from '../composition/layers.ts'
import type { SourceConnection } from '../evaluation/reactive-value.ts'
import type { VariableValues } from '../evaluation/expression.ts'
import type { Definition } from '../model/definition.ts'
import { type ResolvedTrack } from '../composition/resolve.ts'
import type { PresenceOperation } from './presence-operation.ts'
import { trackLayoutAnimation } from '../layout/geometry-animations.ts'
import { MotionHistory, type MotionSample } from '../motion/motion-history.ts'

let nextEffectId = 0

/** One physical receiver shared by every logical target alias in the current binding. */
export type Receiver = {
  readonly id: number
  readonly element: HTMLElement
}

export type ActiveTrack = {
  id: number
  receiver: Receiver
  track: ResolvedTrack
  animation: Animation
  sourceProperty: string
  sourceDestination: string
  reference?: string
  trajectory?: (milliseconds: number) => MotionSample
  session?: PresenceOperation
  readonly preview: boolean
}

/** Binding validity is retained until rebinding or an explicit definition refresh. */
type BindingStatus = 'unbound' | 'ready' | 'missing' | 'duplicate'

/** Preparing previews suppress live restoration; completed previews also survive reduced-motion changes. */
type PresentationMode = 'live' | 'preparing-preview' | 'preview'

/** Nonempty input group assembled while validating bind entries. */
type TargetElements = [HTMLElement, ...HTMLElement[]]

/** Accepted receiver order for one logical target; aliases can share Receiver records. */
type TargetReceivers = [Receiver, ...Receiver[]]

const emptyResolution = (): LayerResolution => ({
  composition: { layers: {}, states: {} },
  states: new Map(),
  transitions: new Map(),
  presentation: { name: '@layers', targets: [] },
})

/** Implementations supplied per Motion by the integration. */
export interface ExecutorFeatures {
  readonly layout?: typeof LayoutExecution
  readonly presence?: typeof PresenceExecution
  readonly controllers?: typeof ControllersExecution
  readonly preview?: typeof PreviewExecution
  readonly sources?: typeof SourcesExecution
  readonly spring?: SpringPlayback & {
    trajectory: typeof import('../motion/spring-motion.ts').springMotion
  }
}

/**
 * Owns browser receivers, source connections, styles and native effects. Construct
 * before Runtime, then attach its environment once before binding or capture.
 * dispose also supports failed assembly before attachment. Captured leave may
 * continue with retained browser resources after logical Runtime teardown.
 */
export class BrowserExecutor {
  layerResolution: LayerResolution = emptyResolution()

  readonly presented = new Map<string, LayerResolution>()

  private frozen?: { readonly definition: Definition; readonly values: VariableValues }
  environment?: ExecutionEnvironment

  get definition() {
    if (this.frozen) return this.frozen.definition

    /* v8 ignore if -- @preserve: Integration attaches before binding; detached execution installs frozen data before requesting definition or values. */
    if (!this.environment) throw new Error('Presentation executor is not attached')

    return this.environment.definition()
  }

  get values() {
    if (this.frozen) return this.frozen.values

    /* v8 ignore if -- @preserve: Integration attaches before binding; detached execution installs frozen data before requesting definition or values. */
    if (!this.environment) throw new Error('Presentation executor is not attached')

    return this.environment.values()
  }

  freezeEnvironment(detaching = false) {
    const definition = this.definition
    const values = this.values
    this.presence?.freeze(definition, values, this.layerResolution.presentation)

    if (detaching) this.frozen = { definition, values }
  }

  attach(environment: ExecutionEnvironment) {
    this.environment = environment
    this.motion = matchMedia('(prefers-reduced-motion: reduce)')
    this.attached = true
    this.motion.addEventListener('change', this.motionChanged)
  }

  initialize(resolution: LayerResolution) {
    this.layerResolution = resolution
    this.layout?.acceptedPresentation()
  }

  get bindingFacts(): BindingFacts {
    return {
      suspended: this.suspended,
    }
  }

  nextReceiverId = 0
  readonly receivers = new Map<number, Receiver>()

  receiver(id: number): Receiver {
    // Requests/plans are synchronous and use IDs supplied for the current binding.
    return this.receivers.get(id)!
  }

  /** Replaces both binding indexes; the element lookup exists only during registration. */
  private replaceReceivers(targets: ReadonlyMap<string, TargetElements>) {
    const retained = [...(this.presence?.members() ?? [])].flatMap((operation) =>
      operation.receivers.map((binding) => binding.receiver),
    )
    const byElement = new Map(retained.map((receiver) => [receiver.element, receiver]))

    this.receivers.clear()

    for (const receiver of retained) this.receivers.set(receiver.id, receiver)

    this.targetReceivers.clear()

    const register = (element: HTMLElement): Receiver => {
      const previous = byElement.get(element)

      if (previous) return previous

      const receiver = { id: this.nextReceiverId++, element }
      byElement.set(element, receiver)
      this.receivers.set(receiver.id, receiver)

      return receiver
    }

    for (const [target, elements] of targets) {
      const [first, ...rest] = elements
      this.targetReceivers.set(target, [register(first), ...rest.map(register)])
    }
  }

  /** Retires strong registrations only after bindings, operations, and effects release them. */
  pruneReceivers() {
    const retained = new Set([
      ...[...this.targetReceivers.values()].flat().map((receiver) => receiver.id),
      ...[...(this.presence?.members() ?? [])].flatMap((operation) =>
        operation.receivers.map(({ receiver }) => receiver.id),
      ),
      ...this.active.map((entry) => entry.receiver.id),
    ])

    for (const [id, receiver] of this.receivers) {
      if (retained.has(id)) continue

      this.receivers.delete(id)

      // Preview restoration still owns its saved inline baseline until preview
      // teardown. Final disposal also retains failed restoration for an explicit
      // Executor retry; other live terminal failures have no later owner.
      if (this.presentationMode === 'live' && !this.disposed) {
        this.owned = this.owned.filter((entry) => entry.element !== receiver.element)
        this.dirtyProperties.delete(receiver.element)
      }
    }
  }

  /** Materializes a final identifier-based plan; all timing/frame decisions are already pure. */
  private prepareEffect(plan: TrackPlan, receiver: Receiver, preview: boolean): ActiveTrack {
    const animation = materializeEffect(plan, receiver.element)

    return {
      id: plan.id,
      receiver,
      track: plan.track,
      animation,
      sourceProperty: plan.sourceProperty,
      sourceDestination: plan.sourceDestination,
      trajectory: plan.trajectory,
      reference: plan.reference,
      session: preview ? undefined : this.sessionFor(receiver.id, plan.track.property),
      preview,
    }
  }

  readonly targetReceivers = new Map<string, TargetReceivers>()
  active: ActiveTrack[] = []
  /** Failed final cancellations stay owned without remaining live execution entries. */
  private readonly disposalAnimations = new Set<Animation>()
  readonly propertyMotion = new MotionHistory()
  readonly dirtyProperties = new Map<HTMLElement, Set<string>>()
  private referenceFrame?: number

  private owned: OwnedElement[] = []
  presentationMode: PresentationMode = 'live'
  private bindingStatus: BindingStatus = 'unbound'
  disposed = false
  private attached = false
  motion!: MediaQueryList
  readonly report: (diagnostic: RuntimeDiagnostic) => void

  private readonly layout?: LayoutExecution
  private readonly presence?: PresenceExecution
  private readonly controllers?: ControllersExecution
  private readonly preview?: PreviewExecution
  private readonly sources?: SourcesExecution
  readonly spring?: SpringPlayback & {
    trajectory: typeof import('../motion/spring-motion.ts').springMotion
  }

  constructor(report: (diagnostic: RuntimeDiagnostic) => void, features: ExecutorFeatures = {}) {
    this.report = report
    this.layout = features.layout && new features.layout(this)
    this.presence = features.presence && new features.presence(this)
    this.controllers = features.controllers && new features.controllers(this)
    this.preview = features.preview && new features.preview(this)
    this.sources = features.sources && new features.sources(this)
    this.spring = features.spring
  }

  get layoutRevision() {
    return this.layout?.layoutRevision ?? 0
  }

  onLayoutChange?: () => void

  layoutCandidates(transactionRevision?: number): readonly LayoutCandidate[] {
    return this.layout?.layoutCandidates(transactionRevision) ?? []
  }

  layoutTransform(...args: Parameters<LayoutExecution['layoutTransform']>) {
    this.layout?.layoutTransform(...args)
  }

  layoutStyleObservation(...args: Parameters<LayoutExecution['layoutStyleObservation']>) {
    return this.layout?.layoutStyleObservation(...args)
  }

  layoutMeasure(...args: Parameters<LayoutExecution['layoutMeasure']>) {
    return this.layout?.layoutMeasure(...args) ?? (() => {})
  }

  layoutCleanup() {
    this.layout?.layoutCleanup()
  }

  releaseLayout() {
    this.layout?.releaseLayout()
  }

  withStyleSources<T>(elements: readonly HTMLElement[], read: () => T): T {
    return observeLayoutStyles(elements, read)
  }

  capturePresence(...args: Parameters<PresenceExecution['capturePresence']>) {
    if (!this.presence) throw new Error('Missing Presence capability')

    return this.presence.capturePresence(...args)
  }

  enterExclusions(...args: Parameters<PresenceExecution['enterExclusions']>) {
    return this.presence?.enterExclusions(...args) ?? []
  }

  presenceLayers(
    ...args: Parameters<PresenceExecution['presenceLayers']>
  ): readonly EvaluatedLayer[] {
    return this.presence?.presenceLayers(...args) ?? []
  }

  validatePresence(...args: Parameters<PresenceExecution['validatePresence']>) {
    this.presence?.validatePresence(...args)
  }

  private sessionFor(receiver: number, property: string) {
    return this.presence?.sessionFor(receiver, property)
  }

  private cancelEnterSessions(reason: 'superseded' | 'owner-teardown') {
    this.presence?.cancelEnterSessions(reason)
  }

  lifecycleOwns(element: HTMLElement, property: string): boolean {
    return this.presence?.lifecycleOwns(element, property) ?? false
  }

  configureControllers(...args: Parameters<ControllersExecution['configureControllers']>) {
    this.controllers?.configureControllers(...args)
  }

  releaseControllers(time?: number) {
    this.controllers?.releaseControllers(time)
  }

  setControllerPreview(enabled: boolean) {
    this.controllers?.setPreview(enabled)
  }

  terminalControls(time: number) {
    this.controllers?.terminalControls()
    this.flushMotionSamples(time)
  }

  observeReceivers(
    ...args: Parameters<ControllersExecution['observeReceivers']>
  ): readonly ReceiverAddresses[] {
    return this.controllers?.observeReceivers(...args) ?? []
  }

  applyControllers(...args: Parameters<ControllersExecution['applyControllers']>) {
    return this.controllers?.applyControllers(...args) ?? new Map<string, string | undefined>()
  }

  disconnectBindings() {
    this.sources?.disconnectBindings()
  }

  readonly connectSource: SourceConnection = (source, publish) => {
    if (!this.sources) throw new Error('Missing reactive source capability')

    return this.sources.connectSource(source, publish)
  }

  beginPreview(writes: readonly StyleWrite[]) {
    if (!this.preview) throw new Error('Missing preview capability')

    this.preview.beginPreview(writes)
  }

  abortPreview() {
    this.preview?.abortPreview()
  }

  endCompositionPreview() {
    this.preview?.endCompositionPreview()
  }

  completePreview(): PreviewOperation {
    if (!this.preview) throw new Error('Missing preview capability')

    return this.preview.completePreview()
  }

  get suspended() {
    return this.bindingStatus !== 'ready'
  }

  /**
   * Single-receiver consumers use the last entry, matching Map construction from bind entries.
   * @yields Logical target names paired with their last accepted receiving element.
   */
  *representativeTargets() {
    for (const [name, receivers] of this.targetReceivers) {
      // bind creates each group with its first receiver, so every tuple is nonempty.
      yield [name, receivers[receivers.length - 1].element] as const
    }
  }

  resetPresentation() {
    this.endCompositionPreview()
    this.presentationMode = 'preparing-preview'
    this.releaseControllers()
    this.cancel()
    this.restore()
    this.dirtyProperties.clear()
  }

  refreshSuspension(definition: Definition) {
    // A definition replacement does not validate previously rejected duplicate entries.
    this.bindingStatus = this.resolveBindingStatus(
      definition,
      this.targetReceivers,
      this.bindingStatus === 'duplicate',
    )
  }

  private resolveBindingStatus(
    definition: Definition,
    targets: ReadonlyMap<string, unknown>,
    duplicate: boolean,
  ): BindingStatus {
    if (duplicate) return 'duplicate'
    if (this.presence?.supports(definition)) return 'ready'

    const optional = this.controllers?.optionalControllerTargets(definition)
    const missing = declarationTargets(definition).some(
      (target) =>
        target.properties.length > 0 && !optional?.has(target.name) && !targets.has(target.name),
    )

    return missing ? 'missing' : 'ready'
  }

  /** Controller outputs are already accepted in presentation; retain their observation phase. */
  project(
    resolution: LayerResolution,
    receiver: number,
    presence: readonly EvaluatedLayer[],
  ): LayerResolution {
    if (!presence.length) return resolution

    const evaluated = [
      { id: '@application', targets: resolution.presentation.targets },
      ...presence,
    ]

    return {
      ...resolution,
      presentation: {
        ...resolution.presentation,
        targets: composeEvaluatedLayers(evaluated, receiver),
      },
    }
  }

  /**
   * One observation/planning/commit path serves attached layers and detached presence.
   * Each pure planner stage determines the following observation requests. Effects are
   * prepared together before publication; scopes never alter public composition.
   */
  present(
    previous: LayerResolution,
    next: LayerResolution,
    values: VariableValues,
    retargets: ReadonlySet<string> = new Set(),
  ) {
    const exclusions = this.enterExclusions(previous, next)
    const presence = this.presenceLayers(next, values, exclusions)
    const facts = this.presentationFacts()
    const plans: PresentationPlan[] = []
    const accepted = new Map<string, LayerResolution>()

    for (const receiver of facts.receivers) {
      const key = layerPropertyKey(String(receiver.id), receiver.target)
      const restrict = (resolution: LayerResolution): LayerResolution => ({
        ...resolution,
        presentation: {
          ...resolution.presentation,
          targets: resolution.presentation.targets.filter(
            (target) => target.name === receiver.target,
          ),
        },
      })
      const from = this.presented.get(key) ?? restrict(previous)
      const to = restrict(this.project(next, receiver.id, presence))
      const localFacts = {
        ...facts,
        receivers: [receiver],
        active: facts.active.filter(
          (entry) => entry.receiver === receiver.id && entry.target === receiver.target,
        ),
      }
      const preparation = prepareLayerChange({
        previous: from,
        next: to,
        values: this.values,
        active: localFacts.active,
        retargets,
      })
      const displayed = new Map(
        this.observeDisplayed(
          preparation.templates
            .filter((template) => template.implicitStart)
            .map((template) => ({ receiver: receiver.id, property: template.property })),
        ).map((value) => [layerPropertyKey(receiver.target, value.property), value.value]),
      )
      const element = this.receiver(receiver.id).element
      const affected = preparation.changed.size > 0 || preparation.templates.length > 0
      const declarations = affected
        ? to.presentation.targets.flatMap((target) =>
            target.properties.map((property) => ({
              name: property.name,
              addresses: propertyAddresses(element, property.name),
            })),
          )
        : []
      const change = planLayerChange(preparation, displayed, [
        { target: receiver.target, addresses: declarations },
      ])

      for (const message of change.diagnostics) this.report({ code: 'runtime.endpoint', message })

      const timings = new Map(
        change.tracks.map((source) => [source, trackTiming(source, this.spring)]),
      )
      const sources =
        facts.suspended || facts.reduced
          ? []
          : change.tracks
              .filter((source) => timings.get(source)!.durationMs !== 0)
              .map((source) => ({ receiver: receiver.id, source, declarations }))
      const observations = planTrackObservations(
        this.expandTracks(sources),
        localFacts.active,
        true,
      )
      const snapshots = this.observeTracks(observations.requests)
      const start = snapshots.map((snapshot) =>
        planTrack(snapshot, timings.get(snapshot.source)!, 'both', this.spring)!,
      )

      for (const property of observations.changed) change.changed.add(property)

      plans.push(
        planPresentation(
          to,
          localFacts,
          change.changed,
          change.removedProperties,
          start,
          change.preserved,
        ),
      )
      accepted.set(key, to)
    }

    this.applyPlan(
      {
        resolution: next,
        mode: 'live',
        cancel: [...new Set(plans.flatMap((plan) => plan.cancel))],
        restore: plans.some((plan) => plan.restore),
        preserveLifecycle: facts.preserveLifecycle,
        // Restoration affects all receivers, so reapply every accepted scoped cascade.
        writes: plans.some((plan) => plan.restore)
          ? facts.receivers.flatMap((receiver) =>
              presentationWrites(
                accepted.get(layerPropertyKey(String(receiver.id), receiver.target))!,
                [receiver],
              ),
            )
          : plans.flatMap((plan) => plan.writes),
        start: plans.flatMap((plan) => plan.start),
      },
      () => {
        for (const { operation, excluded } of exclusions) {
          operation.interrupted.clear()

          for (const key of excluded) operation.interrupted.add(key)
        }
      },
    )
    this.presented.clear()

    for (const [key, resolution] of accepted) this.presented.set(key, resolution)
  }

  /** Capture a running effect before cancellation; this preserves its displayed derivative. */
  retainMotion(entry: ActiveTrack) {
    const time = performance.now()
    const sample = this.withStyleSources(
      isLayoutStyleProperty(entry.track.property) ? [entry.receiver.element] : [],
      () => this.propertyMotion.read(entry.receiver.element, entry.track.property, time),
    )

    if (sample)
      this.propertyMotion.endControl(
        entry.receiver.element,
        entry.track.property,
        sample.velocity,
        time,
      )
  }

  /** Metadata has no live style values; Runtime chooses which CSS observations follow. */
  presentationFacts(): PresentationFacts {
    const receivers = [...this.targetReceivers].flatMap(([target, bindings]) =>
      bindings.map((receiver) => ({ id: receiver.id, target })),
    )

    for (const operation of this.presence?.members() ?? []) {
      for (const { receiver, target } of operation.receivers) {
        if (!receivers.some((item) => item.id === receiver.id && item.target === target))
          receivers.push({ id: receiver.id, target })
      }
    }

    return {
      mode: this.presentationMode,
      suspended: this.suspended,
      reduced: this.motion.matches,
      preserveLifecycle: this.presence?.hasOperations === true,
      receivers,
      active: this.active.map((entry) => ({
        preview: entry.preview,
        id: entry.id,
        receiver: entry.receiver.id,
        owner: entry.track.owner,
        target: entry.track.target,
        property: entry.track.property,
        sourceProperty: entry.sourceProperty,
        sourceDestination: entry.sourceDestination,
        track: entry.track,
      })),
    }
  }

  expandTracks(
    tracks: readonly {
      readonly receiver: number
      readonly source: ResolvedTrack
      readonly declarations?: ReceiverAddresses['addresses']
    }[],
  ): readonly TrackCandidate[] {
    return tracks.flatMap(({ receiver, source, declarations }) => {
      const element = this.receiver(receiver).element

      return canonicalTracks(element, source).map((track) => ({
        receiver,
        source,
        track,
        declarations: declarations ?? [
          { name: source.property, addresses: propertyAddresses(element, source.property) },
        ],
      }))
    })
  }

  observeDisplayed(requests: readonly DisplayedRequest[]): readonly DisplayedValue[] {
    const styles = new Map<number, CSSStyleDeclaration>()

    return this.withStyleSources(
      requests
        .filter((request) => isLayoutStyleProperty(request.property))
        .map((request) => this.receiver(request.receiver).element),
      () =>
        requests.map((request) => {
          let style = styles.get(request.receiver)

          if (!style) {
            style = getComputedStyle(this.receiver(request.receiver).element)
            styles.set(request.receiver, style)
          }

          return { ...request, value: style.getPropertyValue(request.property) }
        }),
    )
  }

  observeTracks(requests: readonly TrackObservationRequest[]): readonly TrackSnapshot[] {
    return this.withStyleSources(
      requests
        .filter((request) => isLayoutStyleProperty(request.track.property))
        .map((request) => this.receiver(request.receiver).element),
      () =>
        requests.map((request) => {
          const element = this.receiver(request.receiver).element

          return {
            id: nextEffectId++,
            receiver: request.receiver,
            source: request.source,
            track: request.track,
            declarations: request.declarations,
            interrupted: request.interrupted,
            displayed: request.needs.displayed
              ? getComputedStyle(element).getPropertyValue(request.track.property)
              : undefined,
            motion: request.needs.motion
              ? this.propertyMotion.observeSpring(
                  element,
                  request.track.property,
                  request.track.keyframes.at(-1)!.value,
                )
              : undefined,
            reference: request.reference
              ? propertyReference(
                  element,
                  request.source.property,
                  request.source.keyframes.at(-1)!.value,
                )
              : undefined,
          }
        }),
    )
  }

  clearReferenceFrame() {
    if (this.referenceFrame !== undefined) cancelAnimationFrame(this.referenceFrame)
    this.referenceFrame = undefined
  }

  private refreshReferences = () => {
    this.clearReferenceFrame()
    const changed: ActiveTrack[] = []
    const retargets = new Set<string>()

    for (const entry of this.active) {
      if (entry.preview || entry.reference === undefined || entry.animation.playState === 'paused')
        continue

      const next = propertyReference(
        entry.receiver.element,
        entry.track.property,
        entry.track.keyframes.at(-1)!.value,
      )

      if (next !== entry.reference) {
        changed.push(entry)
        retargets.add(layerPropertyKey(entry.track.target, entry.sourceProperty))
      }
    }

    if (retargets.size > 0) {
      try {
        if (this.presentationMode === 'live') {
          this.present(this.layerResolution, this.layerResolution, this.values, retargets)
        } else {
          // Retained live effects keep observing their relative references. Rebuild
          // only those tracks: the frozen preview owns all of its styles and handles.
          const candidates = changed.map((entry) => ({
            receiver: entry.receiver.id,
            source: {
              ...entry.track,
              sourceProperty: entry.sourceProperty,
              sourceDestination: entry.sourceDestination,
            },
            track: entry.track,
            declarations: [],
          }))
          const observations = planTrackObservations(
            candidates,
            this.presentationFacts().active.filter((entry) => !entry.preview),
            true,
          )
          // These retained tracks already own their canonical address; empty
          // declarations cannot reject them in planTrack's ownership check.
          const start = this.observeTracks(observations.requests).map((snapshot) =>
            planTrack(snapshot, trackTiming(snapshot.source, this.spring), 'both', this.spring)!,
          )

          // Live plans register playback and completion membership without changing
          // presentationMode. No restoration or writes may touch the manual preview.
          this.applyPlan(
            {
              resolution: this.layerResolution,
              mode: 'live',
              cancel: changed.map((entry) => entry.id),
              restore: false,
              preserveLifecycle: true,
              writes: [],
              start,
            },
            undefined,
            // Each retained canonical track produces one observation/plan in order.
            new Map(start.map((plan, index) => [plan.id, changed[index].animation])),
          )
        }
      } catch (error) {
        this.report({ code: 'runtime.animation', message: String(error), error })

        const operations = new Set(
          changed.flatMap((entry) => (entry.session ? [entry.session] : [])),
        )

        for (const operation of operations) operation.fail(error)
      }
    }

    this.scheduleReferences()
  }

  private scheduleReferences() {
    if (
      this.referenceFrame !== undefined ||
      !this.active.some((entry) => !entry.preview && entry.reference !== undefined)
    )
      return
    this.referenceFrame = requestAnimationFrame(this.refreshReferences)
  }

  motionChanged = () => {
    this.onLayoutChange?.()
    if (this.disposed) {
      if (this.motion.matches)
        this.present(
          this.layerResolution,
          this.layerResolution,
          this.values,
          new Set(
            this.active.map((entry) => layerPropertyKey(entry.track.target, entry.sourceProperty)),
          ),
        )

      return
    }

    this.environment?.motionChanged()
  }

  /** Shared resource reset for explicit teardown and planned motion-policy changes. */
  private clearMotionHistory(preserveControllerSnapshot = false) {
    this.clearReferenceFrame()

    if (!preserveControllerSnapshot) {
      this.setControllerPreview(false)
    }

    this.propertyMotion.reset()
    this.dirtyProperties.clear()
  }

  cancel(cancelEnter = true, preserveControllerSnapshot = false) {
    this.clearMotionHistory(preserveControllerSnapshot)

    if (cancelEnter) this.cancelEnterSessions('superseded')

    const retained = this.active.filter(
      (entry) =>
        entry.session &&
        (!cancelEnter || this.presence?.operation(entry.session)?.phase === 'leave'),
    )

    for (const entry of this.active) {
      if (!retained.includes(entry)) entry.animation.cancel()
    }

    this.active = retained
    this.pruneReceivers()

    for (const entry of retained)
      this.propertyMotion.register(
        entry.receiver.element,
        entry.track.property,
        entry.animation,
        entry.trajectory,
      )

    this.presentationMode = 'live'
    this.scheduleReferences()
  }

  write(element: HTMLElement, property: string, value: string, priority = '') {
    const write = () => {
      if (isLayoutStyleProperty(property)) changeLayoutStyleSource(element)
      if (property === 'transform') this.layout?.layoutTransform(element, undefined)

      writeOwnedStyle(this.owned, element, property, value, priority)

      const dirty = this.dirtyProperties.get(element) ?? new Set<string>()
      dirty.add(property)
      this.dirtyProperties.set(element, dirty)
    }

    if (this.layout) this.layout.writeOrdinary(element, property, write)
    else write()
  }

  flushMotionSamples(time = performance.now()) {
    const pending = new Map(this.dirtyProperties)
    this.dirtyProperties.clear()

    this.withStyleSources(
      [...pending]
        .filter(([, properties]) => [...properties].some(isLayoutStyleProperty))
        .map(([element]) => element),
      () => {
        for (const [element, properties] of pending) {
          const protectedAddresses = new Set(
            this.active
              .filter((entry) => entry.receiver.element === element)
              .flatMap((entry) => [...propertyAddresses(element, entry.track.property)]),
          )

          for (const property of properties)
            this.propertyMotion.record(element, property, time, protectedAddresses)
        }
      },
    )
  }

  restore(preserveLifecycle = false, elements?: ReadonlySet<HTMLElement>) {
    const restoreProjection = this.layout?.suspendForRestore(elements)

    const owned = this.owned.filter((entry) => !elements || elements.has(entry.element))
    const protectedValues = preserveLifecycle
      ? owned.flatMap(({ element, written }) =>
          [...written.keys()]
            .filter((property) => this.lifecycleOwns(element, property))
            .map((property) => ({
              element,
              property,
              value: element.style.getPropertyValue(property),
              priority: element.style.getPropertyPriority(property),
            })),
        )
      : []

    for (const entry of owned) {
      const { element, written } = entry
      const dirty = this.dirtyProperties.get(element) ?? new Set<string>()

      for (const property of written.keys()) dirty.add(property)

      this.dirtyProperties.set(element, dirty)
      if ([...written.keys()].some(isLayoutStyleProperty)) changeLayoutStyleSource(element)
      element.style.cssText = restoredStyle(entry, element.style.cssText).cssText
    }

    // Rebase retained ownership on the restored baseline. Retired declarations no
    // longer retain old originals when another session continues on the element.
    this.owned = this.owned.filter((entry) => !owned.includes(entry))

    for (const { element, property, value, priority } of protectedValues) {
      this.write(element, property, value, priority)
    }

    restoreProjection?.()
  }

  bind(entries: readonly (readonly [string, HTMLElement])[]) {
    if (this.disposed) return

    const next = new Map<string, TargetElements>()

    for (const [name, element] of entries) {
      const elements = next.get(name)

      if (elements) {
        elements.push(element)
      } else {
        next.set(name, [element])
      }
    }

    const duplicate = next.size !== entries.length && !this.presence?.supports(this.definition)
    const status = this.resolveBindingStatus(this.definition, next, duplicate)
    const unchanged =
      status === 'ready' &&
      !this.suspended &&
      entries.length === [...this.targetReceivers.values()].flat().length &&
      entries.every(([key, value]) =>
        this.targetReceivers.get(key)?.some((receiver) => receiver.element === value),
      )

    if (unchanged) return

    this.releaseLayout()
    this.endCompositionPreview()
    this.environment?.invalidateBinding()

    const previousInputs = JSON.stringify(this.values)

    this.releaseControllers()
    this.environment?.clearBindings()
    this.propertyMotion.reset()
    this.dirtyProperties.clear()
    this.cancel(false)
    this.restore(this.presence?.hasOperations === true)
    this.replaceReceivers(next)

    this.bindingStatus = status
    this.onLayoutChange?.()

    this.environment?.rebound(previousInputs !== JSON.stringify(this.values))

    if (this.suspended) {
      this.report({
        code: 'runtime.targets',
        message: status === 'duplicate' ? 'Duplicate target binding' : 'Missing target binding',
      })
    } else {
      this.environment?.reconcile()
    }
  }

  applyWrites(writes: readonly StyleWrite[]) {
    for (const write of writes)
      this.write(this.receiver(write.receiver).element, write.property, write.value)
  }

  applyPlan(
    plan: PresentationPlan,
    accept?: () => void,
    /** Existing live handles preserve native composite order below a frozen preview. */
    retainedAnimations?: ReadonlyMap<number, Animation>,
  ) {
    const prepared: ActiveTrack[] = []

    try {
      for (const track of plan.start)
        prepared.push(
          this.prepareEffect(track, this.receiver(track.receiver), plan.mode === 'preview'),
        )
    } catch (error) {
      for (const entry of prepared) entry.animation.cancel()

      throw error
    }

    accept?.()

    if (plan.resetMotion) {
      this.clearMotionHistory()
      this.presentationMode = 'live'
    }

    const cancelled = new Set(plan.cancel)
    const replaced = this.active.filter((entry) => cancelled.has(entry.id))
    this.active = this.active.filter((entry) => !cancelled.has(entry.id))

    if (plan.mode === 'live') {
      this.layerResolution = plan.resolution
      this.layout?.advanceRevision()

      if (!this.disposed) this.environment?.acceptPresentation(plan.resolution)
    }

    this.layout?.presentationChanged()

    const groups = new Set(
      [...replaced, ...prepared].flatMap((entry) => (entry.session ? [entry.session] : [])),
    )

    for (const session of groups) {
      this.presence?.replaceEffects(session, replaced, prepared)
    }

    for (const entry of replaced) entry.animation.cancel()

    for (const entry of prepared) {
      const retained = retainedAnimations?.get(entry.id)

      if (!retained) continue

      // Animation creation order controls native compositing. Keep the retained
      // live handle below the existing paused preview, while replacing its effect
      // and completion ID through the same prepared plan as ordinary retargeting.
      const preparedAnimation = entry.animation

      retained.effect = preparedAnimation.effect
      retained.playbackRate = preparedAnimation.playbackRate
      preparedAnimation.cancel()
      entry.animation = retained
    }

    if (plan.restore) this.restore(plan.preserveLifecycle)

    this.applyWrites(plan.writes)

    if (plan.mode === 'maintenance') return

    if (plan.mode === 'preview') {
      this.active.push(...prepared)
      this.presentationMode = 'preview'

      for (const entry of prepared) {
        entry.animation.pause()
        entry.animation.currentTime = 0

        // A paused preview remains an ordinary paint source for opted-in
        // descendants in other Motion roots. Its native clock changes on seek;
        // registering that clock avoids caching an inherited intermediate value.
        if (isLayoutStyleProperty(entry.track.property))
          trackLayoutStyleSource(entry.receiver.element, entry.animation)
      }

      return
    }

    this.active.push(...prepared)
    this.flushMotionSamples()

    for (const entry of prepared) {
      entry.animation.play()
      trackLayoutAnimation(entry.receiver.element, entry.track.property, entry.animation)
      this.propertyMotion.register(
        entry.receiver.element,
        entry.track.property,
        entry.animation,
        entry.trajectory,
      )
      void entry.animation.finished
        .then(
          () => {
            if (!this.active.includes(entry)) return undefined

            if (
              entry.reference !== undefined &&
              propertyReference(
                entry.receiver.element,
                entry.track.property,
                entry.track.keyframes.at(-1)!.value,
              ) !== entry.reference
            ) {
              this.refreshReferences()

              return undefined
            }

            if (entry.session) {
              entry.session.completion.replace([entry.id], [])

              return undefined
            }

            const presence = this.presenceLayers(
              this.layerResolution,
              this.values,
              this.enterExclusions(this.layerResolution, this.layerResolution),
            )
            const resolution = this.project(this.layerResolution, entry.receiver.id, presence)
            const facts = this.presentationFacts()
            const completion = planEffectCompletion(resolution, facts, entry.id)

            // This current effect was checked above; no callbacks intervene before planning.
            this.applyPlan({ ...completion!, mode: 'maintenance' })
            this.propertyMotion.beginControl(
              entry.receiver.element,
              entry.track.property,
              performance.now(),
            )

            return undefined
          },
          (error) => {
            if (!this.active.includes(entry)) return undefined

            if (entry.session) {
              entry.session.fail(error)

              return undefined
            }

            this.active = this.active.filter((item) => item !== entry)
            this.report({ code: 'runtime.animation', message: String(error), error })

            return undefined
          },
        )
        // Reconciliation may already have removed the effect before a write fails.
        // Such failures must be reported independently of expected cancellation.
        .catch((error) => {
          if (entry.session && !entry.session.isFinished) entry.session.fail(error)
          else this.report({ code: 'runtime.animation', message: String(error), error })
        })
    }
    this.layout?.refreshPaintSources(prepared)
    this.scheduleReferences()
  }

  dispose() {
    // Runtime disposal is terminal even if a browser cleanup fails. Invalidate
    // callbacks first; detached leave retains its accepted data and normal lifetime.
    this.disposed = true

    releaseResources([
      () => this.releaseLayout(),
      () => this.onLayoutChange?.(),
      () => this.releaseControllers(),
      () => this.cancelEnterSessions('owner-teardown'),
      () => this.disconnectBindings(),
      () => {
        const leave = this.active.filter(
          (entry) => entry.session && this.presence?.operation(entry.session)?.phase === 'leave',
        )
        const ending = this.active.filter((entry) => !leave.includes(entry))

        // Native cancellation may notify synchronously. Retire live entries before
        // attempting it, while retaining failed handles for a later Executor retry.
        this.active = leave
        const pending = [...this.disposalAnimations]
        for (const entry of ending) this.disposalAnimations.add(entry.animation)

        const cancel = (animation: Animation) => () => {
          animation.cancel()
          this.disposalAnimations.delete(animation)
        }

        releaseResources([
          ...ending.flatMap((entry) => [() => this.retainMotion(entry), cancel(entry.animation)]),
          ...pending.map(cancel),
        ])
      },
      () => {
        this.presentationMode = 'live'
        // Final restoration must not replay a projection whose release failed.
        // Each inline owner is independent, so one CSSOM failure cannot skip the
        // remaining receivers. Failed entries stay retained for an Executor retry.
        releaseResources(
          this.owned.map(
            ({ element }) =>
              () =>
                this.restore(this.presence?.hasOperations === true, new Set([element])),
          ),
        )
      },
      () => {
        this.controllers?.clear()
        this.dirtyProperties.clear()
        this.targetReceivers.clear()
        this.pruneReceivers()
        // Detached execution retains accepted data, never Runtime callbacks.
        this.environment = undefined
      },
      () => {
        if (!this.presence?.hasOperations) {
          releaseResources([
            () => this.clearReferenceFrame(),
            () => {
              if (this.attached) this.motion.removeEventListener('change', this.motionChanged)
            },
            () => this.receivers.clear(),
          ])
        }
      },
    ])
  }
}
