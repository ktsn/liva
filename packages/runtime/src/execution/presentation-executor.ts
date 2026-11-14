import {
  trackTiming,
  trackObservationNeeds,
  planTrack,
  type TrackPlan,
  planEffectChanges,
  orderedResolution,
  ownsCanonicalProperty,
  prepareLayerChange,
  planLayerChange,
  layerPropertyKey,
  type DeclarationAddresses,
} from './presentation-planner.ts'
import { lifecycleOrigin, type RuntimeDiagnostic } from './execution-contracts.ts'
import { CompletionGroup, type CompletionResult } from './completion-group.ts'
import {
  composeRuntimeLayers,
  ordinaryLayer,
  trackLayer,
  normalizeLifecycleTracks,
  type EvaluatedLayer,
  type LayerChange,
} from '../composition/runtime-layers.ts'
import type { BindingFacts, ExecutionEnvironment } from './execution-contracts.ts'
import { propertyReference, propertyAddresses, canonicalTracks } from '../motion/property-codec.ts'
import { propertyRule } from '../motion/property-rules.ts'
import { propertyController, type PropertyController } from '../motion/controllers.ts'
import type { ReactiveNotification } from '../evaluation/events.ts'
import {
  layerPropertyChanged,
  layerTargets,
  resolveLayerTracks,
  resolveComposition,
  type LayerResolution,
  type Composition,
  type CompositionTransition,
} from '../composition/layers.ts'
import { waapiProperty } from '../motion/animation.ts'
export { waapiProperty } from '../motion/animation.ts'
import { LetBindingGraph } from '../evaluation/let-bindings.ts'
import { evaluate, renderTransition, type VariableValues } from '../evaluation/expression.ts'
import type { Definition, Transition } from '../model/definition.ts'
import { type ResolvedTrack } from '../composition/resolve.ts'
import { captureLifecycleDefinition, hasLifecycle } from '../composition/runtime-layers.ts'
import { resolveLifecycleTracks, type LifecycleSession, type LifecycleWork } from './lifecycle.ts'
import { trackLayoutAnimation } from '../layout/layout-scheduler.ts'
import {
  PropertyMotion,
  type MotionSample,
  type MotionObservation,
} from '../motion/property-motion.ts'

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

/** CSSOM supplies shorthand field names and pending var()-valued declarations. */
function inlinePropertyStyle(property: string, value?: string): CSSStyleDeclaration {
  const style = document.createElement('div').style

  if (value !== undefined) style.setProperty(property, value)

  return style
}

let nextEffectId = 0
let nextOperationId = 0

export interface CapturedPresence {
  readonly executor: PresentationExecutor
  readonly source: Transition
  readonly environment: {
    readonly definition: Definition
    values: VariableValues
    normal: LayerResolution
  }
  readonly original: ResolvedTrack
  readonly motion: ReadonlyMap<string, MotionObservation>
  readonly displayed: string
  readonly interrupted: boolean
}

interface PresenceOperation {
  readonly id: number
  readonly phase: 'enter' | 'leave'
  readonly work: readonly LifecycleWork[]
  readonly group: CompletionGroup
  readonly report: (error: unknown) => void
  readonly excluded: Set<string>
  readonly starts: Map<LifecycleWork, string>
  readonly bindings: ReadonlyMap<number, ReadonlySet<string>>
  layers: readonly EvaluatedLayer[]
  normal: LayerResolution
  started: boolean
  initialized: boolean
  readonly held: readonly (readonly [LifecycleWork, string])[]
}

const emptyResolution = (): LayerResolution => ({
  composition: { layers: {}, states: {} },
  states: new Map(),
  transitions: new Map(),
  presentation: { name: '@layers', targets: [] },
})
const workKey = (track: Pick<ResolvedTrack, 'target' | 'property'>) =>
  layerPropertyKey(track.target, track.property)

type ActiveTrack = {
  id: number
  receiver: number
  track: ResolvedTrack
  element: HTMLElement
  animation: Animation
  sourceProperty: string
  sourceDestination: string
  source: ResolvedTrack
  reference?: string
  trajectory?: (milliseconds: number) => MotionSample
  group?: CompletionGroup
  operation?: PresenceOperation
}

/** Binding validity is retained until rebinding or an explicit definition refresh. */
type BindingStatus = 'unbound' | 'ready' | 'missing' | 'duplicate'

/** Preparing previews suppress live restoration; completed previews also survive reduced-motion changes. */
type PresentationMode = 'live' | 'preparing-preview' | 'preview'

/** Each registered name retains its receiving elements in accepted binding order. */
type TargetElements = [HTMLElement, ...HTMLElement[]]

/** Configured instances remain registered while another controller/declaration owns their address. */
type ControllerState = {
  /** Logical target/property identity used to compare selected owners. */
  readonly key: string

  /** Selected for live control, including controllers currently using an unreadable-value fallback. */
  active: boolean
}

export class PresentationExecutor {
  private layerResolution!: LayerResolution
  private environment?: ExecutionEnvironment
  private retainedDefinition: Definition = { name: '@detached', layers: [] }
  private retainedValues: VariableValues = {}
  private retainingEnvironment = false
  private readonly operations = new Set<PresenceOperation>()
  private epoch?: CapturedPresence['environment']
  private readonly pendingHandoffs = new Map<string, MotionObservation>()
  private letBindingCleanups: (() => void)[] = []

  get definition() {
    return this.environment?.definition() ?? this.retainedDefinition
  }

  private get values() {
    return this.retainingEnvironment
      ? this.retainedValues
      : (this.environment?.values() ?? this.retainedValues)
  }

  private listenMotion() {
    if (this.motionListening) return

    this.motion.addEventListener('change', this.motionChanged)
    this.motionListening = true
  }

  private stopMotion() {
    if (!this.motionListening) return

    this.motion.removeEventListener('change', this.motionChanged)
    this.motionListening = false
  }

  attach(environment: ExecutionEnvironment) {
    this.environment = environment
    this.motion = matchMedia('(prefers-reduced-motion: reduce)')
    this.listenMotion()
  }

  initialize(resolution: LayerResolution) {
    this.layerResolution = resolution
    this.retainingEnvironment = false
  }

  get bindingFacts(): BindingFacts {
    return {
      suspended: this.suspended,
    }
  }

  private readonly receivers = new WeakMap<
    HTMLElement,
    { id: number; resolution: LayerResolution; layers: readonly EvaluatedLayer[] }
  >()
  private nextReceiverId = 0

  /** New receivers have no owned presentation; later writes commit both logical layers and their cascade. */
  private receiver(element: HTMLElement) {
    const previous = this.receivers.get(element)

    if (previous) return previous

    const receiver = {
      id: this.nextReceiverId++,
      resolution: emptyResolution(),
      layers: [] as readonly EvaluatedLayer[],
    }
    this.receivers.set(element, receiver)

    return receiver
  }

  private receiverId(element: HTMLElement): number {
    return this.receiver(element).id
  }

