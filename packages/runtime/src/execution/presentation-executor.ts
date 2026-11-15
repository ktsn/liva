import {
  coordinatePresencePresentation,
  coordinateOperationEnd,
  coordinateOperationExclusions,
  coordinateMotionChange,
} from './presentation-coordinator.ts'
import { materializeEffect } from './native-effect.ts'
import type {
  PresentationPlan,
  PresentationFacts,
  ReceiverAddresses,
  ControllerBinding,
  StyleWrite,
  TrackCandidate,
  TrackObservationRequest,
  TrackSnapshot,
  LifecycleFacts,
} from './presentation-planner.ts'
import type {
  DisplayedRequest,
  DisplayedValue,
  PresencePreparation,
  ReleasedPresence,
} from './execution-contracts.ts'
import {
  trackObservationNeeds,
  remainingTrackFacts,
  type TrackComponentFacts,
  type TrackPlan,
  orderedResolution,
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
} from '../composition/runtime-layers.ts'
import type { BindingFacts, ExecutionEnvironment } from './execution-contracts.ts'
import {
  propertyReference,
  propertyAddresses,
  canonicalTracks,
  canonicalTrackFacts,
} from '../motion/property-codec.ts'
import { propertyRule } from '../motion/property-rules.ts'
import { propertyController, type PropertyController } from '../motion/controllers.ts'
import type { ReactiveNotification } from '../evaluation/events.ts'
import {
  layerPropertyDiffers,
  type LayerProperty,
  layerTargets,
  type LayerResolution,
  type LayerTrackTemplate,
} from '../composition/layers.ts'
export { waapiProperty } from '../motion/animation.ts'
import { LetBindingGraph } from '../evaluation/let-bindings.ts'
import { evaluate, renderTransition, type VariableValues } from '../evaluation/expression.ts'
import type { Definition, Transition } from '../model/definition.ts'
import { type ResolvedTrack } from '../composition/resolve.ts'
import { captureLifecycleDefinition, hasLifecycle } from '../composition/runtime-layers.ts'
import type { LifecycleSession, LifecycleWork } from './lifecycle.ts'
import type { RenderedState } from '../model/presentation.ts'
import { trackLayoutAnimation } from '../layout/layout-scheduler.ts'
import {
  PropertyMotion,
  type MotionSample,
  type MotionObservation,
} from '../motion/property-motion.ts'

/** Compatibility callback adapter; new pure normalization receives captured values only. */
export function resolveLifecycleTracks(
  phase: 'enter' | 'leave',
  transition: Transition | undefined,
  state: RenderedState,
  presentation: (target: string, property: string) => string | undefined,
): ResolvedTrack[] {
  const tracks: ResolvedTrack[] = []

  for (const target of transition?.targets ?? []) {
    for (const property of target.properties) {
      const displayed = presentation(target.name, property.name)

      if (displayed === undefined) continue

      tracks.push(
        ...normalizeLifecycleTracks(
          phase,
          { ...transition, targets: [{ ...target, properties: [property] }] },
          state,
          new Map([[`${target.name}\0${property.name}`, displayed]]),
        ),
      )
    }
  }

  return tracks
}

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

/**
 * Reconstructs inline CSS from still-owned originals and later external edits.
 * Shared by restoration and new field acquisition; only detached CSSOM snapshots
 * are changed, preserving shorthand serialization and priorities on the receiver.
 */
