import type { Composition, LayerResolution } from '../composition/layers.ts'
import type { ResolvedTrack } from '../composition/resolve.ts'
import type { LetBindingGraph } from '../evaluation/let-bindings.ts'
import type { ReactiveNotification } from '../evaluation/events.ts'
import type { VariableValues } from '../evaluation/expression.ts'
import type { Definition } from '../model/definition.ts'

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
   * Evaluates a candidate definition's lets against current values for inspection
   * or preview. Preserves the live graph and accepted values, releases temporary
   * calls, and propagates evaluation errors.
   */
  readonly snapshotValues: (definition: Definition) => VariableValues

  /**
   * Advances the binding revision and discards queued updates before rebinding.
   * An in-flight update checks the revision after event callbacks and stops if stale.
   * Does not disconnect subscriptions or reevaluate values.
   */
  readonly invalidateBinding: () => void

  /**
   * Asks the executor to disconnect reactive calls, then reevaluates their detached
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
}

/**
 * Browser services used by Runtime. The graph's existing bind protocol is invoked
 * inside the executor; its elements and controller control results never return here.
 * Times use the performance clock in milliseconds. Controller resolution runs after
 * terminal writes, independently of notification-time evaluation snapshots.
 */
export interface ExecutionPort {
  /** Current binding validity; Runtime connects reactive calls only when not suspended. */
  readonly bindingFacts: BindingFacts

  /** Validates active lifecycle expressions against candidate values before presentation is accepted. */
  validatePresentation(values: VariableValues): void

  /** Retains accepted values and definition for lifecycle operations that outlive Runtime ownership. */
  retainEnvironment(values: VariableValues): void

  /** Retains the current resolved presentation for later writes/restoration; does not write styles. */
  initialize(resolution: LayerResolution): void

  /**
   * Configures all declared property controllers with their target/property and
   * shared motion history. Does not acquire live control. Invalid bindings throw.
   */
  configureControllers(definition: Definition, values: VariableValues): void

  /** Disconnects DOM-bound reactive calls while retaining the graph and its cached call values. */
  disconnectBindings(): void

  /**
   * Binds graph subscriptions to current target elements and retains their cleanups.
   * notify requests subsequent Runtime updates; bind-time notifications are deferred.
   * Binding failures propagate. Runtime reevaluates the graph after connection.
   */
  connectBindings(
    graph: LetBindingGraph,
    notify: (notification?: ReactiveNotification) => void,
  ): void

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

  /**
   * Returns a resolution with controller bindings rendered in receiver-specific
   * cascade order. Unreadable controllers reveal a normal declaration if present,
   * otherwise omit the property. Does not apply returned CSS values to the DOM.
   * definition defaults to the attached environment's definition; live defaults to
   * true and acquires/releases ownership at time. false inspects without changing
   * ownership. time uses performance-clock ms; live updates run after terminalControls.
   * Expression evaluation or invalid controller capabilities may throw.
   */
  controllerResolution(
    resolution: LayerResolution,
    values: VariableValues,
    time: number,
    definition?: Definition,
    live?: boolean,
  ): LayerResolution

  /**
   * Uses accepted environment values to plan changes from previous to next.
   * Prepares replacement effects before cancelling affected old effects; preparation
   * failures throw. On acceptance, retains next and calls acceptPresentation before
   * writing styles/starting effects. Unaffected effects and lifecycle-owned styles
   * are preserved; suspended execution accepts next without applying it to the DOM.
   */
  applyLayerResolution(previous: LayerResolution, next: LayerResolution): void

  /** Ends an active preview and restores the accepted presentation; otherwise does nothing. */
  endCompositionPreview(): void

  /**
   * Applies retained presentation values except properties owned by enter/leave
   * sessions, then records motion samples. Does nothing when suspended or disposed.
   */
  settle(): void

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

/** Internal compatibility key; payloads stay on the existing DOM-bearing lifecycle adapter. */
export const lifecycleOrigin = Symbol('liva.lifecycle-origin')