  /** Materializes a final identifier-based plan; all timing/frame decisions are already pure. */
  private prepareEffect(plan: TrackPlan, element: HTMLElement): ActiveTrack {
    const animation = new Animation(
      new KeyframeEffect(
        element,
        plan.frames.map((frame) => ({
          [waapiProperty(plan.track.property)]: frame.value,
          offset: frame.offset,
          easing: frame.easing,
        })),
        { duration: plan.durationMs, easing: plan.easing, fill: plan.fill },
      ),
      document.timeline,
    )

    return {
      id: plan.id,
      receiver: plan.receiver,
      track: plan.track,
      element,
      animation,
      sourceProperty: plan.sourceProperty,
      sourceDestination: plan.sourceDestination,
      source: plan.source,
      trajectory: plan.trajectory,
      reference: plan.reference,
    }
  }

  private targetElements = new Map<string, TargetElements>()
  private active: ActiveTrack[] = []
  private readonly propertyMotion = new PropertyMotion()
  private readonly dirtyProperties = new Map<HTMLElement, Set<string>>()
  private referenceFrame?: number
  private readonly controllers = new Map<PropertyController, ControllerState>()
  private enterSessions = new Set<LifecycleSession>()
  private leaveSessions = new Set<LifecycleSession>()
  private owned: OwnedElement[] = []
  private presentationMode: PresentationMode = 'live'
  private bindingStatus: BindingStatus = 'unbound'
  private disposed = false
  private motion!: MediaQueryList
  private motionListening = false
  private readonly report: (diagnostic: RuntimeDiagnostic) => void

  constructor(report: (diagnostic: RuntimeDiagnostic) => void) {
    this.report = report
  }

  private get suspended() {
    return this.bindingStatus !== 'ready'
  }

  initializeDetached() {
    this.layerResolution = emptyResolution()
    this.disposed = true
    this.motion = matchMedia('(prefers-reduced-motion: reduce)')
    this.listenMotion()
  }

  retainEnvironment(values: VariableValues) {
    this.retainedDefinition = this.definition
    this.retainedValues = values
    this.retainingEnvironment = true

    if (this.epoch?.definition === this.definition) {
      this.epoch.values = values
      this.epoch.normal = this.layerResolution
    }
  }

  private renderOperation(
    transition: Transition,
    values: VariableValues,
    work: readonly LifecycleWork[],
  ) {
    const keys = new Set(work.map((item) => workKey(item.track)))
    const targets = transition.targets
      .map((target) => ({
        ...target,
        properties: target.properties.filter((property) =>
          keys.has(layerPropertyKey(target.name, property.name)),
        ),
      }))
      .filter((target) => target.properties.length > 0)

    return renderTransition({ ...transition, targets }, values)
  }

  validatePresentation(values: VariableValues) {
    for (const operation of this.operations) {
      if (operation.group.isFinished) continue

      for (const item of operation.work) {
        const capture = item[lifecycleOrigin]

        if (
          capture &&
          capture.environment.definition === this.definition &&
          !operation.excluded.has(workKey(item.track))
        ) {
          this.renderOperation(capture.source, values, [item])
        }
      }
    }
  }

  private updateOperations(normal: LayerResolution, values = this.values) {
    if (
      this.environment &&
      !this.retainingEnvironment &&
      this.epoch?.definition === this.definition
    ) {
      this.epoch.values = values
      this.epoch.normal = normal
    }

    for (const operation of this.operations) {
      if (operation.group.isFinished) continue

      if (operation.phase === 'enter' && operation.started) {
        for (const target of normal.presentation.targets) {
          for (const property of target.properties) {
            if (layerPropertyChanged(operation.normal, target.name, property))
              operation.excluded.add(layerPropertyKey(target.name, property.name))
          }
        }
      }

      if (operation.phase === 'enter' && operation.started) {
        for (const item of operation.work) {
          const before = operation.normal.presentation.targets
            .find((target) => target.name === item.track.target)
            ?.properties.some((property) => property.name === item.track.property)
          const after = normal.presentation.targets
            .find((target) => target.name === item.track.target)
            ?.properties.some((property) => property.name === item.track.property)

          if (before && !after) operation.excluded.add(workKey(item.track))
        }
      }

      operation.normal = normal
      const layers: EvaluatedLayer[] = []

      for (const [item, held] of operation.held) {
        if (operation.excluded.has(workKey(item.track))) continue

        const capture = item[lifecycleOrigin]
        const environment =
          capture &&
          capture.environment.definition === this.definition &&
          this.environment &&
          !this.retainingEnvironment
            ? values
            : capture?.environment.values
        const baseline =
          capture &&
          capture.environment.definition === this.definition &&
          this.environment &&
          !this.retainingEnvironment
            ? normal
            : (capture?.environment.normal ?? emptyResolution())

        if (
          capture &&
          this.environment &&
          !this.retainingEnvironment &&
          capture.environment.definition === this.definition
        ) {
          capture.environment.values = values
          capture.environment.normal = normal
        }
        let track = item.track

        if (capture && environment) {
          const transition = this.renderOperation(capture.source, environment, [item])
          const resolved = normalizeLifecycleTracks(
            operation.phase,
            transition,
            baseline.presentation,
            new Map([[workKey(item.track), item.track.keyframes[0].value]]),
          )
          const fresh = resolved[0]

          if (fresh) {
            const original = capture.original
            const rebased = original !== item.track
            track = rebased
              ? {
                  ...fresh,
                  keyframes: fresh.keyframes.map((frame, index) =>
                    index === 0 ? item.track.keyframes[0] : frame,
                  ),
                }
              : fresh
          }
        }

        const starting = operation.starts.get(item)

        if (starting !== undefined)
          track = {
            ...track,
            keyframes: track.keyframes.map((frame, index) =>
              index === 0 ? { ...frame, value: starting } : frame,
            ),
          }

        if (!operation.initialized && !operation.started) {
          track = {
            ...track,
            keyframes: [
              { offset: 0, value: held },
              { offset: 1, value: held },
            ],
          }
        }

        layers.push(
          trackLayer(
            `@presence:${operation.id}:${workKey(item.track)}`,
            this.receiverId(item.element),
            [track],
            !operation.started,
          ),
        )
      }

      operation.layers = layers
    }
  }

  private runtimeLayers(normal: LayerResolution): readonly EvaluatedLayer[] {
    return [
      ordinaryLayer(normal),
      ...[...this.operations]
        .filter((operation) => !operation.group.isFinished)
        .flatMap((operation) => operation.layers),
    ]
  }

  private receiverNames(element: HTMLElement): ReadonlySet<string> {
    const names = new Set(
      [...this.targetElements]
        .filter(([, elements]) => elements.includes(element))
        .map(([name]) => name),
    )

    for (const operation of this.operations)
      for (const item of operation.work) if (item.element === element) names.add(item.track.target)

    return names
  }

  private effectiveResolution(normal: LayerResolution, element: HTMLElement): LayerResolution {
    const names = this.receiverNames(element)
    const presentation = composeRuntimeLayers(this.runtimeLayers(normal), this.receiverId(element))

    return {
      ...normal,
      presentation: {
        ...presentation,
        targets: presentation.targets.filter((target) => names.has(target.name)),
      },
    }
  }

  receives(item: LifecycleWork) {
    return (
      item[lifecycleOrigin]?.executor === this ||
      (this.targetElements.get(item.track.target)?.includes(item.element) ?? false)
    )
  }

