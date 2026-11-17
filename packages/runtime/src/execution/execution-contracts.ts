import type { Composition, LayerResolution } from '../composition/layers.ts'
import type { ResolvedTrack } from '../composition/resolve.ts'
import type { SourceConnection } from '../evaluation/reactive-value.ts'
import type { VariableValues } from '../evaluation/expression.ts'
import type { Definition } from '../model/definition.ts'
import type {
  ControllerBinding,
  PresentationFacts,
  PresentationPlan,
  ReceiverAddresses,
  StyleWrite,
  TrackCandidate,
  TrackObservationRequest,
  TrackSnapshot,
} from './presentation-planner.ts'

export { layerPropertyKey } from '../model/presentation.ts'

/** Explicit displayed-value requests; all receivers must belong to the current binding. */
export interface DisplayedRequest {
  readonly receiver: number
  readonly property: string
}

export interface DisplayedValue extends DisplayedRequest {
  readonly value: string
}

export interface RuntimeDiagnostic {
  /** Operation category, such as runtime.expression or runtime.animation. */
  readonly code: string

  /** Human-readable description of the failure. */
  readonly message: string

  /** Resolved animation instruction associated with the failure, when available. */
  readonly track?: ResolvedTrack

  /** Original failure, or a wrapper retaining the original failure through cause. */
  readonly error?: unknown
}

/** Logical facts about bindings; receiving elements remain owned by the executor. */
export interface BindingFacts {
  /**
   * Whether invalid duplicate bindings or missing required targets suspend live
   * presentation and reactive-call connection. Lifecycle targets may be absent.
   */
  readonly suspended: boolean
}

/** Evaluation callbacks carry accepted environments, never browser observations. */
export interface ExecutionEnvironment {
  /** Returns Runtime's current definition, including direct assignments and replacements. */
  readonly definition: () => Definition

  /** Returns accepted inputs and evaluated let values; does not reevaluate or sample the DOM. */
  readonly values: () => VariableValues

  /**
   * Advances the binding revision and discards queued updates before rebinding.
   * An in-flight update checks the revision after event callbacks and stops if stale.
   * Does not disconnect subscriptions or reevaluate values.
   */
  readonly invalidateBinding: () => void

  /**
   * Disconnects the store through executor-owned cleanups, then reevaluates detached
   * values. Call after releasing controllers that still need their receiving elements.
   * Evaluation failures are reported while retaining the previous accepted values.
   */
  readonly clearBindings: () => void

  /**
   * Resolves layers after the executor replaces its target bindings and initializes
   * its presentation. advance permits a state-machine step when disconnection changed
   * values. If not suspended, also reconnects calls through the executor, reevaluates
   * values/event baselines, and resolves controller ownership before reinitializing.
   */
  readonly rebound: (advance: boolean) => void

  /**
   * Stores the executor's accepted resolution as Runtime's current composition/state
   * history. Called after replacement effects are prepared, before new styles are
   * written. Does not reevaluate expressions or emit update/event callbacks.
   */
  readonly acceptPresentation: (resolution: LayerResolution) => void

  /** Requests planned application of the accepted cascade after browser-owned restoration. */
  readonly reconcile: () => void

  /** Reports media-query changes; Runtime/planner decide preservation, cancellation, and restoration. */
  readonly motionChanged: () => void

  /** Recomputes controller ownership from accepted inputs, without sampling calls or advancing events/states. */
  readonly refreshOwnership: () => void

  /** Reports a registered session settling; Runtime/planner decide releases and presentation recovery. */
  readonly lifecycleSettled: () => void
}

/**
 * Browser services used by Runtime. Source adapters bind inside the executor;
 * elements and controller control results never return here.
 * Times use the performance clock in milliseconds. Controller resolution runs after
 * terminal writes, independently of notification-time evaluation snapshots.
 */
export interface ExecutionPort {
  /** Observe, plan and publish a common evaluated-layer change for current receivers. */
  present(
    previous: LayerResolution,
    next: LayerResolution,
    values: VariableValues,
    retargets?: ReadonlySet<string>,
  ): void

  /** Validate still-applicable presence expressions before reactive calls/events are accepted. */
  validatePresence(previous: LayerResolution, next: LayerResolution, values: VariableValues): void

  /** Retain accepted inputs before subscription cleanup can change detached observations. */
  freezeEnvironment(detaching?: boolean): void

