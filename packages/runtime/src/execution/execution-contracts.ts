import type { Composition, LayerResolution } from '../composition/layers.ts'
import type { ResolvedTrack } from '../composition/resolve.ts'
import type { LetBindingGraph } from '../evaluation/let-bindings.ts'
import type { ReactiveNotification } from '../evaluation/events.ts'
import type { VariableValues } from '../evaluation/expression.ts'
import type { Definition } from '../model/definition.ts'

export interface RuntimeDiagnostic {
  readonly code: string
  readonly message: string
  readonly track?: ResolvedTrack
  readonly error?: unknown
}

/** Logical facts about bindings; receiving elements remain owned by the executor. */
export interface BindingFacts {
  readonly suspended: boolean
}

/** Evaluation callbacks carry accepted environments, never browser observations. */
export interface ExecutionEnvironment {
  readonly definition: () => Definition
  readonly values: () => VariableValues
  readonly snapshotValues: (definition: Definition) => VariableValues
  readonly invalidateBinding: () => void
  readonly clearBindings: () => void
  readonly rebound: (advance: boolean) => void
  readonly acceptPresentation: (resolution: LayerResolution) => void
}

/**
 * Browser services used by Runtime. The graph's existing bind protocol is invoked
 * inside the executor; its elements and controller control results never return here.
 * Times use the performance clock in milliseconds. Controller resolution runs after
 * terminal writes, independently of notification-time evaluation snapshots.
 */
export interface ExecutionPort {
  readonly bindingFacts: BindingFacts
  initialize(resolution: LayerResolution): void
  configureControllers(definition: Definition, values: VariableValues): void
  disconnectBindings(): void
  connectBindings(
    graph: LetBindingGraph,
    notify: (notification?: ReactiveNotification) => void,
  ): void
  releaseControllers(time?: number): void
  resetPresentation(): void
  terminalControls(time: number): void
  refreshSuspension(definition: Definition): void
  controllerResolution(
    resolution: LayerResolution,
    values: VariableValues,
    time: number,
    definition?: Definition,
    live?: boolean,
  ): LayerResolution
  applyLayerResolution(previous: LayerResolution, next: LayerResolution): void
  endCompositionPreview(): void
  settle(): void
  dispose(): void
}

/** Copies public selections without exposing internal mutable records. */
export function compositionSnapshot(composition: Composition): Composition {
  return { layers: { ...composition.layers }, states: { ...composition.states } }
}