  createOperation(
    work: readonly LifecycleWork[],
    phase: 'enter' | 'leave',
    group: CompletionGroup,
    report: (error: unknown) => void,
  ): PresenceOperation {
    const held = work.map(
      (item) =>
        [
          item,
          (item.element.isConnected
            ? getComputedStyle(item.element)
            : item.element.style
          ).getPropertyValue(item.track.property),
        ] as const,
    )
    const bindings = new Map<number, Set<string>>()

    for (const item of work) {
      const receiver = this.receiverId(item.element)
      const addresses = bindings.get(receiver) ?? new Set<string>()
      addresses.add(item.track.property)

      for (const address of propertyAddresses(item.element, item.track.property))
        addresses.add(address)

      bindings.set(receiver, addresses)
    }

    const operation: PresenceOperation = {
      id: nextOperationId++,
      phase,
      work,
      group,
      report,
      excluded: new Set(),
      starts: new Map(),
      bindings,
      layers: [],
      normal: this.layerResolution,
      started: false,
      initialized: false,
      held,
    }
    this.operations.add(operation)

    // The caller receives cleanup ownership only after normalization succeeds.
    // Undo this registration if live phase inputs cannot prepare the operation.
    try {
      if (this.disposed && this.operations.size === 1) this.listenMotion()

      this.updateOperations(this.layerResolution)
    } catch (error) {
      this.operations.delete(operation)

      if (this.disposed && this.operations.size === 0) this.stopMotion()

      throw error
    }

    return operation
  }

  private initializeStarts(operation: PresenceOperation) {
    for (const item of operation.work) {
      const capture = item[lifecycleOrigin]
      if (!capture) continue

      if (capture.original !== item.track) operation.starts.set(item, item.track.keyframes[0].value)
      else if (capture.interrupted) {
        operation.starts.set(item, capture.displayed)
      } else if (operation.phase === 'leave') {
        const declaration = capture.environment.definition.leave?.targets
          .find((target) => target.name === item.track.target)
          ?.properties.find((property) => property.name === item.track.property)
        const explicit = declaration?.keyframes?.some((frame) => frame.offset === 0)

        if (!explicit && this.environment && item.element.isConnected)
          operation.starts.set(
            item,
            getComputedStyle(item.element).getPropertyValue(item.track.property),
          )
      }
    }
  }

  initializeOperation(operation: PresenceOperation) {
    operation.initialized = true
    this.initializeStarts(operation)
    this.updateOperations(this.layerResolution)

    // Initialization precedes start/exclusion, so updateOperations emits one
    // single-property layer for each work item in that same order.
    for (const [index, item] of operation.work.entries()) {
      const value = operation.layers[index].targets[0].properties[0].value

      this.write(item.element, item.track.property, value)
      this.receiver(item.element).resolution = this.effectiveResolution(
        this.layerResolution,
        item.element,
      )
      this.receiver(item.element).layers = this.runtimeLayers(this.layerResolution)
    }
  }

  private retainHandoffs(operation: PresenceOperation) {
    for (const item of operation.work) {
      const capture = item[lifecycleOrigin]

      if (!capture) continue

      for (const [key, observation] of capture.motion) this.pendingHandoffs.set(key, observation)
    }
  }

  private referenceValue(
    element: HTMLElement,
    property: string,
    completion: string,
    endpoint: string,
  ) {
    const finalReference = propertyReference(element, property, completion)

    if (endpoint === completion) return finalReference

    const animationReference = propertyReference(element, property, endpoint)

    return finalReference === undefined && animationReference === undefined
      ? undefined
      : JSON.stringify([finalReference, animationReference])
  }

  private observeMotion(element: HTMLElement, track: ResolvedTrack) {
    const observation = this.propertyMotion.observeSpring(
      element,
      track.property,
      trackObservationNeeds(track, false, true).endpoint,
    )
    const captured = this.pendingHandoffs.get(`${this.receiverId(element)}\0${track.property}`)
    const current = observation.start

    if (!current || !captured) return observation

    const now = performance.now()
    const velocity = captured.sample.velocity.map((componentVelocity, index) => {
      const currentTime = observation.releasedAt?.[index]
      const capturedTime = captured.observedAt[index] ?? captured.time

      if (
        observation.animated?.[index] ||
        (currentTime !== undefined && currentTime >= capturedTime)
      )
        return current.velocity[index]

      const expiry = captured.validUntil[index]

      return expiry === undefined || now < expiry ? componentVelocity : 0
    })

    return { ...observation, start: { value: current.value, velocity } }
  }

  playOperation(operation: PresenceOperation) {
    operation.started = true
    this.retainHandoffs(operation)
    this.updateOperations(this.layerResolution)

    if (this.environment)
      this.layerResolution = this.controllerResolution(
        this.layerResolution,
        this.values,
        performance.now(),
      )

    this.applyLayerResolution(this.layerResolution, this.layerResolution)
  }

  endOperation(operation: PresenceOperation, result: CompletionResult) {
    this.operations.delete(operation)

    for (const item of operation.work)
      for (const key of item[lifecycleOrigin]?.motion.keys() ?? []) this.pendingHandoffs.delete(key)

    if (this.environment && this.presentationMode === 'live')
      this.layerResolution = this.controllerResolution(
        this.layerResolution,
        this.values,
        performance.now(),
      )

    const ended = this.active.filter((entry) => entry.operation === operation)
    this.active = this.active.filter((entry) => entry.operation !== operation)

    for (const entry of ended) entry.animation.cancel()

    for (const element of new Set(operation.work.map((item) => item.element))) {
      this.restore(this.operations.size > 0, element)
      this.settle(element)
    }

    if (result === 'completed' && operation.phase === 'enter') {
      for (const item of operation.work) {
        if (!item.restoreOnCompletion)
          item.element.style.setProperty(item.track.property, item.track.destinationValue)
      }
    }

    this.scheduleReferences()

    if (this.disposed && this.operations.size === 0) this.stopMotion()
  }

  snapshotValues(definition: Definition): VariableValues {
    return this.environment?.snapshotValues(definition) ?? this.retainedValues
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
    for (const [name, elements] of this.targetElements) {
      // bind creates each group with its first element, so every tuple is nonempty.
      yield [name, elements[elements.length - 1]] as const
    }
  }

