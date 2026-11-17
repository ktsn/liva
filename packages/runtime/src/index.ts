export { Runtime } from './execution/runtime.ts'
export { PresentationExecutor } from './execution/presentation-executor.ts'
export { RuntimeInspection } from './execution/inspection.ts'
export { PresenceOperation } from './execution/presence-operation.ts'
export type {
  PresenceCapture,
  PresencePhase,
  PresenceResult,
} from './execution/presence-operation.ts'
export type { PreviewOperation } from './execution/preview-operation.ts'
export type { RuntimeDiagnostic } from './execution/execution-contracts.ts'

// Definition IR and validation are shared by compiler, integration and editor.
export { decodeBundle } from './model/definition.ts'
export type {
  Timing,
  Frame,
  CallExpression,
  Expression,
  MotionParameter,
  LetBinding,
  CssValue,
  PropertyValue,
  Property,
  Declaration,
  Target,
  State,
  GuardedTransition,
  Layer,
  PropertyTransition,
  Transition,
  Definition,
  DefinitionBundle,
} from './model/definition.ts'
export { isRecord, isArrayOf, isDefinition } from './model/validation.ts'
export { ROOT_TARGET, rootTargetBindings } from './model/targets.ts'
export type { RenderedFrame, RenderedProperty, RenderedState } from './model/presentation.ts'
export type { ResolvedTrack } from './composition/resolve.ts'

// Deliberate calculation entry points for compiler presence and editor timelines/provenance.
export {
  hasLifecycle,
  lifecycleTransitions,
  resolveLifecycleTracks,
} from './execution/lifecycle.ts'
export {
  layerTargets,
  declarationTargets,
  resolveComposition,
  resolveLayerTracks,
  compositionTransitions,
} from './composition/layers.ts'
export type { Composition, CompositionTransition, LayerResolution } from './composition/layers.ts'
export {
  compositionLayerSelection,
  targetTiming,
  resolveLayerCascade,
  transitionPropertySources,
} from './composition/layer-cascade.ts'
export type { PropertySource, TimingSource } from './composition/layer-cascade.ts'
export { renderFrame } from './evaluation/expression.ts'
export { sampleSpring } from './motion/spring.ts'

export type {
  LayoutAxes,
  LayoutDeclaration,
  LayoutDeclarationSource,
  LayoutTimingSource,
  ResolvedLayoutConfiguration,
} from './model/layout.ts'

export { isCssProperty } from './model/definition.ts'

export { resolveLayoutConfigurations } from './composition/layout.ts'