  /** Current binding validity; Runtime connects reactive calls only when not suspended. */
  readonly bindingFacts: BindingFacts

  /** Retains the current resolved presentation for later writes/restoration; does not write styles. */
  initialize(resolution: LayerResolution): void

  /**
   * Configures all declared property controllers with their target/property and
   * shared motion history. Does not acquire live control. Invalid bindings throw.
   */
  configureControllers(definition: Definition, values: VariableValues): void

  /** Connects source adapters to current receivers. Executor owns native cleanups. */
  readonly connectSource: SourceConnection

  /**
   * Releases current controller owners and hands their final input velocity to
   * motion history. time defaults to performance.now(); release before disconnecting
   * subscriptions, while receiving elements and control sessions remain available.
   */
  releaseControllers(time?: number): void

  /**
   * Ends previews, releases controllers, cancels ordinary effects and enter sessions,
   * restores owned styles while preserving external edits, and clears motion history.
   * Does not disconnect reactive calls or replace target bindings.
   */
  resetPresentation(): void

  /**
   * Writes current controller outputs and records dirty properties at time before
   * displayed transition endpoints are observed. time uses performance-clock ms.
   */
  terminalControls(time: number): void

  /** Rechecks required targets for definition, retaining the last bind's duplicate-binding status. */
  refreshSuspension(definition: Definition): void

  /** Current receiver/effect metadata and playback policy; performs no CSSOM reads. */
  presentationFacts(resolution: LayerResolution): PresentationFacts

  /**
   * Captures canonical addresses for selected targets, in declaration order.
   * Live observations include scoped presence ownership; isolated inspection and
   * preview use only the supplied ordinary resolution (live=false).
   */
  observeReceivers(
    resolution: LayerResolution,
    targets: ReadonlySet<string>,
    live: boolean,
  ): readonly ReceiverAddresses[]

  /**
   * Executes selected bindings in source order, then releases deselected old owners.
   * Returns only CSS values keyed by logical target/property. In preview/inspection,
   * formats supplied snapshots without acquiring/releasing or reading live control.
   * Caller must finish this phase before observing spring/displayed start values.
   */
  applyControllers(
    bindings: readonly ControllerBinding[],
    values: VariableValues,
    time: number,
    live: boolean,
  ): ReadonlyMap<string, string | undefined>

  /**
   * Browser CSS normalization only; ownership and interruption are decided by the planner.
   * Omitted declarations give each source its own scope, as required by lifecycle previews.
   */
  expandTracks(
    tracks: readonly {
      readonly receiver: number
      readonly source: ResolvedTrack
      readonly declarations?: ReceiverAddresses['addresses']
    }[],
  ): readonly TrackCandidate[]

  /** Reads exactly the requested displayed values, without advancing runtime state. */
  observeDisplayed(requests: readonly DisplayedRequest[]): readonly DisplayedValue[]

  /**
   * Captures requested start/motion/reference facts after terminal writes and controller
   * release. Results retain request order, source/track object identity, declaration
   * addresses, and interruption decisions; only observations and fresh effect IDs are added.
   */
  observeTracks(requests: readonly TrackObservationRequest[]): readonly TrackSnapshot[]

  /**
   * Materializes every start before cancelling old effects. On successful preparation,
   * notifies acceptPresentation before applying writes/playback. A preparation failure
   * cancels only newly prepared effects and leaves the accepted presentation unchanged.
   * Preview plans never publish ordinary composition and start paused at time zero.
   */
  applyPlan(plan: PresentationPlan): void

  /** Freezes controller snapshots, clears old preview/live effects, and writes the planned baseline. */
  beginPreview(writes: readonly StyleWrite[]): void

  /** Restores application presentation after preview evaluation, observation, or preparation failed. */
  abortPreview(): void

  /** Ends an active preview and restores the accepted presentation; otherwise does nothing. */
  endCompositionPreview(): void

  /**
   * Releases subscriptions, controllers, effects, motion history, target references,
   * and media-query observation, restoring owned styles. Cancels enter sessions;
   * independent leave sessions continue. Runtime guards repeated disposal.
   */
  dispose(): void
}

/** Copies layer activation and state selections without reevaluation or exposing mutable internal records. */
export function compositionSnapshot(composition: Composition): Composition {
  return { layers: { ...composition.layers }, states: { ...composition.states } }
}
