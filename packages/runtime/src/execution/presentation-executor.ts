import { materializeEffect } from './native-effect.ts'
import { layerPropertyKey } from './execution-contracts.ts'
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
import type { ReactiveNotification } from '../evaluation/events.ts'
import {
  layerTargets,
  type LayerResolution,
  type LayerTrackTemplate,
} from '../composition/layers.ts'
export { waapiProperty } from '../motion/animation.ts'
import { LetBindingGraph } from '../evaluation/let-bindings.ts'
import { evaluate, type VariableValues } from '../evaluation/expression.ts'
import type { Definition } from '../model/definition.ts'
import { type ResolvedTrack } from '../composition/resolve.ts'
import {
  resolveLifecycle,
  captureLifecycleDefinition,
  hasLifecycle,
  lifecycleTransitions,
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

function inlineDeclarations(element: HTMLElement): Map<string, InlineValue> {
  return new Map(
    Array.from(element.style).map((property) => [
      property,
      {
        value: element.style.getPropertyValue(property),
        priority: element.style.getPropertyPriority(property),
      },
    ]),
  )
}

let nextEffectId = 0

/** One physical receiver shared by every logical target alias in the current binding. */
type Receiver = {
  readonly id: number
  readonly element: HTMLElement
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

export class PresentationExecutor {
  private layerResolution!: LayerResolution
  private environment!: ExecutionEnvironment
  private letBindingCleanups: (() => void)[] = []

  get definition() {
    return this.environment.definition()
  }
  private get values() {
    return this.environment.values()
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
    const byElement = new Map<HTMLElement, Receiver>()
    this.receivers.clear()
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

  /** Materializes a final identifier-based plan; all timing/frame decisions are already pure. */
  private prepareEffect(plan: TrackPlan, receiver: Receiver): ActiveTrack {
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
    }
  }

  private readonly targetReceivers = new Map<string, TargetReceivers>()
  private active: ActiveTrack[] = []
  private readonly propertyMotion = new PropertyMotion()
  private readonly dirtyProperties = new Map<HTMLElement, Set<string>>()
  private referenceFrame?: number
  private readonly controllers = new Map<PropertyController, ControllerState>()
  private readonly lifecycleSessions = new Map<
    number,
    { readonly phase: 'enter' | 'leave'; readonly session: LifecycleSession }
  >()
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
    const cleanups = this.letBindingCleanups
    this.letBindingCleanups = []

    for (const cleanup of cleanups) cleanup()
  }

  connectBindings(graph: LetBindingGraph, notify: (notification?: ReactiveNotification) => void) {
    this.letBindingCleanups.push(...graph.bind(new Map(this.representativeTargets()), notify))
  }

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
    this.releaseControllers()
    this.cancel()
    this.restore()
    this.propertyMotion.reset()
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

  /** Registers a native session and reports settlement without choosing presentation policy. */
  retainLifecycle(phase: 'enter' | 'leave', session: LifecycleSession) {
    if (
      session.isFinished ||
      [...this.lifecycleSessions.values()].some(
        (entry) => entry.phase === phase && entry.session === session,
      )
    )
      return

    const id = this.nextLifecycleId++
    this.lifecycleSessions.set(id, { phase, session })

    void session.finished
      .then(() => {
        // Removed registrations cannot publish stale completion after cancellation or teardown.
        if (this.lifecycleSessions.has(id)) this.environment.lifecycleSettled()

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

    return phase === 'enter' ? work.map((item) => ({ ...item, restoreOnCompletion: true })) : work
  }

  releaseLifecycle(names: readonly string[], element: HTMLElement, properties?: readonly string[]) {
    const interrupted = this.active.filter(
      (entry) =>
        names.includes(entry.track.target) &&
        entry.receiver.element === element &&
        (properties === undefined || properties.includes(entry.track.property)),
    )
    this.active = this.active.filter((entry) => !interrupted.includes(entry))
    for (const entry of interrupted) entry.animation.cancel()
  }

  get animations(): readonly Animation[] {
    return this.active.map((a) => a.animation)
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
    const lifecycle = [...this.lifecycleSessions].map(([id, { phase, session }]) => ({
      id,
      phase,
      finished: session.isFinished,
      protected: receivers.flatMap((receiver) => {
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
        id: entry.id,
        receiver: entry.receiver.id,
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
  ): readonly ReceiverAddresses[] {
    const receivers = this.presentationFacts(resolution).receivers

    return resolution.presentation.targets
      .filter((target) => targets.has(target.name))
      .flatMap((target) => {
        const names = target.properties.map((property) => property.name)

        return receivers
          .filter((receiver) => receiver.target === target.name)
          .map((receiver) => {
            const element = this.receiver(receiver.id).element

            return {
              ...receiver,
              addresses: names.map((name) => ({
                name,
                addresses: propertyAddresses(element, name),
              })),
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

  observeLayerStarts(templates: readonly LayerTrackTemplate[]): ReadonlyMap<string, string> {
    const displayed = new Map<string, string>()
    const styles = new Map<string, CSSStyleDeclaration | undefined>()

    for (const track of templates) {
      if (!track.implicitStart) continue

      if (!styles.has(track.target)) {
        const element = this.targetReceivers.get(track.target)?.at(-1)?.element
        styles.set(track.target, element ? getComputedStyle(element) : undefined)
      }

      displayed.set(
        layerPropertyKey(track.target, track.property),
        styles.get(track.target)?.getPropertyValue(track.property) ?? '',
      )
    }

    return displayed
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
        protected: this.lifecycleOwns(element, track.property),
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
              request.track.destinationValue,
            )
          : undefined,
        reference: request.reference
          ? propertyReference(element, request.source.property, request.source.destinationValue)
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
    /* v8 ignore if -- @preserve: cancel() removes the RAF and active effects before disposal/preview; finished callbacks check active membership. */
    if (this.disposed || this.presentationMode !== 'live') return

    const retargets = new Set<string>()

    for (const entry of this.active) {
      if (entry.reference === undefined || entry.animation.playState === 'paused') continue
      const next = propertyReference(
        entry.receiver.element,
        entry.track.property,
        entry.track.destinationValue,
      )

      if (next !== entry.reference)
        retargets.add(layerPropertyKey(entry.track.target, entry.sourceProperty))
    }

    if (retargets.size > 0) {
      try {
        this.environment.retarget(retargets)
      } catch (error) {
        this.report({ code: 'runtime.animation', message: String(error), error })
      }
    }

    this.scheduleReferences()
  }

  private scheduleReferences() {
    if (
      this.referenceFrame !== undefined ||
      !this.active.some((entry) => entry.reference !== undefined)
    )
      return
    this.referenceFrame = requestAnimationFrame(this.refreshReferences)
  }

  private motionChanged = () => {
    this.environment.motionChanged()
  }

  /** Detaches registrations before cancellation so queued completion cannot publish stale work. */
  private cancelEnterSessions(reason: 'superseded' | 'owner-teardown') {
    const sessions = [...this.lifecycleSessions].filter(([, entry]) => entry.phase === 'enter')

    for (const [id] of sessions) this.lifecycleSessions.delete(id)

    for (const [, { session }] of sessions) session.cancel(reason)
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
    this.presentationMode = 'live'
    this.clearMotionHistory(preserveControllerSnapshot)

    if (cancelEnter) this.cancelEnterSessions('superseded')

    for (const { animation } of this.active) {
      animation.cancel()
    }

    this.active = []
  }

  private write(element: HTMLElement, property: string, value: string) {
    const before = inlineDeclarations(element)
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

    element.style.setProperty(property, value)
    const after = inlineDeclarations(element)

    const pending = document.createElement('div')
    if (beforeCss !== element.style.cssText) {
      pending.style.setProperty(property, value)
    }
    const pendingNames = new Set(
      Array.from(pending.style).filter((name) => pending.style.getPropertyValue(name) === ''),
    )

    // CSSOM enumerates the affected longhands, including shorthand side effects.
    for (const name of new Set([...before.keys(), ...after.keys()])) {
      const previous = before.get(name)
      const next = after.get(name)

      if (
        pendingNames.has(name) ||
        previous?.value !== next?.value ||
        previous?.priority !== next?.priority
      ) {
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
    return [...this.lifecycleSessions.values()].some(({ session }) =>
      session.owns(element, property),
    )
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

  private restore(preserveLifecycle = false) {
    const protectedValues = preserveLifecycle
      ? this.owned.flatMap(({ element }) =>
          [
            ...new Set(
              (['enter', 'leave'] as const).flatMap((phase) =>
                lifecycleTransitions(this.definition, phase).flatMap((transition) =>
                  transition.targets.flatMap((target) =>
                    target.properties.map((property) => property.name),
                  ),
                ),
              ),
            ),
          ]
            .filter((property) => this.lifecycleOwns(element, property))
            .map((property) => ({
              element,
              property,
              value: element.style.getPropertyValue(property),
              priority: element.style.getPropertyPriority(property),
            })),
        )
      : []

    for (const { element, original, originalCss, pending, written } of this.owned) {
      const dirty = this.dirtyProperties.get(element) ?? new Set<string>()
      for (const property of written.keys()) dirty.add(property)
      this.dirtyProperties.set(element, dirty)

      const current = inlineDeclarations(element)
      const baseline = document.createElement('div')
      const external = document.createElement('div')
      baseline.style.cssText = originalCss
      external.style.cssText = element.style.cssText
      const stillOwned = new Set<string>()

      for (const [property, last] of written) {
        const value = current.get(property) ?? { value: '', priority: '' }
        const signature = pending.get(property)
        const pendingChanged =
          signature !== undefined &&
          (element.style.getPropertyValue(signature.property) !== signature.value ||
            element.style.getPropertyPriority(signature.property) !== signature.priority)

        if (!pendingChanged && value.value === last.value && value.priority === last.priority) {
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
      element.style.cssText = baseline.style.cssText + ';' + external.style.cssText
    }

    for (const { element, property, value, priority } of protectedValues)
      element.style.setProperty(property, value, priority)

    if (!preserveLifecycle) this.owned = []
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
    this.environment.invalidateBinding()

    const previousInputs = JSON.stringify(this.values)

    this.releaseControllers()
    this.environment.clearBindings()
    this.propertyMotion.reset()
    this.dirtyProperties.clear()
    this.cancel(false)
    this.restore([...this.lifecycleSessions.values()].some((entry) => entry.phase === 'enter'))
    this.replaceReceivers(next)

    this.bindingStatus = status

    this.environment.rebound(previousInputs !== JSON.stringify(this.values))

    if (this.suspended) {
      this.report({
        code: 'runtime.targets',
        message: status === 'duplicate' ? 'Duplicate target binding' : 'Missing target binding',
      })
    } else {
      this.environment.reconcile()
    }
  }

  beginPreview(writes: readonly StyleWrite[]) {
    for (const controller of this.controllers.keys()) controller.setPreview(true)

    this.cancel(true, true)
    this.restore()
    this.propertyMotion.reset()
    this.dirtyProperties.clear()
    this.presentationMode = 'preparing-preview'
    this.applyWrites(writes)
  }

  abortPreview() {
    this.cancel()
    this.restore()
    this.environment.reconcile()
  }

  private applyWrites(writes: readonly StyleWrite[]) {
    for (const write of writes)
      this.write(this.receiver(write.receiver).element, write.property, write.value)
  }

  endCompositionPreview(): void {
    if (this.presentationMode === 'live') return

    this.cancel()
    this.restore()
    this.environment.reconcile()
  }

  applyPlan(plan: PresentationPlan) {
    const prepared: ActiveTrack[] = []

    try {
      for (const track of plan.start)
        prepared.push(this.prepareEffect(track, this.receiver(track.receiver)))
    } catch (error) {
      for (const entry of prepared) entry.animation.cancel()

      throw error
    }

    if (plan.lifecycle) {
      const { release, cancel } = plan.lifecycle
      // The complete plan uses IDs from this synchronous executor snapshot.
      const sessions = cancel.map((id) => this.lifecycleSessions.get(id)!.session)

      for (const id of [...release, ...cancel]) this.lifecycleSessions.delete(id)

      for (const session of sessions) session.cancel('superseded')
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
      this.environment.acceptPresentation(plan.resolution)
    }

    for (const entry of replaced) entry.animation.cancel()

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
                entry.sourceProperty,
                entry.sourceDestination,
              ) !== entry.reference
            ) {
              this.refreshReferences()

              return undefined
            }

            this.environment.completeEffect(entry.id)
            this.propertyMotion.beginControl(
              entry.receiver.element,
              entry.track.property,
              performance.now(),
            )

            return undefined
          },
          (error) => {
            if (!this.active.includes(entry)) return undefined

            this.active = this.active.filter((item) => item !== entry)
            this.report({ code: 'runtime.animation', message: String(error), error })

            return undefined
          },
        )
        // Reconciliation may already have removed the effect before a write fails.
        // Such failures must be reported independently of expected cancellation.
        .catch((error) => this.report({ code: 'runtime.animation', message: String(error), error }))
    }
    this.scheduleReferences()
  }

  dispose() {
    this.releaseControllers()
    for (const [id, entry] of this.lifecycleSessions) {
      if (entry.phase === 'leave') this.lifecycleSessions.delete(id)
    }

    this.cancelEnterSessions('owner-teardown')
    this.disconnectBindings()
    this.propertyMotion.reset()
    this.dirtyProperties.clear()
    this.cancel()
    this.restore()
    this.motion.removeEventListener('change', this.motionChanged)
    this.targetReceivers.clear()
    this.receivers.clear()
    this.disposed = true
  }
}