  resetPresentation() {
    this.endCompositionPreview()
    this.releaseControllers()
    this.cancel()
    this.restore()
    if (!this.active.some((entry) => entry.group)) this.propertyMotion.reset()

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
      this.targetElements,
      this.bindingStatus === 'duplicate',
    )
  }

  private resolveBindingStatus(
    definition: Definition,
    targets: ReadonlyMap<string, TargetElements>,
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

  /** Retains live ownership; already finished sessions and duplicate registrations are ignored. */
  retainLifecycle(phase: 'enter' | 'leave', session: LifecycleSession) {
    const sessions = phase === 'enter' ? this.enterSessions : this.leaveSessions

    if (session.isFinished || sessions.has(session)) return

    sessions.add(session)
    session.retain(this)

    void session.finished.then(() => {
      // Removal also invalidates callbacks queued before cancellation or disposal.
      if (!sessions.has(session)) return undefined

      // Sessions mark themselves finished before their Promise callbacks run, so
      // several presence boundaries may already be done here. Remove them together;
      // later callbacks observe their removal and skip repeated restoration.
      for (const completed of sessions) {
        if (completed.isFinished) sessions.delete(completed)
      }

      return undefined
    })
  }

  captureLifecycle(phase: 'enter' | 'leave', names: readonly string[], element?: HTMLElement) {
    const definition = this.definition
    const source = definition[phase]

    if (!source) return []

    const targets = new Map(
      [...this.representativeTargets()]
        .filter(([name]) => names.includes(name))
        .map(([name, target]) => [name, element ?? target]),
    )
    const observations: { element: HTMLElement; displayed: string }[] = []
    const tracks = resolveLifecycleTracks(
      phase,
      captureLifecycleDefinition(definition, phase, this.values),
      this.layerResolution.presentation,
      (target, property) => {
        const receiver = targets.get(target)

        if (!receiver) return undefined

        const value = (
          receiver.isConnected ? getComputedStyle(receiver) : receiver.style
        ).getPropertyValue(property)
        observations.push({ element: receiver, displayed: value })

        return value
      },
    )
    // Each successful callback produces exactly one normalized track, in order.
    const work = tracks.map((track, index) => ({ ...observations[index], track }))
    const interrupted = new Set(
      work
        .filter((item) =>
          this.active.some(
            (entry) =>
              entry.element === item.element &&
              (phase === 'leave' || entry.group !== undefined) &&
              (entry.sourceProperty === item.track.property ||
                propertyAddresses(item.element, item.track.property).includes(
                  entry.track.property,
                )),
          ),
        )
        .map((item) => workKey(item.track)),
    )

    const now = performance.now()
    const motion = new Map<string, MotionObservation>()

    for (const item of work) {
      if (!trackObservationNeeds(item.track, false, true).motion) continue

      for (const track of canonicalTracks(item.element, item.track)) {
        const key = `${this.receiverId(item.element)}\0${track.property}`

        if (motion.has(key)) continue

        const observed = this.propertyMotion.capture(item.element, track.property, now)

        if (observed) motion.set(key, observed)
      }
    }

    if (this.epoch?.definition !== definition)
      this.epoch = { definition, values: this.values, normal: this.layerResolution }

    const environment = this.epoch

    return work.map((item) => {
      const captured: CapturedPresence = {
        executor: this,
        source,
        environment,
        original: item.track,
        motion,
        displayed: item.displayed,
        interrupted: interrupted.has(workKey(item.track)),
      }

      return {
        element: item.element,
        track: item.track,
        restoreOnCompletion: phase === 'enter',
        [lifecycleOrigin]: captured,
      }
    })
  }

  releaseLifecycle(names: readonly string[], element: HTMLElement, properties?: readonly string[]) {
    const interrupted = this.active.filter(
      (entry) =>
        !entry.group &&
        names.includes(entry.track.target) &&
        entry.element === element &&
        (properties === undefined ||
          properties.includes(entry.track.property) ||
          properties.includes(entry.sourceProperty)),
    )
    this.active = this.active.filter((entry) => !interrupted.includes(entry))
    for (const entry of interrupted) entry.animation.cancel()
  }

  get animations(): readonly Animation[] {
    return this.active.filter((entry) => !entry.group).map((a) => a.animation)
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

  /** Captures only canonical identities, without retaining the receiving element in plans. */
  private declarationAddresses(
    resolution: LayerResolution,
    element: HTMLElement,
    target: string,
    source?: string,
  ): DeclarationAddresses {
    const names = resolution.presentation.targets
      .filter((item) => item.name === target)
      .flatMap((item) => item.properties.map((property) => property.name))

    if (source) names.push(source)

    return [...new Set(names)].map((name) => ({
      name,
      addresses: propertyAddresses(element, name),
    }))
  }

  /**
   * Resolves effective controller bindings into CSS values and, in live mode,
   * reconciles controller ownership for the next presentation. Bindings obscured
   * by other declarations are omitted. If a controller cannot supply a value, the
   * same composition is resolved without bindings to recover a normal declaration;
   * properties without a fallback are omitted.
   *
   * @param resolution - Layer selection and presentation resolved from definition.
   * @param values - Expression values used to resolve bindings and fallback styles.
   * @param time - Acquisition/release time in performance.now()-compatible milliseconds.
   * @param definition - Source definition matching the resolution's layer owners.
   * @param live - Acquires effective controllers and releases previous owners when
   * true; false renders snapshots for inspection/preview without changing ownership.
   * @returns A new resolution with properties in declaration order. The caller
   * applies its CSS values to the DOM.
   * @throws If expression evaluation fails or a binding lacks a controller capability.
   */
  controllerResolution(
    resolution: LayerResolution,
    values: VariableValues,
    time: number,
    definition = this.definition,
    live = true,
  ): LayerResolution {
    // Declaration order determines ownership, including overlapping shorthand,
    // longhand, and logical properties that address the same physical CSS property.
    resolution = orderedResolution(resolution, definition)

    if (
      !resolution.presentation.targets.some((target) =>
        target.properties.some((property) => property.binding),
      )
    ) {
      // Without effective bindings, live control ends for every previous owner.
      if (live) {
        this.releaseControllers(time)
        this.updateOperations(resolution, values)
      }

      return orderedResolution(resolution, definition)
    }

    // Re-resolve the selected composition without bindings so an unreadable
    // controller can reveal the normal declaration hidden beneath it.
    const normal = resolveComposition(
      {
        ...definition,
        layers: definition.layers.map((layer) => ({
          ...layer,
          targets: layer.targets.map((target) => ({
            ...target,
            properties: target.properties.filter((property) => property.value.kind !== 'binding'),
          })),
          states: layer.states?.map((state) => ({
            ...state,
            targets: state.targets.map((target) => ({
              ...target,
              properties: target.properties.filter((property) => property.value.kind !== 'binding'),
            })),
          })),
        })),
      },
      values,
      resolution.composition,
    )

    // Occluded controllers retain their last logical baseline while input records
    // remain live for expressions. Reacquisition later rebases from displayed CSS.
    const provisional = {
      ...resolution,
      presentation: {
        ...resolution.presentation,
        targets: resolution.presentation.targets.map((target) => ({
          ...target,
          properties: target.properties.flatMap((property) => {
            if (!property.binding) return [property]

            const previous = this.layerResolution.presentation.targets
              .find((item) => item.name === target.name)
              ?.properties.find(
                (item) =>
                  item.name === property.name && item.owner === property.owner && item.binding,
              )
            const snapshot = evaluate(property.binding, values)
            const value =
              previous?.value ?? propertyController(snapshot).render(property.name, snapshot)
            const fallback = normal.presentation.targets
              .find((item) => item.name === target.name)
              ?.properties.find((item) => item.name === property.name)

            return value !== undefined ? [{ ...property, value }] : fallback ? [fallback] : []
          }),
        })),
      },
    }

    if (live) this.updateOperations(provisional, values)

    const nextOwners = new Map<string, PropertyController>()
    const targets = resolution.presentation.targets.map((target) => ({
      ...target,
      properties: target.properties.flatMap((property) => {
        if (!property.binding) return [property]

        // A binding must own every physical property it affects on each receiver;
        // otherwise omit it so it cannot overwrite a winning declaration.
        const elements = this.targetElements.get(target.name) ?? []
        const obscured = elements.some((element) =>
          propertyAddresses(element, property.name).some(
            (address) =>
              !ownsCanonicalProperty(
                this.declarationAddresses(resolution, element, target.name, property.name),
                property.name,
                address,
              ),
          ),
        )

        if (obscured) return []

        const presenceObscured =
          live &&
          this.operations.size > 0 &&
          elements.some((element) => {
            const effective = this.effectiveResolution(provisional, element)
            const owner = effective.presentation.targets
              .find((item) => item.name === target.name)
              ?.properties.find((item) => item.name === property.name)?.owner

            return (
              owner !== property.owner ||
              propertyAddresses(element, property.name).some(
                (address) =>
                  !ownsCanonicalProperty(
                    this.declarationAddresses(effective, element, target.name),
                    property.name,
                    address,
                  ),
              )
            )
          })

        if (presenceObscured) {
          const baseline = provisional.presentation.targets
            .find((item) => item.name === target.name)
            ?.properties.find((item) => item.name === property.name)

          return baseline ? [baseline] : []
        }

        // Live control acquires from the displayed pose. Inspection and preview
        // only format the supplied snapshot, leaving live ownership unchanged.
        const snapshot = evaluate(property.binding, values)
        const controller = propertyController(snapshot)
        const key = layerPropertyKey(target.name, property.name)
        nextOwners.set(key, controller)

        if (live) controller.acquire(time)

        const value = live
          ? controller.control()?.value
          : controller.render(property.name, snapshot)

        if (value !== undefined) return [{ ...property, value }]

        // Missing controller output falls back to the same property's normal
        // declaration; omit the property if no such declaration exists.
        const fallback = normal.presentation.targets
          .find((candidate) => candidate.name === target.name)
          ?.properties.find((candidate) => candidate.name === property.name)

        return fallback ? [fallback] : []
      }),
    }))

    // Release replaced or obscured owners before the caller prepares transitions,
    // allowing their input velocity to be handed to the next spring.
    if (live) {
      // Live controllers were registered before binding; candidate inspections
      // never publish their ownership into this registry.
      for (const [controller, state] of this.controllers) {
        const selected = nextOwners.get(state.key) === controller

        if (state.active && !selected) controller.release(time)

        state.active = selected
      }
    }

    // A fallback can belong to an earlier declaration, so restore cascade order
    // before the caller applies styles or checks physical property ownership.
    return orderedResolution(
      { ...resolution, presentation: { ...resolution.presentation, targets } },
      definition,
    )
  }

  inspectLifecycle(
    phase: 'enter' | 'leave',
    composition: Composition,
    definition = this.definition,
  ) {
    const values = this.snapshotValues(definition)

    return {
      presentation: this.controllerResolution(
        resolveComposition(definition, values, composition),
        values,
        performance.now(),
        definition,
        false,
      ).presentation,
      transition: captureLifecycleDefinition(definition, phase, values),
    }
  }

  inspectComposition(
    composition: Composition,
    from?: Composition,
    transitions: readonly CompositionTransition[] = [],
    definition = this.definition,
  ): LayerResolution {
    try {
      const values = this.snapshotValues(definition)

      const resolution = this.controllerResolution(
        resolveComposition(definition, values, composition, from, transitions),
        values,
        performance.now(),
        definition,
        false,
      )

      return {
        ...resolution,
        transitions: new Map(
          [...resolution.transitions].flatMap(([name, transition]) => {
            const targets = transition.transition.targets.flatMap((target) => {
              const properties = target.properties.filter((property) =>
                resolution.presentation.targets
                  .find((item) => item.name === target.name)
                  ?.properties.some((item) => item.name === property.name && item.owner === name),
              )

              return resolution.presentation.targets.some(
                (item) =>
                  item.name === target.name &&
                  item.properties.some((property) => property.owner === name),
              )
                ? [{ ...target, properties }]
                : []
            })

            if (
              !resolution.presentation.targets.some((target) =>
                target.properties.some((property) => property.owner === name),
              )
            )
              return []

            const rendered = renderTransition({ ...transition.transition, targets }, values)

            return [
              [
                name,
                {
                  ...transition,
                  transition: {
                    timing: rendered.timing,
                    targets: rendered.targets.map((target) => ({
                      name: target.name,
                      timingProperties: target.timingProperties,
                      timing: target.timing,
                      properties: target.properties.map((property) => ({
                        name: property.name,
                        timing: property.timing,
                        keyframes: property.keyframes?.map((frame) => ({
                          offset: frame.offset,
                          value: frame.value,
                          easing: frame.easing,
                        })),
                      })),
                    })),
                  },
                },
              ] as const,
            ]
          }),
        ),
      }
    } catch (error) {
      this.report({ code: 'runtime.inspection', message: String(error), error })
      throw error
    }
  }

  private clearReferenceFrame() {
    if (this.referenceFrame !== undefined) cancelAnimationFrame(this.referenceFrame)
    this.referenceFrame = undefined
  }

  private refreshReferences = () => {
    this.clearReferenceFrame()
    /* v8 ignore if -- @preserve: cancel() removes the RAF and active effects before disposal/preview; finished callbacks check active membership. */
    if ((this.disposed && this.operations.size === 0) || this.presentationMode !== 'live') return

    const retargets = new Set<string>()

    for (const entry of this.active) {
      if (entry.reference === undefined || entry.animation.playState === 'paused') continue
      const next = this.referenceValue(
        entry.element,
        entry.sourceProperty,
        entry.sourceDestination,
        trackObservationNeeds(entry.source, false, false).endpoint,
      )

      if (next !== entry.reference)
        retargets.add(layerPropertyKey(entry.track.target, entry.sourceProperty))
    }

    if (retargets.size > 0) {
      try {
        this.applyLayerChange(this.layerResolution, this.layerResolution, retargets)
      } catch (error) {
        this.report({ code: 'runtime.animation', message: String(error), error })
      }
    }

    this.scheduleReferences()
  }

  private scheduleReferences() {
    if (!this.active.some((entry) => entry.reference !== undefined)) {
      this.clearReferenceFrame()

      return
    }

    if (this.referenceFrame === undefined)
      this.referenceFrame = requestAnimationFrame(this.refreshReferences)
  }

  private motionChanged = () => {
    if (this.motion.matches && this.presentationMode !== 'preview') {
      const retargets = new Set(
        this.active.map((entry) => layerPropertyKey(entry.track.target, entry.sourceProperty)),
      )

      this.applyLayerChange(this.layerResolution, this.layerResolution, retargets)
    }
  }

  /** Detaches owners before ending sessions so their queued callbacks cannot restore styles again. */
  private cancelEnterSessions(reason: 'superseded' | 'owner-teardown') {
    const sessions = [...this.enterSessions]
    this.enterSessions.clear()

    for (const session of sessions) session.cancel(reason)
  }

  private cancel(cancelEnter = true, preserveControllerSnapshot = false) {
    this.presentationMode = 'live'
    this.clearReferenceFrame()
    if (!preserveControllerSnapshot) {
      for (const controller of this.controllers.keys()) controller.setPreview(false)
    }
    if (!this.active.some((entry) => entry.group)) this.propertyMotion.reset()

    this.dirtyProperties.clear()
    if (cancelEnter) this.cancelEnterSessions('superseded')

    const cancelled = this.active.filter((entry) => !entry.group)
    this.active = this.active.filter((entry) => entry.group)

    for (const { animation } of cancelled) animation.cancel()
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

    const pending = inlinePropertyStyle(
      property,
      beforeCss !== element.style.cssText ? value : undefined,
    )
    const pendingNames = new Set(
      Array.from(pending).filter((name) => pending.getPropertyValue(name) === ''),
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

  private lifecycleProperties(element: HTMLElement): ReadonlySet<string> {
    const receiver = this.receiverId(element)

    return new Set(
      [...this.operations]
        .filter((operation) => !operation.group.isFinished)
        .flatMap((operation) =>
          operation.layers
            .filter((layer) => layer.scope === 'all' || layer.scope.includes(receiver))
            .flatMap((layer) =>
              layer.targets.flatMap((target) => target.properties.map((property) => property.name)),
            ),
        ),
    )
  }

  private flushMotionSamples(time = performance.now()) {
    const pending = new Map(this.dirtyProperties)
    this.dirtyProperties.clear()

    for (const [element, properties] of pending) {
      const protectedAddresses = new Set(
        this.active
          .filter((entry) => entry.element === element)
          .flatMap((entry) => [...propertyAddresses(element, entry.track.property)]),
      )

      for (const property of properties)
        this.propertyMotion.record(element, property, time, protectedAddresses)
    }
  }

  private restore(preserveLifecycle = false, receivingElement?: HTMLElement) {
    const protectedValues = preserveLifecycle
      ? this.owned
          .filter(({ element }) => receivingElement === undefined || element === receivingElement)
          .flatMap(({ element }) =>
            [...this.lifecycleProperties(element)].map((property) => ({
              element,
              property,
              value: element.style.getPropertyValue(property),
              priority: element.style.getPropertyPriority(property),
            })),
          )
      : []
    const protectedFields = new Map<HTMLElement, Set<string>>()

    for (const { element, property, value } of protectedValues) {
      const fields = protectedFields.get(element) ?? new Set<string>()
      fields.add(property)

      for (const field of inlinePropertyStyle(property, value)) fields.add(field)

      protectedFields.set(element, fields)
    }

    for (const { element, original, originalCss, pending, written } of this.owned) {
      if (receivingElement && element !== receivingElement) continue

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

    // Restoration ends ownership of every restored field except declarations
    // still required by another operation. Later work starts from the then-current
    // external CSS, rather than inheriting this retired operation's originals.
    this.owned = this.owned.filter(({ element, written, pending }) => {
      if (receivingElement && element !== receivingElement) return true

      const fields = protectedFields.get(element)

      if (!fields) return false

      for (const property of written.keys()) {
        if (fields.has(property)) continue

        written.delete(property)
        pending.delete(property)
      }

      return true
    })
  }

  /** Reconciles presentation, optionally restricting writes to one receiving element. */
  settle(receivingElement?: HTMLElement) {
    const elements = new Set([...this.targetElements.values()].flat())

    if (receivingElement) elements.add(receivingElement)

    for (const operation of this.operations)
      for (const item of operation.work) elements.add(item.element)

    for (const element of elements) {
      if (receivingElement && element !== receivingElement) continue

      const normal = this.disposed || this.suspended ? emptyResolution() : this.layerResolution
      const resolution = this.effectiveResolution(normal, element)
      for (const target of resolution.presentation.targets) {
        for (const property of target.properties) this.write(element, property.name, property.value)
      }

      this.receiver(element).resolution = resolution
      this.receiver(element).layers = this.runtimeLayers(normal)
    }

    this.flushMotionSamples()
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
      entries.length === [...this.targetElements.values()].flat().length &&
      entries.every(([key, value]) => this.targetElements.get(key)?.includes(value))

    if (unchanged) return

    this.endCompositionPreview()
    this.environment?.invalidateBinding()

    const previousInputs = JSON.stringify(this.values)

    this.releaseControllers()
    this.environment?.clearBindings()
    if (!this.active.some((entry) => entry.group)) this.propertyMotion.reset()

    this.dirtyProperties.clear()
    this.cancel(false)
    this.restore(this.enterSessions.size > 0)
    this.targetElements = next
    this.bindingStatus = status

    this.environment?.rebound(previousInputs !== JSON.stringify(this.values))

    if (this.suspended) {
      this.report({
        code: 'runtime.targets',
        message: status === 'duplicate' ? 'Duplicate target binding' : 'Missing target binding',
      })
    } else {
      this.settle()
    }
  }

  /** Preview explicit selections while retaining the application's definition and machine history. */
  previewComposition(
    from: Composition,
    to: Composition,
    transitions: readonly CompositionTransition[] = [],
    definition = this.definition,
  ): void {
    this.prepareCompositionPreview(from, to, transitions, definition)
  }

  private prepareCompositionPreview(
    from: Composition,
    to: Composition,
    transitions: readonly CompositionTransition[],
    definition: Definition,
    phase?: 'enter' | 'leave',
  ): void {
    if (this.disposed || this.suspended) {
      throw new Error('Composition preview requires a mounted layer instance')
    }

    const prepared: ActiveTrack[] = []

    try {
      const values = this.snapshotValues(definition)
      const previous = this.controllerResolution(
        resolveComposition(definition, values, from),
        values,
        performance.now(),
        definition,
        false,
      )
      const next = this.controllerResolution(
        resolveComposition(definition, values, to, from, transitions),
        values,
        performance.now(),
        definition,
        false,
      )
      const lifecycle = phase ? captureLifecycleDefinition(definition, phase, values) : undefined

      for (const controller of this.controllers.keys()) controller.setPreview(true)
      this.cancel(true, true)
      this.restore()
      this.propertyMotion.reset()
      this.dirtyProperties.clear()
      this.presentationMode = 'preparing-preview'

      const present = (resolution: LayerResolution) => {
        for (const target of resolution.presentation.targets) {
          for (const element of this.targetElements.get(target.name) ?? []) {
            for (const property of target.properties) {
              this.write(element, property.name, property.value)
            }
          }
        }
      }

      present(previous)

      for (const [target, elements] of this.targetElements) {
        const targetResolution = {
          ...next,
          presentation: {
            ...next.presentation,
            targets: next.presentation.targets.filter((item) => item.name === target),
          },
        }

        for (const element of elements) {
          const tracks = phase
            ? resolveLifecycleTracks(phase, lifecycle, next.presentation, (name, property) =>
                name === target ? getComputedStyle(element).getPropertyValue(property) : undefined,
              )
            : resolveLayerTracks(
                previous,
                targetResolution,
                values,
                (_name, property) => getComputedStyle(element).getPropertyValue(property),
                (message) => this.report({ code: 'runtime.endpoint', message }),
                () => true,
              )

          if (tracks.length === 0) continue

          // Lifecycle previews use their own declarations, so ordinary cascade
          // addresses would add unused writing-context observations.
          const addresses = phase ? undefined : this.declarationAddresses(next, element, target)

          for (const source of tracks) {
            const timing = trackTiming(source)

            for (const track of canonicalTracks(element, source)) {
              const needs = trackObservationNeeds(track, false, false)
              const plan = planTrack(
                {
                  id: nextEffectId++,
                  receiver: this.receiverId(element),
                  source,
                  track,
                  declarations: addresses ?? [
                    {
                      name: source.property,
                      addresses: propertyAddresses(element, source.property),
                    },
                  ],
                  displayed: needs.displayed
                    ? getComputedStyle(element).getPropertyValue(track.property)
                    : undefined,
                  interrupted: false,
                },
                timing,
                phase === 'leave' ? 'both' : 'backwards',
              )

              if (plan) prepared.push(this.prepareEffect(plan, element))
            }
          }
        }
      }

      this.restore()
      present(next)
      this.active.push(...prepared)
      this.presentationMode = 'preview'

      for (const { animation } of prepared) {
        animation.pause()
        animation.currentTime = 0
      }
    } catch (cause) {
      for (const { animation } of prepared) animation.cancel()

      this.cancel()
      this.restore()
      this.settle()
      const error = new Error('Could not prepare composition preview', { cause })
      this.report({ code: 'runtime.preview', message: error.message, error })
      throw error
    }
  }

  endCompositionPreview(): void {
    if (this.presentationMode === 'live') return

    this.cancel()
    this.restore(this.operations.size > 0)
    this.settle()
    this.scheduleReferences()
  }

  /** Prepare scrub-ready lifecycle effects without invoking presence removal callbacks. */
  previewLifecycle(
    phase: 'enter' | 'leave',
    composition = this.layerResolution.composition,
    definition = this.definition,
  ): void {
    this.prepareCompositionPreview(composition, composition, [], definition, phase)
  }

  applyLayerResolution(previous: LayerResolution, next: LayerResolution) {
    this.applyLayerChange(previous, next, new Set())
  }

  private applyLayerChange(
    previous: LayerResolution,
    next: LayerResolution,
    retargets: ReadonlySet<string>,
  ) {
    this.updateOperations(next)
    const receivers = new Map<HTMLElement, Set<string>>()

    for (const [name, elements] of this.targetElements) {
      for (const element of elements) {
        const names = receivers.get(element) ?? new Set<string>()
        names.add(name)
        receivers.set(element, names)
      }
    }

    for (const operation of this.operations) {
      for (const item of operation.work) {
        const names = receivers.get(item.element) ?? new Set<string>()
        names.add(item.track.target)
        receivers.set(item.element, names)
      }
    }

    const prepared: ActiveTrack[] = []
    const replaced = new Set<ActiveTrack>()
    const presentations: {
      element: HTMLElement
      next: LayerResolution
      changed: ReadonlySet<string>
      removed: boolean
    }[] = []

    try {
      for (const [element, names] of receivers) {
        const normal = this.disposed || this.suspended ? emptyResolution() : next
        const effective = this.effectiveResolution(normal, element)
        const after = {
          ...effective,
          presentation: {
            ...effective.presentation,
            targets: effective.presentation.targets.filter((target) => names.has(target.name)),
          },
        }
        const before = this.receiver(element).resolution
        const change: LayerChange = {
          from: this.receiver(element).layers,
          to: this.runtimeLayers(normal),
        }
        const oldPresentation = composeRuntimeLayers(change.from, this.receiverId(element))
        const newPresentation = composeRuntimeLayers(change.to, this.receiverId(element))
        const from = {
          ...before,
          presentation: {
            ...oldPresentation,
            targets: oldPresentation.targets.filter((target) =>
              before.presentation.targets.some(
                (previousTarget) => previousTarget.name === target.name,
              ),
            ),
          },
        }
        const to = {
          ...after,
          presentation: {
            ...newPresentation,
            targets: newPresentation.targets.filter((target) => names.has(target.name)),
          },
        }
        const active = this.active.filter((entry) => entry.element === element)
        const preparation = prepareLayerChange({
          previous: from,
          next: to,
          values: this.values,
          active: active.map((entry) => ({ track: entry.track })),
          retargets: retargets,
        })
        const displayed = new Map<string, string>()
        const implicit = preparation.templates.filter((track) => track.implicitStart)

        if (implicit.length > 0) {
          const style = element.isConnected ? getComputedStyle(element) : element.style

          for (const track of implicit)
            displayed.set(workKey(track), style.getPropertyValue(track.property))
        }

        const affected = new Set(preparation.templates.map((track) => track.target))

        for (const target of after.presentation.targets) {
          if (
            target.properties.some((property) =>
              preparation.changed.has(layerPropertyKey(target.name, property.name)),
            )
          )
            affected.add(target.name)
        }

        const facts = after.presentation.targets
          .filter((target) => affected.has(target.name))
          .map((target) => ({
            target: target.name,
            addresses: this.declarationAddresses(after, element, target.name),
          }))
        const plan = planLayerChange(preparation, displayed, facts)
        const changed = plan.changed

        for (const message of plan.diagnostics) this.report({ code: 'runtime.endpoint', message })

        if (!this.motion.matches) {
          for (const { target, addresses } of facts) {
            for (const source of plan.tracks.filter((track) => track.target === target)) {
              changed.add(workKey(source))
              const timing = trackTiming(source)

              if (timing.durationMs === 0) continue

              for (const track of canonicalTracks(element, source)) {
                if (!ownsCanonicalProperty(addresses, source.property, track.property)) continue

                changed.add(workKey(track))
                const owner = after.presentation.targets
                  .find((candidateTarget) => candidateTarget.name === source.target)
                  ?.properties.find((property) => property.name === source.property)?.owner
                const operation =
                  [...this.operations].find((candidate) =>
                    candidate.layers.some((layer) => layer.id === owner),
                  ) ??
                  active.findLast(
                    (entry) => entry.track.property === track.property && !entry.group?.isFinished,
                  )?.operation ??
                  [...this.operations].findLast(
                    (candidate) =>
                      !candidate.group.isFinished &&
                      (candidate.bindings.get(this.receiverId(element))?.has(source.property) ||
                        candidate.bindings.get(this.receiverId(element))?.has(track.property)),
                  )
                const interrupted = active.some((entry) => entry.track.property === track.property)
                const needs = trackObservationNeeds(track, interrupted, true)
                const motion = needs.motion ? this.observeMotion(element, track) : undefined

                const trackPlan = planTrack(
                  {
                    id: nextEffectId++,
                    receiver: this.receiverId(element),
                    source,
                    track,
                    declarations: addresses,
                    displayed: needs.displayed
                      ? (element.isConnected
                          ? getComputedStyle(element)
                          : element.style
                        ).getPropertyValue(track.property)
                      : undefined,
                    interrupted,
                    motion,
                    reference: this.referenceValue(
                      element,
                      source.property,
                      source.destinationValue,
                      trackObservationNeeds(source, false, false).endpoint,
                    ),
                  },
                  timing,
                  'both',
                )

                if (trackPlan) {
                  const entry = this.prepareEffect(trackPlan, element)
                  entry.operation = operation
                  entry.group = operation?.group
                  prepared.push(entry)
                }
              }
            }
          }
        }

        const replacedIds = new Set(
          planEffectChanges(
            before,
            after,
            active.map((entry) => ({
              id: entry.id,
              target: entry.track.target,
              sourceProperty: entry.sourceProperty,
              property: entry.track.property,
              track: entry.track,
            })),
            retargets,
            facts,
          ),
        )

        for (const entry of active) if (replacedIds.has(entry.id)) replaced.add(entry)

        presentations.push({
          element,
          next: after,
          changed: plan.writes,
          removed: plan.removedProperties.size > 0,
        })
      }
    } catch (error) {
      for (const entry of prepared) entry.animation.cancel()

      this.pendingHandoffs.clear()
      throw error
    }

    const groups = new Set(
      [...replaced, ...prepared].flatMap((entry) => (entry.group ? [entry.group] : [])),
    )

    // Replacement membership is installed before cancellation can reject an old
    // finished promise. Only currently applicable IDs can settle a boundary.
    for (const group of groups)
      group.replace(
        [...replaced].filter((entry) => entry.group === group).map((entry) => entry.id),
        prepared.filter((entry) => entry.group === group).map((entry) => entry.id),
      )

    this.active = this.active.filter((entry) => !replaced.has(entry))

    for (const entry of replaced) entry.animation.cancel()

    this.layerResolution = next
    this.environment?.acceptPresentation(next)

    for (const presentation of presentations) {
      const { element, next: resolution, changed, removed } = presentation

      if (removed) this.restore(this.operations.size > 0, element)

      for (const target of resolution.presentation.targets) {
        for (const property of target.properties) {
          if (removed || changed.has(layerPropertyKey(target.name, property.name)))
            this.write(element, property.name, property.value)
        }
      }

      this.receiver(element).resolution = resolution
      this.receiver(element).layers = this.runtimeLayers(
        this.disposed || this.suspended ? emptyResolution() : next,
      )
    }

    this.pendingHandoffs.clear()
    this.active.push(...prepared)
    this.flushMotionSamples()

    for (const entry of prepared) {
      entry.animation.play()
      trackLayoutAnimation(entry.element, entry.track.property, entry.animation)
      this.propertyMotion.register(
        entry.element,
        entry.track.property,
        entry.animation,
        entry.trajectory,
      )
      void entry.animation.finished
        .then(() => {
          if (!this.active.includes(entry)) return undefined

          if (
            entry.reference !== undefined &&
            this.referenceValue(
              entry.element,
              entry.sourceProperty,
              entry.sourceDestination,
              trackObservationNeeds(entry.source, false, false).endpoint,
            ) !== entry.reference
          ) {
            this.refreshReferences()

            return undefined
          }

          entry.animation.cancel()
          this.active = this.active.filter((item) => item !== entry)

          if (entry.group) entry.group.settle(entry.id, 'completed')
          else {
            this.write(entry.element, entry.sourceProperty, entry.sourceDestination)
            this.settle(entry.element)
            this.propertyMotion.beginControl(entry.element, entry.track.property, performance.now())
          }

          return undefined
        })
        .catch((error) => {
          if (!this.active.includes(entry)) return

          this.active = this.active.filter((item) => item !== entry)

          if (entry.group) {
            if (entry.group.settle(entry.id, 'failed')) entry.operation?.report(error)
          } else this.report({ code: 'runtime.animation', message: String(error), error })
        })
    }

    this.scheduleReferences()
  }

  dispose() {
    this.releaseControllers()
    this.environment = undefined
    this.disposed = true

    this.cancelEnterSessions('owner-teardown')
    this.leaveSessions.clear()
    this.disconnectBindings()
    this.cancel()
    this.restore(this.operations.size > 0)
    // Teardown writes are not a new motion source, and must not retain receivers
    // unrelated to the continuing operation's work.
    this.dirtyProperties.clear()
    this.targetElements.clear()
    this.controllers.clear()

    if (this.operations.size === 0) this.stopMotion()

    this.scheduleReferences()
  }
}

/** Existing session adapter coordinates executor operations; it owns no native effects. */
export class PresencePlayback {
  private readonly group = new CompletionGroup()
  private readonly operations: { executor: PresentationExecutor; operation: PresenceOperation }[] =
    []
  private work: readonly LifecycleWork[]
  private readonly registered = new Set<LifecycleWork>()
  private initialized = false
  private started = false
  private ended = false
  private readonly resolve: (result: CompletionResult) => void
  readonly finished: Promise<CompletionResult>
  private readonly phase: 'enter' | 'leave'
  private readonly report: (error: unknown) => void

  constructor(
    work: readonly LifecycleWork[],
    phase: 'enter' | 'leave',
    report: (error: unknown) => void,
  ) {
    this.work = [...work]
    this.phase = phase
    this.report = report
    let complete: ((result: CompletionResult) => void) | undefined
    this.finished = new Promise((resolve) => {
      complete = resolve
    })
    // Promise's executor runs synchronously before construction returns.
    this.resolve = complete!
    void this.group.finished.then((result) => this.end(result))
  }

  get isFinished() {
    return this.ended
  }

  owns(element: HTMLElement, property: string) {
    return (
      !this.ended &&
      this.work.some((item) => item.element === element && item.track.property === property)
    )
  }

  retain(executor: PresentationExecutor) {
    const work = this.work.filter((item) => !this.registered.has(item) && executor.receives(item))

    if (work.length === 0) return

    for (const item of work) this.registered.add(item)

    const operation = executor.createOperation(work, this.phase, this.group, this.report)
    this.operations.push({ executor, operation })
  }

  private prepare() {
    const batches = new Map<PresentationExecutor, LifecycleWork[]>()
    let detached: PresentationExecutor | undefined

    for (const item of this.work) {
      if (this.registered.has(item)) continue

      this.registered.add(item)
      let executor = item[lifecycleOrigin]?.executor

      if (!executor) {
        if (!detached) {
          // This owner has no definition/controller diagnostics. Its reports
          // are late native/reference failures, which retain the original error.
          detached = new PresentationExecutor((diagnostic) => this.report(diagnostic.error))
          detached.initializeDetached()
        }

        executor = detached
      }

      const items = batches.get(executor) ?? []
      items.push(item)
      batches.set(executor, items)
    }

    for (const [executor, work] of batches)
      this.operations.push({
        executor,
        operation: executor.createOperation(work, this.phase, this.group, this.report),
      })
  }

  private initializeOperations() {
    this.initialized = true
    this.prepare()

    for (const { executor, operation } of this.operations) executor.initializeOperation(operation)
  }

  initialize() {
    if (this.ended || this.initialized) return

    try {
      this.initializeOperations()
    } catch (error) {
      this.end('failed')
      this.report(error)
      throw error
    }
  }

  play() {
    if (this.ended || this.started) return

    this.started = true

    try {
      // Automatic initialization shares preparation, while play retains its
      // report-and-failed-result contract rather than exposing an initialize throw.
      if (!this.initialized) this.initializeOperations()

      for (const { executor, operation } of this.operations) executor.playOperation(operation)

      this.group.start()
    } catch (error) {
      this.end('failed')
      this.report(error)
    }
  }

  cancel(reason: 'superseded' | 'owner-teardown') {
    this.end(reason)
  }

  private end(result: CompletionResult) {
    if (this.ended) return

    this.ended = true
    if (result === 'superseded' || result === 'owner-teardown') this.group.cancel(result)
    else if (result === 'failed') this.group.fail()

    for (const { executor, operation } of this.operations) executor.endOperation(operation, result)

    this.operations.length = 0
    this.work = []
    this.registered.clear()
    this.resolve(result)
  }
}
