import { materializeEffect } from './native-effect.ts'
import { layerPropertyKey, layerPropertyMatchesTarget } from '../model/presentation.ts'
import {
  prepareLayerChange,
  planDeclarationTakeovers,
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
  ControllerBinding,
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
import { propertyRule } from '../motion/property-rules.ts'
import { propertyController, type PropertyController } from '../motion/controllers.ts'
import {
  layerTargets,
  composeEvaluatedLayers,
  changedLayerProperties,
  type EvaluatedLayer,
  type LayerResolution,
} from '../composition/layers.ts'
export { waapiProperty } from '../motion/animation.ts'
import { isReactiveSubscription, type SourceConnection } from '../evaluation/reactive-value.ts'
import { evaluate, type VariableValues } from '../evaluation/expression.ts'
import type { Definition } from '../model/definition.ts'
import { type ResolvedTrack } from '../composition/resolve.ts'
import {
  resolveLifecycle,
  evaluateLifecycleTrack,
  type LifecycleWork,
  type LifecycleResult,
  captureLifecycleDefinition,
  hasLifecycle,
  type LifecycleSession,
} from './lifecycle.ts'
import { trackLayoutAnimation } from '../layout/layout-scheduler.ts'
import { PropertyMotion, type MotionSample } from '../motion/property-motion.ts'

type InlineValue = { value: string; priority: string }
type OwnedElement = {
  element: HTMLElement
  original: Map<string, InlineValue>
  originalCss: string
  pending: Map<string, { property: string; value: string; priority: string }>
  written: Map<string, InlineValue>
}

function inlineDeclarations(style: CSSStyleDeclaration): Map<string, InlineValue> {
  return new Map(
    Array.from(style).map((property) => [
      property,
      {
        value: style.getPropertyValue(property),
        priority: style.getPropertyPriority(property),
      },
    ]),
  )
}

/** Calculates the released baseline while preserving external CSS edits and serialization. */
function restoredStyle(
  { original, originalCss, pending, written }: OwnedElement,
  cssText: string,
): CSSStyleDeclaration {
  const baseline = document.createElement('div')
  const external = document.createElement('div')

  baseline.style.cssText = originalCss
  external.style.cssText = cssText

  const current = inlineDeclarations(external.style)
  // Removing a longhand can change the CSSOM serialization of a shorthand.
  // Compare every pending signature before pruning any declaration.
  const changedPending = new Set(
    [...pending]
      .filter(
        ([, signature]) =>
          external.style.getPropertyValue(signature.property) !== signature.value ||
          external.style.getPropertyPriority(signature.property) !== signature.priority,
      )
      .map(([property]) => property),
  )
  const stillOwned = new Set<string>()

  for (const [property, last] of written) {
    const value = current.get(property) ?? { value: '', priority: '' }

    if (
      !changedPending.has(property) &&
      value.value === last.value &&
      value.priority === last.priority
    ) {
      stillOwned.add(property)
      external.style.removeProperty(property)
    }
  }

  for (const property of original.keys()) {
    if (!stillOwned.has(property) && !current.has(property)) {
      baseline.style.removeProperty(property)
    }
  }

  for (const property of Array.from(external.style)) {
    baseline.style.removeProperty(property)
  }

  // Restore the intact original serialization, then overlay external writes.
  // This retains var()-valued shorthands that CSSOM cannot expose as longhands.
  baseline.style.cssText += ';' + external.style.cssText

  return baseline.style
}

let nextEffectId = 0

/** One physical receiver shared by every logical target alias in the current binding. */
type Receiver = {
  readonly id: number
  readonly element: HTMLElement
}

/** Canonical components belong to one receiver's writing context and logical target. */
function receiverPropertyKey(receiver: number, target: string, property: string): string {
  return layerPropertyKey(layerPropertyKey(String(receiver), target), property)
}

type ActiveTrack = {
  id: number
  receiver: Receiver
  track: ResolvedTrack
  animation: Animation
  sourceProperty: string
  sourceDestination: string
  reference?: string
  trajectory?: (milliseconds: number) => MotionSample
  session?: LifecycleSession
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

/** Configured instances remain registered while another controller/declaration owns their address. */
type ControllerState = {
  /** Logical target/property identity used to compare selected owners. */
  readonly key: string

  /** Selected for live control, including controllers currently using an unreadable-value fallback. */
  active: boolean
}

/** A scoped evaluated layer and its completion lifetime; native effects remain in active. */
type PresenceOperation = {
  readonly id: number
  readonly initialized: boolean
  readonly phase: 'enter' | 'leave'
  readonly session: LifecycleSession
  readonly work: readonly LifecycleWork[]
  /** One receiver/target binding for each work item, in the same order. */
  readonly receivers: readonly { readonly receiver: Receiver; readonly target: string }[]
  readonly interrupted: Set<string>
  playing: boolean
}

const emptyResolution = (): LayerResolution => ({
  composition: { layers: {}, states: {} },
  states: new Map(),
  transitions: new Map(),
  presentation: { name: '@layers', targets: [] },
})

export class PresentationExecutor {
  private layerResolution: LayerResolution = emptyResolution()
  private readonly operations = new Map<LifecycleSession, PresenceOperation>()
  private readonly presented = new Map<string, LayerResolution>()
  private readonly captureEnvironments = new WeakMap<Definition, { values: VariableValues }>()
  private frozen?: { readonly definition: Definition; readonly values: VariableValues }
  private standalone = false
  private environment?: ExecutionEnvironment
  private readonly sourceCleanups = new Set<() => void>()

  get definition() {
    if (this.frozen) return this.frozen.definition

    /* v8 ignore if -- @preserve: The facade attaches before binding; standalone and detached execution install frozen data before requesting definition or values. */
    if (!this.environment) throw new Error('Presentation executor is not attached')

    return this.environment.definition()
  }

  private get values() {
    if (this.frozen) return this.frozen.values

    /* v8 ignore if -- @preserve: The facade attaches before binding; standalone and detached execution install frozen data before requesting definition or values. */
    if (!this.environment) throw new Error('Presentation executor is not attached')

    return this.environment.values()
  }

  freezeEnvironment(detaching = false) {
    const definition = this.definition
    const values = this.values
    const captured = this.captureEnvironments.get(definition)

    if (captured) captured.values = values

    if (detaching) this.frozen = { definition, values }
  }

  attach(environment: ExecutionEnvironment) {
    this.environment = environment
    this.motion = matchMedia('(prefers-reduced-motion: reduce)')
    this.motion.addEventListener('change', this.motionChanged)
  }

  initialize(resolution: LayerResolution) {
    this.layerResolution = resolution
  }

  get bindingFacts(): BindingFacts {
    return {
      suspended: this.suspended,
    }
  }

  private nextReceiverId = 0
  private readonly receivers = new Map<number, Receiver>()

  private receiver(id: number): Receiver {
    // Requests/plans are synchronous and use IDs supplied for the current binding.
    return this.receivers.get(id)!
  }

  /** Replaces both binding indexes; the element lookup exists only during registration. */
  private replaceReceivers(targets: ReadonlyMap<string, TargetElements>) {
    const retained = [...this.operations.values()].flatMap((operation) =>
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
  private pruneReceivers() {
    const retained = new Set([
      ...[...this.targetReceivers.values()].flat().map((receiver) => receiver.id),
      ...[...this.operations.values()].flatMap((operation) =>
        operation.receivers.map(({ receiver }) => receiver.id),
      ),
      ...this.active.map((entry) => entry.receiver.id),
    ])

    for (const [id, receiver] of this.receivers) {
      if (retained.has(id)) continue

      this.receivers.delete(id)

      // Preview restoration still owns its saved inline baseline until preview
      // teardown. Live terminal failures have no later owner to retry that work.
      if (this.presentationMode === 'live') {
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

  private readonly targetReceivers = new Map<string, TargetReceivers>()
  private active: ActiveTrack[] = []
  private readonly propertyMotion = new PropertyMotion()
  private readonly dirtyProperties = new Map<HTMLElement, Set<string>>()
  private referenceFrame?: number
  private readonly controllers = new Map<PropertyController, ControllerState>()
  private nextLifecycleId = 0
  private owned: OwnedElement[] = []
  private presentationMode: PresentationMode = 'live'
  private bindingStatus: BindingStatus = 'unbound'
  private disposed = false
  private motion!: MediaQueryList
  private readonly report: (diagnostic: RuntimeDiagnostic) => void

  constructor(report: (diagnostic: RuntimeDiagnostic) => void) {
    this.report = report
  }

  private get suspended() {
    return this.bindingStatus !== 'ready'
  }

  disconnectBindings() {
    const cleanups = [...this.sourceCleanups]
    this.sourceCleanups.clear()

    for (const cleanup of cleanups) cleanup()
  }

  readonly connectSource: SourceConnection = (source, publish) => {
    if (!isReactiveSubscription(source)) throw new Error('Source has no browser adapter')

    const cleanup = source.bind(new Map(this.representativeTargets()), publish)
    let connected = true
    const disconnect = () => {
      if (!connected) return

      connected = false
      this.sourceCleanups.delete(disconnect)
      cleanup()
    }

    this.sourceCleanups.add(disconnect)

    return disconnect
  };

  /**
   * Single-receiver consumers use the last entry, matching Map construction from bind entries.
   * @yields Logical target names paired with their last accepted receiving element.
   */
  private *representativeTargets() {
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

  terminalControls(time: number) {
    const controlled = [...this.controllers]
      .filter(([, state]) => state.active)
      .map(([controller]) => controller.control())

    for (const value of controlled) {
      if (value) this.write(value.element, value.property, value.value)
    }

    this.flushMotionSamples(time)
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
    if (hasLifecycle(definition)) return 'ready'

    const optional = this.optionalControllerTargets(definition)
    const missing = layerTargets(definition).some(
      (target) =>
        target.properties.length > 0 && !optional.has(target.name) && !targets.has(target.name),
    )

    return missing ? 'missing' : 'ready'
  }

  /** Registers compatibility completion and reports settlement without choosing presentation policy. */
  retainLifecycle(phase: 'enter' | 'leave', session: LifecycleSession) {
    if (session.isFinished || this.operations.has(session)) return

    const id = this.nextLifecycleId++

    this.operations.set(session, {
      id,
      initialized: false,
      phase,
      session,
      work: [],
      receivers: [],
      interrupted: new Set(),
      playing: false,
    })

    void session.finished
      .then((result) => {
        // Removed registrations cannot publish stale completion after cancellation or teardown.
        if (this.operations.get(session)?.id !== id) return undefined

        // Empty or externally owned work may never register this executor as a
        // playback participant. Its retained lifetime still ends after disposal.
        if (this.disposed || this.standalone) this.endLifecycle(session, result)
        else this.environment?.lifecycleSettled()

        return undefined
      })
      .catch((error) => this.report({ code: 'runtime.animation', message: String(error), error }))
  }

  captureLifecycle(phase: 'enter' | 'leave', names: readonly string[], element?: HTMLElement) {
    const definition = this.definition
    const targets = new Map(
      [...this.representativeTargets()]
        .filter(([name]) => names.includes(name))
        .map(([name, target]) => [name, element ?? target]),
    )
    const work = resolveLifecycle(
      phase,
      captureLifecycleDefinition(definition, phase, this.values),
      this.layerResolution.presentation,
      targets,
    )

    const environment = this.captureEnvironments.get(definition) ?? { values: this.values }

    environment.values = this.values
    this.captureEnvironments.set(definition, environment)

    return work.map((item) => ({
      ...item,
      playback: this,
      capture: { definition, environment, track: item.track },
      restoreOnCompletion: phase === 'enter',
    }))
  }

  /** Ordinary takeover is calculated without mutating accepted operation ownership. */
  private enterExclusions(previous: LayerResolution, next: LayerResolution) {
    const before = previous.declarations ?? previous.presentation
    const after = next.declarations ?? next.presentation
    const takeovers = new Map<string, readonly string[]>()

    return [...this.operations.values()].map((operation) => {
      const excluded = new Set(operation.interrupted)

      if (operation.phase === 'enter' && operation.playing) {
        for (const { receiver, target } of operation.receivers) {
          const key = layerPropertyKey(String(receiver.id), target)
          let changed = takeovers.get(key)

          if (!changed) {
            const names = new Set(
              [before, after].flatMap((presentation) =>
                presentation.targets
                  .filter((item) => item.name === target)
                  .flatMap((item) => item.properties.map((property) => property.name)),
              ),
            )
            const addresses = [...names].map((name) => ({
              name,
              addresses: propertyAddresses(receiver.element, name),
            }))

            changed = planDeclarationTakeovers(previous, next, target, addresses)
            takeovers.set(key, changed)
          }

          for (const address of changed)
            excluded.add(receiverPropertyKey(receiver.id, target, address))
        }
      }

      return { operation, excluded }
    })
  }

  /** Converts selected presence declarations to ordinary evaluated cascade inputs. */
  private presenceLayers(
    resolution: LayerResolution,
    values: VariableValues,
    exclusions: readonly {
      readonly operation: PresenceOperation
      readonly excluded: ReadonlySet<string>
    }[],
    expand = true,
  ): EvaluatedLayer[] {
    return exclusions.flatMap(({ operation, excluded }) =>
      operation.work.flatMap((item, index): EvaluatedLayer[] => {
        const { track, capture } = item
        const binding = operation.receivers[index]
        const addresses = propertyAddresses(binding.receiver.element, track.property)

        if (
          addresses.every((address) =>
            excluded.has(receiverPropertyKey(binding.receiver.id, track.target, address)),
          )
        )
          return []

        const rendered = evaluateLifecycleTrack(
          operation.phase,
          capture?.definition[operation.phase],
          resolution.presentation,
          capture?.definition === this.definition
            ? values
            : (capture?.environment.values ?? values),
          track,
          capture !== undefined && track.keyframes !== capture.track.keyframes,
        )
        const components = expand ? canonicalTracks(binding.receiver.element, rendered) : [rendered]

        return components.flatMap((component): EvaluatedLayer[] => {
          if (
            propertyAddresses(binding.receiver.element, component.property).every((address) =>
              excluded.has(receiverPropertyKey(binding.receiver.id, component.target, address)),
            )
          )
            return []

          const owner = `@presence:${operation.id}:${index}`

          return [
            {
              id: owner,
              scope: [binding.receiver.id],
              targets: [
                {
                  name: component.target,
                  properties: [
                    {
                      name: component.property,
                      owner,
                      sourceProperty: rendered.property,
                      sourceDestination: rendered.destinationValue,
                      value: component.destinationValue,
                      timing: component.timing,
                      keyframes: component.implicitStart
                        ? component.keyframes.slice(1)
                        : component.keyframes,
                    },
                  ],
                },
              ],
            },
          ]
        })
      }),
    )
  }

  validatePresence(previous: LayerResolution, next: LayerResolution, values: VariableValues) {
    this.presenceLayers(next, values, this.enterExclusions(previous, next), false)
  }

  /** Controller outputs are already accepted in presentation; retain their observation phase. */
  private project(
    resolution: LayerResolution,
    receiver: number,
    presence: readonly EvaluatedLayer[],
  ): LayerResolution {
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
    const facts = this.presentationFacts(next)
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

      const timings = new Map(change.tracks.map((source) => [source, trackTiming(source)]))
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
        planTrack(snapshot, timings.get(snapshot.source)!, 'both')!,
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

  /** Registers compatibility work before its first paint, without owning effects in the session. */
  initializeLifecycle(
    session: LifecycleSession,
    phase: 'enter' | 'leave',
    work: readonly LifecycleWork[],
  ) {
    this.retainLifecycle(phase, session)

    if (!this.environment && !this.disposed) {
      this.standalone = true

      const definition: Definition = { name: '@standalone', layers: [] }

      this.frozen = { definition, values: {} }
      this.motion = matchMedia('(prefers-reduced-motion: reduce)')
      this.motion.addEventListener('change', this.motionChanged)
      this.bindingStatus = 'ready'
      this.layerResolution = {
        ...emptyResolution(),
        presentation: {
          name: '@standalone',
          targets: work.map(({ element, track }) => ({
            name: track.target,
            properties: [
              {
                name: track.property,
                owner: '@standalone',
                value:
                  phase === 'enter'
                    ? track.destinationValue
                    : element.style.getPropertyValue(track.property),
              },
            ],
          })),
        },
      }
    }

    if (this.disposed) this.motion.addEventListener('change', this.motionChanged)

    const receivers = work.map(({ element, track }) => {
      let receiver = [...this.receivers.values()].find((item) => item.element === element)

      if (!receiver) {
        receiver = { id: this.nextReceiverId++, element }
        this.receivers.set(receiver.id, receiver)
      }

      return { receiver, target: track.target }
    })
    const operation: PresenceOperation = {
      // retainLifecycle registered this session immediately above.
      id: this.operations.get(session)!.id,
      initialized: true,
      phase,
      session,
      work,
      receivers,
      interrupted: new Set(),
      playing: false,
    }

    this.operations.set(session, operation)

    if (!this.disposed && !this.standalone) this.environment?.refreshOwnership()

    for (const item of work) {
      const { element, track, capture } = item
      const rendered = evaluateLifecycleTrack(
        phase,
        capture?.definition[phase],
        this.layerResolution.presentation,
        capture?.definition === this.definition
          ? this.values
          : (capture?.environment.values ?? this.values),
        track,
        capture !== undefined && track.keyframes !== capture.track.keyframes,
      )

      this.write(element, track.property, rendered.keyframes[0].value)
    }
  }

  playLifecycle(session: LifecycleSession) {
    // LifecycleSession invokes playback only after this participant initialized successfully.
    const operation = this.operations.get(session)!

    operation.playing = true
    this.present(this.layerResolution, this.layerResolution, this.values)
  }

  /** Capture a running effect before cancellation; this preserves its displayed derivative. */
  private retainMotion(entry: ActiveTrack) {
    const time = performance.now()
    const sample = this.propertyMotion.read(entry.receiver.element, entry.track.property, time)

    if (sample)
      this.propertyMotion.endControl(
        entry.receiver.element,
        entry.track.property,
        sample.velocity,
        time,
      )
  }

  private sessionFor(receiver: number, property: string): LifecycleSession | undefined {
    return [...this.operations.values()].findLast((operation) =>
      operation.receivers.some(
        (binding, index) =>
          binding.receiver.id === receiver &&
          (operation.work[index].track.property === property ||
            propertyAddresses(
              binding.receiver.element,
              operation.work[index].track.property,
            ).includes(property)),
      ),
    )?.session
  }

  endLifecycle(session: LifecycleSession, result: LifecycleResult) {
    const operation = this.operations.get(session)

    // A sibling can fail before this participant has begun initialization.
    if (!operation) return

    const effects = this.active.filter((entry) => entry.session === session)

    try {
      this.operations.delete(session)

      const previous = this.layerResolution
      const elements = new Set(operation.receivers.map(({ receiver }) => receiver.element))

      if (!this.disposed && !this.standalone && this.presentationMode === 'live')
        this.environment?.refreshOwnership()

      const cancelled = this.active.filter((entry) => entry.session === session)

      this.active = this.active.filter((entry) => entry.session !== session)

      for (const entry of cancelled) {
        this.retainMotion(entry)
        entry.animation.cancel()
      }

      if (this.presentationMode !== 'live') return

      this.restore(this.operations.size > 0, elements)

      const facts = this.presentationFacts(this.layerResolution)
      const changed = changedLayerProperties(previous, this.layerResolution)
      const presence = this.presenceLayers(
        this.layerResolution,
        this.values,
        this.enterExclusions(this.layerResolution, this.layerResolution),
      )

      if (this.standalone) {
        if (result === 'completed' && operation.phase === 'enter') {
          for (const item of operation.work) {
            if (!item.restoreOnCompletion)
              item.element.style.setProperty(item.track.property, item.track.destinationValue)
          }
        }
      } else if (!this.disposed) {
        for (const receiver of facts.receivers) {
          if (
            !elements.has(this.receiver(receiver.id).element) &&
            ![...changed].some((key) => layerPropertyMatchesTarget(key, receiver.target))
          )
            continue

          this.applyWrites(
            presentationWrites(this.project(this.layerResolution, receiver.id, presence), [
              receiver,
            ]),
          )
        }
      }

      // Restoration is a temporary ownership change, not a fresh input sample.
      // Keep the outgoing trajectory derivative available to immediate re-entry.
      for (const element of elements) this.dirtyProperties.delete(element)
    } finally {
      this.active = this.active.filter((entry) => entry.session !== session)

      for (const entry of effects) entry.animation.cancel()

      for (const { receiver, target } of operation.receivers)
        this.presented.delete(layerPropertyKey(String(receiver.id), target))

      this.pruneReceivers()

      if ((this.disposed || this.standalone) && this.operations.size === 0) {
        this.clearReferenceFrame()
        this.motion.removeEventListener('change', this.motionChanged)
        this.targetReceivers.clear()
        this.receivers.clear()
      }
    }
  }

  releaseLifecycle(names: readonly string[], element: HTMLElement, properties?: readonly string[]) {
    const interrupted = this.active.filter(
      (entry) =>
        names.includes(entry.track.target) &&
        entry.receiver.element === element &&
        (properties === undefined || properties.includes(entry.track.property)),
    )
    this.active = this.active.filter((entry) => !interrupted.includes(entry))

    for (const entry of interrupted) {
      this.retainMotion(entry)
      entry.animation.cancel()
    }
  }

  get animations(): readonly Animation[] {
    return this.active
      .filter((entry) => this.presentationMode !== 'preview' || entry.preview)
      .map((entry) => entry.animation)
  }

  configureControllers(definition: Definition, values: VariableValues) {
    this.controllers.clear()

    for (const target of layerTargets(definition)) {
      for (const property of target.properties) {
        if (property.value.kind !== 'binding') continue

        const controller = propertyController(evaluate(property.value.expression, values))
        this.controllers.set(controller, {
          key: layerPropertyKey(target.name, property.name),
          active: false,
        })
        controller.configure({
          target: target.name,
          property: property.name,
          motion: this.propertyMotion,
          report: (message) => this.report({ code: 'runtime.controller', message }),
        })
      }
    }
  }

  private optionalControllerTargets(definition: Definition): ReadonlySet<string> {
    return new Set(
      layerTargets(definition)
        .filter((target) => target.properties.some((property) => property.value.kind === 'binding'))
        .map((target) => target.name),
    )
  }

  releaseControllers(time = performance.now()) {
    for (const [controller, state] of this.controllers) {
      if (!state.active) continue

      controller.release(time)
      state.active = false
    }
  }

  /** Metadata has no live style values; Runtime chooses which CSS observations follow. */
  presentationFacts(resolution: LayerResolution): PresentationFacts {
    const receivers = [...this.targetReceivers].flatMap(([target, bindings]) =>
      bindings.map((receiver) => ({ id: receiver.id, target })),
    )

    for (const operation of this.operations.values()) {
      for (const { receiver, target } of operation.receivers) {
        if (!receivers.some((item) => item.id === receiver.id && item.target === target))
          receivers.push({ id: receiver.id, target })
      }
    }

    const lifecycle = [...this.operations.values()].map(({ id, phase, session, initialized }) => ({
      id,
      phase,
      finished: session.isFinished,
      protected: initialized
        ? []
        : receivers.flatMap((receiver) => {
            const element = this.receiver(receiver.id).element

            return resolution.presentation.targets
              .filter((target) => target.name === receiver.target)
              .flatMap((target) =>
                target.properties
                  .filter((property) => session.owns(element, property.name))
                  .map((property) => ({ receiver: receiver.id, property: property.name })),
              )
          }),
    }))

    return {
      mode: this.presentationMode,
      lifecycle,
      suspended: this.suspended,
      reduced: this.motion.matches,
      preserveLifecycle: lifecycle.length > 0,
      receivers: receivers.map((receiver) => ({
        ...receiver,
        protected: lifecycle.flatMap((session) =>
          session.protected
            .filter((address) => address.receiver === receiver.id)
            .map((address) => address.property),
        ),
      })),
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

  observeReceivers(
    resolution: LayerResolution,
    targets: ReadonlySet<string>,
    live: boolean,
  ): readonly ReceiverAddresses[] {
    const receivers = this.presentationFacts(resolution).receivers
    const presence = live
      ? this.presenceLayers(
          resolution,
          this.values,
          this.enterExclusions(this.layerResolution, resolution),
        )
      : []

    return resolution.presentation.targets
      .filter((target) => targets.has(target.name))
      .flatMap((target) => {
        return receivers
          .filter((receiver) => receiver.target === target.name)
          .map((receiver) => {
            const element = this.receiver(receiver.id).element
            // Composing scoped overrides retains every ordinary target/name.
            const properties = this.project(
              resolution,
              receiver.id,
              presence,
            ).presentation.targets.find((item) => item.name === target.name)!.properties

            const addresses = properties.map(({ name }) => ({
              name,
              addresses: propertyAddresses(element, name),
            }))
            const scoped = new Set(
              properties
                .filter((property) => property.sourceProperty !== undefined)
                .map((property) => property.name),
            )
            const fallbacks = target.properties
              .filter(
                (property) =>
                  property.binding &&
                  addresses.some(
                    (declaration) =>
                      scoped.has(declaration.name) &&
                      declaration.addresses.some((address) =>
                        addresses
                          .find((candidate) => candidate.name === property.name)
                          ?.addresses.includes(address),
                      ),
                  ),
              )
              .map((property) => property.name)

            return {
              ...receiver,
              bindings: properties
                .filter((property) => property.binding)
                .map((property) => property.name),
              fallbacks,
              addresses,
            }
          })
      })
  }

  /** Runtime passes only selected bindings; capability objects remain within existing controller APIs. */
  applyControllers(
    bindings: readonly ControllerBinding[],
    values: VariableValues,
    time: number,
    live: boolean,
  ): ReadonlyMap<string, string | undefined> {
    const nextOwners = new Map<string, PropertyController>()
    const outputs = new Map<string, string | undefined>()

    for (const binding of bindings) {
      const snapshot = evaluate(binding.expression, values)
      const controller = propertyController(snapshot)
      const key = layerPropertyKey(binding.target, binding.property)
      nextOwners.set(key, controller)

      if (live) controller.acquire(time)

      outputs.set(
        key,
        live ? controller.control()?.value : controller.render(binding.property, snapshot),
      )
    }

    if (live) {
      for (const [controller, state] of this.controllers) {
        const selected = nextOwners.get(state.key) === controller

        if (state.active && !selected) controller.release(time)

        state.active = selected
      }
    }

    return outputs
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
        protected: [...this.operations.values()].some(
          ({ session, initialized }) => !initialized && session.owns(element, track.property),
        ),
      }))
    })
  }

  observeDisplayed(requests: readonly DisplayedRequest[]): readonly DisplayedValue[] {
    const styles = new Map<number, CSSStyleDeclaration>()

    return requests.map((request) => {
      let style = styles.get(request.receiver)

      if (!style) {
        style = getComputedStyle(this.receiver(request.receiver).element)
        styles.set(request.receiver, style)
      }

      return { ...request, value: style.getPropertyValue(request.property) }
    })
  }

  observeTracks(requests: readonly TrackObservationRequest[]): readonly TrackSnapshot[] {
    return requests.map((request) => {
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
    })
  }

  private clearReferenceFrame() {
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
            protected: false,
          }))
          const observations = planTrackObservations(
            candidates,
            this.presentationFacts(this.layerResolution).active.filter((entry) => !entry.preview),
            true,
          )
          // These retained tracks already own their canonical address; empty
          // declarations cannot reject them in planTrack's ownership check.
          const start = this.observeTracks(observations.requests).map((snapshot) =>
            planTrack(snapshot, trackTiming(snapshot.source), 'both')!,
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

  private motionChanged = () => {
    if (this.disposed || this.standalone) {
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

  /** Detaches registrations before cancellation so queued completion cannot publish stale work. */
  private cancelEnterSessions(reason: 'superseded' | 'owner-teardown') {
    const sessions = [...this.operations.values()].filter((entry) => entry.phase === 'enter')

    for (const { session } of sessions) {
      session.cancel(reason)
      this.operations.delete(session)
    }
  }

  /** Shared resource reset for explicit teardown and planned motion-policy changes. */
  private clearMotionHistory(preserveControllerSnapshot = false) {
    this.clearReferenceFrame()

    if (!preserveControllerSnapshot) {
      for (const controller of this.controllers.keys()) controller.setPreview(false)
    }

    this.propertyMotion.reset()
    this.dirtyProperties.clear()
  }

  private cancel(cancelEnter = true, preserveControllerSnapshot = false) {
    this.clearMotionHistory(preserveControllerSnapshot)

    if (cancelEnter) this.cancelEnterSessions('superseded')

    const retained = this.active.filter(
      (entry) =>
        entry.session && (!cancelEnter || this.operations.get(entry.session)?.phase === 'leave'),
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

  private write(element: HTMLElement, property: string, value: string, priority = '') {
    const before = inlineDeclarations(element.style)
    let owned = this.owned.find((o) => o.element === element)

    if (!owned) {
      owned = {
        element,
        original: before,
        originalCss: element.style.cssText,
        pending: new Map(),
        written: new Map(),
      }
      this.owned.push(owned)
    }

    const beforeCss = element.style.cssText
    if (propertyRule(property)?.kind === 'length') {
      // Keep CSS logical/physical aliases in the same order as the resolved cascade.
      element.style.removeProperty(property)
    }

    element.style.setProperty(property, value, priority)

    const after = inlineDeclarations(element.style)

    const pending = document.createElement('div')
    if (beforeCss !== element.style.cssText) {
      pending.style.setProperty(property, value)
    }
    const pendingNames = new Set(
      Array.from(pending.style).filter((name) => pending.style.getPropertyValue(name) === ''),
    )

    let rebased = false

    // CSSOM enumerates the affected longhands, including shorthand side effects.
    for (const name of new Set([...before.keys(), ...after.keys()])) {
      const previous = before.get(name)
      const next = after.get(name)

      if (
        pendingNames.has(name) ||
        previous?.value !== next?.value ||
        previous?.priority !== next?.priority
      ) {
        const last = owned.written.get(name)
        const previousValue = previous ?? { value: '', priority: '' }

        if (
          !rebased &&
          (!last || last.value !== previousValue.value || last.priority !== previousValue.priority)
        ) {
          const baseline = restoredStyle(owned, beforeCss)

          owned.originalCss = baseline.cssText
          owned.original = inlineDeclarations(baseline)
          rebased = true
        }

        owned.written.set(name, next ?? { value: '', priority: '' })

        if (pendingNames.has(name)) {
          owned.pending.set(name, {
            property,
            value: element.style.getPropertyValue(property),
            priority: element.style.getPropertyPriority(property),
          })
        } else {
          owned.pending.delete(name)
        }
      }
    }
    const dirty = this.dirtyProperties.get(element) ?? new Set<string>()
    dirty.add(property)
    this.dirtyProperties.set(element, dirty)
  }

  private lifecycleOwns(element: HTMLElement, property: string): boolean {
    return [...this.operations.values()].some((operation) => {
      if (!operation.initialized) return operation.session.owns(element, property)

      return operation.work.some((item, index) => {
        if (item.element !== element) return false

        const addresses = propertyAddresses(element, item.track.property)
        const receiver = operation.receivers[index].receiver.id
        const active = addresses.filter(
          (address) =>
            !operation.interrupted.has(receiverPropertyKey(receiver, item.track.target, address)),
        )

        return (item.track.property === property && active.length > 0) || active.includes(property)
      })
    })
  }

  private flushMotionSamples(time = performance.now()) {
    const pending = new Map(this.dirtyProperties)
    this.dirtyProperties.clear()

    for (const [element, properties] of pending) {
      const protectedAddresses = new Set(
        this.active
          .filter((entry) => entry.receiver.element === element)
          .flatMap((entry) => [...propertyAddresses(element, entry.track.property)]),
      )

      for (const property of properties)
        this.propertyMotion.record(element, property, time, protectedAddresses)
    }
  }

  private restore(preserveLifecycle = false, elements?: ReadonlySet<HTMLElement>) {
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
      element.style.cssText = restoredStyle(entry, element.style.cssText).cssText
    }

    // Rebase retained ownership on the restored baseline. Retired declarations no
    // longer retain old originals when another session continues on the element.
    this.owned = this.owned.filter((entry) => !owned.includes(entry))

    for (const { element, property, value, priority } of protectedValues) {
      this.write(element, property, value, priority)
    }
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

    const duplicate = next.size !== entries.length && !hasLifecycle(this.definition)
    const status = this.resolveBindingStatus(this.definition, next, duplicate)
    const unchanged =
      status === 'ready' &&
      !this.suspended &&
      entries.length === [...this.targetReceivers.values()].flat().length &&
      entries.every(([key, value]) =>
        this.targetReceivers.get(key)?.some((receiver) => receiver.element === value),
      )

    if (unchanged) return

    this.endCompositionPreview()
    this.environment?.invalidateBinding()

    const previousInputs = JSON.stringify(this.values)

    this.releaseControllers()
    this.environment?.clearBindings()
    this.propertyMotion.reset()
    this.dirtyProperties.clear()
    this.cancel(false)
    this.restore(this.operations.size > 0)
    this.replaceReceivers(next)

    this.bindingStatus = status

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

  beginPreview(writes: readonly StyleWrite[]) {
    for (const controller of this.controllers.keys()) controller.setPreview(true)

    this.presented.clear()
    this.presentationMode = 'preparing-preview'
    this.cancel(true, true)
    this.restore()
    this.propertyMotion.reset()
    this.dirtyProperties.clear()
    this.presentationMode = 'preparing-preview'
    this.applyWrites(writes)
  }

  /** Restores ordinary ownership from displayed CSS before accepting another input delta. */
  abortPreview() {
    this.cancel()
    this.restore()
    this.environment?.refreshOwnership()
    this.environment?.reconcile()
  }

  private applyWrites(writes: readonly StyleWrite[]) {
    for (const write of writes)
      this.write(this.receiver(write.receiver).element, write.property, write.value)
  }

  endCompositionPreview(): void {
    if (this.presentationMode === 'live') return

    this.abortPreview()
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

    if (plan.lifecycle) {
      const { release } = plan.lifecycle

      for (const operation of this.operations.values()) {
        if (release.includes(operation.id)) this.operations.delete(operation.session)
      }
    }

    if (plan.resetMotion) {
      this.clearMotionHistory()
      this.presentationMode = 'live'
    }

    const cancelled = new Set(plan.cancel)
    const replaced = this.active.filter((entry) => cancelled.has(entry.id))
    this.active = this.active.filter((entry) => !cancelled.has(entry.id))

    if (plan.mode === 'live') {
      this.layerResolution = plan.resolution

      if (!this.disposed && !this.standalone) this.environment?.acceptPresentation(plan.resolution)
    }

    const groups = new Set(
      [...replaced, ...prepared].flatMap((entry) => (entry.session ? [entry.session] : [])),
    )

    for (const session of groups) {
      session.completion.replace(
        replaced.filter((entry) => entry.session === session).map((entry) => entry.id),
        prepared.filter((entry) => entry.session === session).map((entry) => entry.id),
      )
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

      for (const { animation } of prepared) {
        animation.pause()
        animation.currentTime = 0
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
            const facts = this.presentationFacts(resolution)
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
    this.scheduleReferences()
  }

  dispose() {
    this.disposed = true
    this.releaseControllers()
    this.cancelEnterSessions('owner-teardown')
    this.disconnectBindings()

    const leave = this.active.filter(
      (entry) => entry.session && this.operations.get(entry.session)?.phase === 'leave',
    )

    for (const entry of this.active) {
      if (!leave.includes(entry)) {
        this.retainMotion(entry)
        entry.animation.cancel()
      }
    }

    this.active = leave
    this.presentationMode = 'live'
    this.restore(this.operations.size > 0)
    this.controllers.clear()
    this.dirtyProperties.clear()
    this.targetReceivers.clear()
    // Detached execution keeps accepted values and pure completion data, never Runtime callbacks.
    this.environment = undefined

    if (this.operations.size === 0) {
      this.clearReferenceFrame()
      this.motion.removeEventListener('change', this.motionChanged)
      this.receivers.clear()
    }
  }
}