function restoredInlineCss(
  { original, originalCss, pending, written }: OwnedElement,
  currentStyle: CSSStyleDeclaration,
  current: ReadonlyMap<string, InlineValue>,
): string {
  const baseline = document.createElement('div')
  const external = document.createElement('div')
  baseline.style.cssText = originalCss
  external.style.cssText = currentStyle.cssText
  const stillOwned = new Set<string>()

  // Pending shorthand signatures read the stable observation while external is
  // pruned field by field. Removing one field must not change later ownership tests.
  for (const [property, last] of written) {
    const value = current.get(property) ?? { value: '', priority: '' }
    const signature = pending.get(property)
    const pendingChanged =
      signature !== undefined &&
      (currentStyle.getPropertyValue(signature.property) !== signature.value ||
        currentStyle.getPropertyPriority(signature.property) !== signature.priority)

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
  return baseline.style.cssText + ';' + external.style.cssText
}

let nextEffectId = 0
let nextOperationId = 0

export interface CapturedPresence {
  readonly receiver: Receiver
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

interface PresenceSource {
  readonly item: LifecycleWork
  readonly receiver: number
  readonly property: LayerProperty
  readonly track: ResolvedTrack
  readonly canonical: readonly TrackComponentFacts[]
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
  sources: readonly PresenceSource[]
  normal: LayerResolution
  started: boolean
  initialized: boolean
  readonly receivers: ReadonlyMap<LifecycleWork, Receiver>
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

function hasControllerBindings(resolution: LayerResolution) {
  return resolution.presentation.targets.some((target) =>
    target.properties.some((property) => property.binding),
  )
}

type Receiver = {
  readonly id: number
  readonly element: HTMLElement
  resolution: LayerResolution
  layers: readonly EvaluatedLayer[]
}

type ActiveTrack = {
  id: number
  receiver: Receiver
  track: ResolvedTrack
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

  private readonly receivers = new Map<number, Receiver>()
  private nextReceiverId = 0

  private receiverRegistration(retain: boolean) {
    const byElement = new Map(
      [...this.receivers.values()].map((receiver) => [receiver.element, receiver]),
    )

    return (element: HTMLElement, captured?: Receiver): Receiver => {
      const previous = byElement.get(element)
      // Captured origins are created from this same LifecycleWork element.
      const receiver = previous ??
        captured ?? {
          id: this.nextReceiverId++,
          element,
          resolution: emptyResolution(),
          layers: [],
        }
      byElement.set(element, receiver)

      if (retain) this.receivers.set(receiver.id, receiver)

      return receiver
    }
  }

  private receiver(id: number): Receiver {
    // Synchronous plans address either current bindings or retained presence work.
    return this.receivers.get(id)!
  }

  private receivingElement(id: number): HTMLElement {
    return this.receiver(id).element
  }

  private pruneReceivers() {
    const retained = new Set([...this.targetReceivers.values()].flat())

    for (const operation of this.operations) {
      for (const receiver of operation.receivers.values()) retained.add(receiver)
    }

    for (const [id, receiver] of this.receivers) {
      if (!retained.has(receiver)) this.receivers.delete(id)
    }
  }

  private replaceReceivers(targets: ReadonlyMap<string, TargetElements>) {
    this.targetReceivers.clear()
    this.pruneReceivers()
    const register = this.receiverRegistration(true)

    for (const [name, elements] of targets) {
      const [first, ...rest] = elements
      this.targetReceivers.set(name, [register(first), ...rest.map((element) => register(element))])
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
      source: plan.source,
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

  private operationExclusions(
    operation: PresenceOperation,
    normal: LayerResolution,
  ): ReadonlySet<string> {
    const facts = {
      phase: operation.phase,
      started: operation.started,
      excluded: operation.excluded,
      previous: operation.normal,
      sources: operation.sources.map((source) => ({
        receiver: source.receiver,
        target: source.item.track.target,
      })),
    }

    return this.environment
      ? this.environment.operationExclusions(facts, normal)
      : coordinateOperationExclusions(this, facts, normal)
  }

  validatePresentation(values: VariableValues, candidate: LayerResolution) {
    let projectedCandidate: LayerResolution | undefined

    for (const operation of this.operations) {
      if (operation.group.isFinished) continue

      const captures = operation.sources.flatMap((source) => {
        const capture = source.item[lifecycleOrigin]

        return capture && capture.environment.definition === this.definition
          ? [{ source, capture }]
          : []
      })

      if (captures.length === 0) continue

      // Candidate applicability uses the already-selected layers and supplied
      // controller snapshots. This is a local logical projection, not a displayed
      // observation, and it is discarded before terminal writes/ownership changes.
      if (operation.phase === 'enter' && operation.started) {
        if (!projectedCandidate) {
          // Logical/physical ownership follows the final declaration owners, not
          // the cascade map's first-insertion order. Match accepted application.
          const ordered = orderedResolution(candidate, this.definition)
          projectedCandidate = hasControllerBindings(ordered)
            ? this.controllerBaseline(ordered, values, this.definition).provisional
            : ordered
        }
      }

      const excluded = this.operationExclusions(operation, projectedCandidate ?? candidate)

      for (const { source, capture } of captures) {
        if (remainingTrackFacts(source.receiver, source.canonical, excluded).length > 0)
          this.renderOperation(capture.source, values, [source.item])
      }
    }
  }

  private updateOperations(
    normal: LayerResolution,
    values = this.values,
    retargets: ReadonlySet<string> = new Set(),
  ) {
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

      // Only accepted application updates commit these exclusions. Rejected
      // candidate validation above leaves operation state and history untouched.
      for (const property of this.operationExclusions(operation, normal))
        operation.excluded.add(property)

      operation.normal = normal
      const layers: EvaluatedLayer[] = []
      const sources: PresenceSource[] = []
      const previousSources = new Map(operation.sources.map((source) => [source.item, source]))

      for (const [item, held] of operation.held) {
        const previous = previousSources.get(item)

        if (
          previous &&
          remainingTrackFacts(previous.receiver, previous.canonical, operation.excluded).length ===
            0
        ) {
          sources.push(previous)

          continue
        }

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

        const receiver = operation.receivers.get(item)!.id
        const id = `@presence:${operation.id}:${workKey(item.track)}`
        const property = trackLayer(id, receiver, [track], !operation.started).targets[0]
          .properties[0]
        const retarget = previous?.canonical.some((fact) =>
          retargets.has(layerPropertyKey(fact.track.target, fact.track.property)),
        )
        // Cache only derived normalization for identical evaluated data. A source
        // change or reference refresh observes current writing context again;
        // ordinary no-op updates do not add CSSOM reads.
        const canonical =
          previous && !layerPropertyDiffers(previous.property, property) && !retarget
            ? previous.canonical
            : canonicalTrackFacts(item.element, track)
        sources.push({ item, receiver, property, track, canonical })
        layers.push(
          trackLayer(
            id,
            receiver,
            remainingTrackFacts(receiver, canonical, operation.excluded).map((fact) => fact.track),
            !operation.started,
            track,
          ),
        )
      }

      operation.layers = layers
      operation.sources = sources
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

  private receiverNames(receiver: Receiver): ReadonlySet<string> {
    const names = new Set(
      [...this.targetReceivers]
        .filter(([, receivers]) => receivers.includes(receiver))
        .map(([name]) => name),
    )

    for (const operation of this.operations)
      for (const item of operation.work)
        if (operation.receivers.get(item) === receiver) names.add(item.track.target)

    return names
  }

  private effectiveResolution(normal: LayerResolution, receiver: Receiver): LayerResolution {
    const names = this.receiverNames(receiver)
    const presentation = composeRuntimeLayers(this.runtimeLayers(normal), receiver.id)

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
      (this.targetReceivers
        .get(item.track.target)
        ?.some((receiver) => receiver.element === item.element) ??
        false)
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
    const register = this.receiverRegistration(true)
    const receivers = new Map(
      work.map((item) => [item, register(item.element, item[lifecycleOrigin]?.receiver)]),
    )
    const bindings = new Map<number, Set<string>>()

    for (const item of work) {
      const receiver = receivers.get(item)!.id
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
      sources: [],
      normal: this.layerResolution,
      started: false,
      initialized: false,
      held,
      receivers,
    }
    this.operations.add(operation)

    // The caller receives cleanup ownership only after normalization succeeds.
    // Undo this registration if live phase inputs cannot prepare the operation.
    try {
      if (this.disposed && this.operations.size === 1) this.listenMotion()

      this.updateOperations(this.layerResolution)
    } catch (error) {
      this.operations.delete(operation)
      this.pruneReceivers()

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

    for (const { item, track } of operation.sources) {
      this.write(item.element, item.track.property, track.keyframes[0].value)
      const receiver = operation.receivers.get(item)!
      receiver.resolution = this.effectiveResolution(this.layerResolution, receiver)
      receiver.layers = this.runtimeLayers(this.layerResolution)
    }
  }

  private retainHandoffs(operation: PresenceOperation) {
    for (const item of operation.work) {
      const capture = item[lifecycleOrigin]

      if (!capture) continue

      for (const [key, observation] of capture.motion) {
        const receiver = operation.receivers.get(item)!
        const address = key.slice(key.indexOf('\0'))
        this.pendingHandoffs.set(`${receiver.id}${address}`, observation)
      }
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
    if (this.environment) this.environment.operationEnded(operation.id, result)
    else coordinateOperationEnd(this, this.layerResolution, this.values, operation.id, result)
  }

  releasePresence(id: number): ReleasedPresence {
    // Completion groups identify an operation still registered by this executor.
    const operation = [...this.operations].find((candidate) => candidate.id === id)!
    this.operations.delete(operation)

    for (const item of operation.work) {
      const receiver = operation.receivers.get(item)!

      for (const key of item[lifecycleOrigin]?.motion.keys() ?? [])
        this.pendingHandoffs.delete(`${receiver.id}${key.slice(key.indexOf('\0'))}`)
    }

    return {
      phase: operation.phase,
      receivers: [...new Set(operation.receivers.values())].map((receiver) => ({
        id: receiver.id,
        names: [
          ...this.receiverNames(receiver),
          ...operation.work
            .filter((item) => operation.receivers.get(item) === receiver)
            .map((item) => item.track.target),
        ],
      })),
      work: operation.work.map((item) => ({
        receiver: operation.receivers.get(item)!.id,
        property: item.track.property,
        destination: item.track.destinationValue,
        restoreOnCompletion: item.restoreOnCompletion,
      })),
    }
  }

  observeReleasedReceiver(
    id: number,
    names: readonly string[],
    next: LayerResolution,
  ): PresencePreparation['receivers'][number] {
    const receiver = this.receiver(id)
    const normal = this.disposed || this.suspended ? emptyResolution() : next

    return {
      id,
      names: [...new Set(names)],
      normal,
      previous: receiver.resolution,
      from: receiver.layers,
      to: this.runtimeLayers(normal),
    }
  }

  finishPresenceRelease() {
    this.pruneReceivers()
    this.scheduleReferences()

    if (this.disposed && this.operations.size === 0) this.stopMotion()
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
    for (const [name, elements] of this.targetReceivers) {
      // bind creates each group with its first element, so every tuple is nonempty.
      yield [name, elements[elements.length - 1].element] as const
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

  /** Retains live ownership; already finished sessions and duplicate registrations are ignored. */
  retainLifecycle(phase: 'enter' | 'leave', session: LifecycleSession) {
    const sessions = phase === 'enter' ? this.enterSessions : this.leaveSessions

    if (session.isFinished || sessions.has(session)) return

    sessions.add(session)
    session.retain(this)

    void session.finished
      .then(() => {
        if (!sessions.has(session)) return undefined

        if (this.environment) this.environment.lifecycleSettled()
        else sessions.delete(session)

        return undefined
      })
      .catch((error) => this.report({ code: 'runtime.animation', message: String(error), error }))
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
    const register = this.receiverRegistration(false)
    const observations: { element: HTMLElement; receiver: Receiver; displayed: string }[] = []
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
        observations.push({ element: receiver, receiver: register(receiver), displayed: value })

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
              entry.receiver.element === item.element &&
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
        const key = `${item.receiver.id}\0${track.property}`

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
        receiver: item.receiver,
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
        entry.receiver.element === element &&
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
    observed = new Map<string, readonly string[]>(),
  ): DeclarationAddresses {
    const names = resolution.presentation.targets
      .filter((item) => item.name === target)
      .flatMap((item) => item.properties.map((property) => property.name))

    return [...new Set(names)].map((name) => {
      const previous = observed.get(name)
      const addresses = previous ?? propertyAddresses(element, name)
      observed.set(name, addresses)

      return { name, addresses }
    })
  }

  private controllerBaseline(
    resolution: LayerResolution,
    values: VariableValues,
    definition: Definition,
  ) {
    // Candidate validation belongs to the attached Runtime and never runs after disposal.
    return this.environment!.controllerBaseline(resolution, values, definition)
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
    // Live callers are attached; detached operations use their retained evaluated layers.
    return this.environment!.controllerResolution(resolution, values, time, definition, live)
  }

  updatePresence(resolution: LayerResolution, values: VariableValues) {
    this.updateOperations(resolution, values)
  }

  private nextSessionId = 0
  private readonly sessionIds = new WeakMap<LifecycleSession, number>()

  private sessionId(session: LifecycleSession) {
    let id = this.sessionIds.get(session)

    if (id === undefined) {
      id = this.nextSessionId++
      this.sessionIds.set(session, id)
    }

    return id
  }

  /** Metadata has no live style values; Runtime chooses which CSS observations follow. */
  presentationFacts(_resolution: LayerResolution): PresentationFacts {
    const receivers = [...this.targetReceivers].flatMap(([target, bindings]) =>
      bindings.map((receiver) => ({ id: receiver.id, target })),
    )
    const lifecycle: LifecycleFacts[] = [
      ...[...this.enterSessions].map((session) => ({
        id: this.sessionId(session),
        phase: 'enter' as const,
        finished: session.isFinished,
        managed: true,
        protected: [],
      })),
      ...[...this.leaveSessions].map((session) => ({
        id: this.sessionId(session),
        phase: 'leave' as const,
        finished: session.isFinished,
        managed: true,
        protected: [],
      })),
    ]

    return {
      mode: this.presentationMode,
      lifecycle,
      suspended: this.suspended,
      reduced: this.motion.matches,
      preserveLifecycle: lifecycle.length > 0,
      receivers: receivers.map((receiver) => ({
        ...receiver,
        // Normalized presence ownership is represented by effective runtime layers.
        protected: [],
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
            const element = this.receivingElement(receiver.id)

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

  expandTracks(
    tracks: readonly {
      readonly receiver: number
      readonly source: ResolvedTrack
      readonly declarations?: ReceiverAddresses['addresses']
    }[],
  ): readonly TrackCandidate[] {
    return tracks.flatMap(({ receiver, source, declarations }) => {
      const element = this.receivingElement(receiver)

      return canonicalTracks(element, source).map((track) => ({
        receiver,
        source,
        track,
        declarations: declarations ?? [
          { name: source.property, addresses: propertyAddresses(element, source.property) },
        ],
        protected: false,
      }))
    })
  }

  observeDisplayed(requests: readonly DisplayedRequest[]): readonly DisplayedValue[] {
    const styles = new Map<number, CSSStyleDeclaration>()

    return requests.map((request) => {
      let style = styles.get(request.receiver)

      if (!style) {
        style = getComputedStyle(this.receivingElement(request.receiver))
        styles.set(request.receiver, style)
      }

      return { ...request, value: style.getPropertyValue(request.property) }
    })
  }

  observeTracks(requests: readonly TrackObservationRequest[]): readonly TrackSnapshot[] {
    return requests.map((request) => {
      const element = this.receivingElement(request.receiver)
      const captured = request.needs.motion
        ? this.pendingHandoffs.get(`${request.receiver}\0${request.track.property}`)
        : undefined

      return {
        handoff: captured ? { captured, time: performance.now() } : undefined,
        id: nextEffectId++,
        receiver: request.receiver,
        source: request.source,
        track: request.track,
        declarations: request.declarations,
        interrupted: request.interrupted,
        displayed: request.needs.displayed
          ? (element.isConnected ? getComputedStyle(element) : element.style).getPropertyValue(
              request.track.property,
            )
          : undefined,
        motion: request.needs.motion
          ? this.propertyMotion.observeSpring(
              element,
              request.track.property,
              request.needs.endpoint,
            )
          : undefined,
        reference: request.reference
          ? this.referenceValue(
              element,
              (request.source.authored ?? request.source).property,
              (request.source.authored ?? request.source).destinationValue,
              trackObservationNeeds(request.source.authored ?? request.source, false, false)
                .endpoint,
            )
          : undefined,
      }
    })
  }

  preparePresence(
    next: LayerResolution,
    values: VariableValues,
    retargets: ReadonlySet<string>,
  ): PresencePreparation {
    this.updateOperations(next, values, retargets)
    const receivers = new Map<Receiver, Set<string>>()

    for (const [name, bindings] of this.targetReceivers) {
      for (const receiver of bindings) {
        const names = receivers.get(receiver) ?? new Set<string>()
        names.add(name)
        receivers.set(receiver, names)
      }
    }

    for (const operation of this.operations) {
      for (const item of operation.work) {
        const receiver = operation.receivers.get(item)!
        const names = receivers.get(receiver) ?? new Set<string>()
        names.add(item.track.target)
        receivers.set(receiver, names)
      }
    }

    const normal = this.disposed || this.suspended ? emptyResolution() : next

    return {
      reduced: this.motion.matches,
      preserve: this.operations.size > 0,
      receivers: [...receivers].map(([receiver, names]) => ({
        id: receiver.id,
        names: [...names],
        normal,
        previous: receiver.resolution,
        from: receiver.layers,
        to: this.runtimeLayers(normal),
      })),
      active: this.active.map((entry) => ({
        id: entry.id,
        receiver: entry.receiver.id,
        target: entry.track.target,
        property: entry.track.property,
        sourceProperty: entry.sourceProperty,
        sourceDestination: entry.sourceDestination,
        track: entry.track,
        operation: entry.operation?.id,
        finished: entry.group?.isFinished,
      })),
      operations: [...this.operations].map((operation) => ({
        id: operation.id,
        finished: operation.group.isFinished,
        layers: operation.layers.map((layer) => layer.id),
        bindings: [...operation.bindings].map(([receiver, properties]) => ({
          receiver,
          properties: [...properties],
        })),
      })),
    }
  }

  observeReceiverStarts(receiver: number, templates: readonly LayerTrackTemplate[]) {
    const element = this.receivingElement(receiver)
    const implicit = templates.filter((track) => track.implicitStart)
    const displayed = new Map<string, string>()

    if (implicit.length > 0) {
      const style = element.isConnected ? getComputedStyle(element) : element.style

      for (const track of implicit)
        displayed.set(workKey(track), style.getPropertyValue(track.property))
    }

    return displayed
  }

  observeReceiverAddresses(
    receiver: number,
    resolution: LayerResolution,
    targets: ReadonlySet<string>,
  ) {
    const element = this.receivingElement(receiver)

    return resolution.presentation.targets
      .filter((target) => targets.has(target.name))
      .map((target) => ({
        target: target.name,
        addresses: this.declarationAddresses(resolution, element, target.name),
      }))
  }

  observeTakeoverAddresses(
    previous: LayerResolution,
    next: LayerResolution,
    sources: readonly { readonly receiver: number; readonly target: string }[],
  ) {
    const unique = new Map(
      sources.map((source) => [`${source.receiver}\0${source.target}`, source]),
    )

    return [...unique.values()].map((source) => {
      const element = this.receivingElement(source.receiver)
      const observed = new Map<string, readonly string[]>()

      return {
        ...source,
        previous: this.declarationAddresses(previous, element, source.target, observed),
        next: this.declarationAddresses(next, element, source.target, observed),
      }
    })
  }

  abortPresencePlanning() {
    this.pendingHandoffs.clear()
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
        entry.receiver.element,
        entry.source.property,
        entry.source.destinationValue,
        trackObservationNeeds(entry.source, false, false).endpoint,
      )

      if (next !== entry.reference)
        retargets.add(layerPropertyKey(entry.track.target, entry.sourceProperty))
    }

    if (retargets.size > 0) {
      try {
        if (this.environment) this.environment.retarget(retargets)
        else this.applyLayerChange(this.layerResolution, this.layerResolution, retargets)
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
    if (this.environment) this.environment.motionChanged()
    else coordinateMotionChange(this, this.layerResolution, this.values, this.report)
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
    if (!this.active.some((entry) => entry.group)) this.propertyMotion.reset(this.disposed)

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

    // CSSOM enumerates affected fields, including shorthand side effects.
    const changed = [...new Set([...before.keys(), ...after.keys()])].filter((name) => {
      const previous = before.get(name)
      const next = after.get(name)

      return (
        pendingNames.has(name) ||
        previous?.value !== next?.value ||
        previous?.priority !== next?.priority
      )
    })

    if (changed.some((name) => !owned.written.has(name))) {
      // A newly acquired field starts a fresh ownership epoch. Reconstruct the
      // pre-write baseline with the same external-edit rules as restoration,
      // retaining originals only for fields that stayed continuously owned.
      const baseline = document.createElement('div')
      baseline.style.cssText = beforeCss
      baseline.style.cssText = restoredInlineCss(owned, baseline.style, before)
      owned.originalCss = baseline.style.cssText
      owned.original = inlineDeclarations(baseline)
    }

    for (const name of changed) {
      owned.written.set(name, after.get(name) ?? { value: '', priority: '' })

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

    const dirty = this.dirtyProperties.get(element) ?? new Set<string>()
    dirty.add(property)
    this.dirtyProperties.set(element, dirty)
  }

  private lifecycleProperties(element: HTMLElement): ReadonlySet<string> {
    const receivers = new Set(
      [...this.operations].flatMap((operation) =>
        [...operation.receivers.values()]
          .filter((receiver) => receiver.element === element)
          .map((receiver) => receiver.id),
      ),
    )

    return new Set(
      [...this.operations]
        .filter((operation) => !operation.group.isFinished)
        .flatMap((operation) =>
          operation.layers
            .filter(
              (layer) =>
                layer.scope === 'all' || layer.scope.some((receiver) => receivers.has(receiver)),
            )
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
          .filter((entry) => entry.receiver.element === element)
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

    for (const owned of this.owned) {
      const { element, written } = owned

      if (receivingElement && element !== receivingElement) continue

      const dirty = this.dirtyProperties.get(element) ?? new Set<string>()
      for (const property of written.keys()) dirty.add(property)
      this.dirtyProperties.set(element, dirty)

      element.style.cssText = restoredInlineCss(owned, element.style, inlineDeclarations(element))
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

  /** Requests reconciliation after binding or ending a preview on the attached Runtime. */
  private settle() {
    // All callers are binding/preview APIs; detached retained presence uses the coordinator.
    this.environment!.reconcile()
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
    if (!this.active.some((entry) => entry.group)) this.propertyMotion.reset()

    this.dirtyProperties.clear()
    this.cancel(false)
    this.restore(this.enterSessions.size > 0)
    this.replaceReceivers(next)
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

  beginPreview(writes: readonly StyleWrite[]) {
    for (const controller of this.controllers.keys()) controller.setPreview(true)

    this.cancel(true, true)
    this.restore()
    this.dirtyProperties.clear()
    this.presentationMode = 'preparing-preview'
    this.applyWrites(writes)
  }

  abortPreview() {
    this.cancel()
    this.restore()
    this.settle()
  }

  private applyWrites(writes: readonly StyleWrite[]) {
    for (const write of writes)
      this.write(this.receivingElement(write.receiver), write.property, write.value)
  }

  endCompositionPreview(): void {
    if (this.presentationMode === 'live') return

    this.cancel()
    this.restore(this.operations.size > 0)
    this.settle()
    this.scheduleReferences()
  }

  applyLayerResolution(previous: LayerResolution, next: LayerResolution) {
    this.applyLayerChange(previous, next, new Set())
  }

  private applyLayerChange(
    previous: LayerResolution,
    next: LayerResolution,
    retargets: ReadonlySet<string>,
  ) {
    coordinatePresencePresentation(this, next, this.values, retargets, this.report)
  }

  applyPlan(plan: PresentationPlan) {
    const prepared: ActiveTrack[] = []

    try {
      for (const track of plan.start) {
        const entry = this.prepareEffect(track, this.receiver(track.receiver))
        const operation = [...this.operations].find((candidate) => candidate.id === track.operation)
        entry.operation = operation
        entry.group = operation?.group
        prepared.push(entry)
      }
    } catch (error) {
      for (const entry of prepared) entry.animation.cancel()

      this.pendingHandoffs.clear()
      throw error
    }

    if (plan.lifecycle) {
      for (const sessions of [this.enterSessions, this.leaveSessions]) {
        for (const session of sessions) {
          const id = this.sessionId(session)

          if (plan.lifecycle.release.includes(id)) sessions.delete(session)
        }
      }
    }

    const cancelled = new Set(plan.cancel)
    const replaced = new Set(this.active.filter((entry) => cancelled.has(entry.id)))

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

    if (plan.mode === 'live') {
      this.layerResolution = plan.resolution
      this.environment?.acceptPresentation(plan.resolution)
    }

    if (plan.restore) this.restore(plan.preserveLifecycle)

    for (const presentation of plan.presentations ?? []) {
      const receiver = this.receiver(presentation.receiver)

      if (presentation.restore) this.restore(presentation.preserveLifecycle, receiver.element)

      receiver.resolution = presentation.resolution
      receiver.layers = presentation.layers
    }

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

    this.pendingHandoffs.clear()
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
              this.referenceValue(
                entry.receiver.element,
                entry.source.property,
                entry.source.destinationValue,
                trackObservationNeeds(entry.source, false, false).endpoint,
              ) !== entry.reference
            ) {
              this.refreshReferences()

              return undefined
            }

            if (entry.group) {
              entry.animation.cancel()
              this.active = this.active.filter((item) => item !== entry)
              entry.group.settle(entry.id, 'completed')
            } else {
              // Non-presence effects belong to an attached Runtime; disposal cancels them first.
              this.environment!.completeEffect(entry.id)
              this.propertyMotion.beginControl(
                entry.receiver.element,
                entry.track.property,
                performance.now(),
              )
            }

            return undefined
          },
          (error) => {
            if (this.active.includes(entry)) this.failTrack(entry, error)
          },
        )
        .catch((error) => this.failTrack(entry, error))
    }

    this.scheduleReferences()
  }

  /** Native failures release effect membership before reporting, including completion callbacks. */
  private failTrack(entry: ActiveTrack, error: unknown) {
    this.active = this.active.filter((item) => item !== entry)
    entry.animation.cancel()

    if (entry.group) {
      // Group membership is assigned only with its owning presence operation.
      if (entry.group.settle(entry.id, 'failed')) entry.operation!.report(error)
    } else this.report({ code: 'runtime.animation', message: String(error), error })
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
    this.targetReceivers.clear()
    this.pruneReceivers()
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
