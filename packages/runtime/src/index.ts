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
// Shared adapter/runtime teardown preserves independent owners and original causes.
export { releaseResources } from './evaluation/resource-cleanup.ts'
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

export {
  identityProjection,
  multiplyProjection,
  inverseProjection,
  projectionMotion,
  projectionComponents,
  projectionState,
  projectionTransform,
} from './layout/projection.ts'
export type {
  ProjectionBox,
  ProjectionState,
  ProjectionMatrix,
  ProjectionMotionResult,
  ProjectionTweenSampler,
  ProjectionComponents,
  ProjectionTransformResult,
} from './layout/projection.ts'
export {
  decodeCornerRadii,
  decodeBoxShadows,
  correctCornerRadii,
  correctBoxShadows,
} from './layout/style-correction.ts'
export type {
  CornerRadii,
  Radius,
  BoxShadow,
  CorrectionScale,
  CorrectionTransform,
} from './layout/style-correction.ts'

export {
  projectionShape,
  projectionShapeMotion,
  projectionShapeTransform,
} from './layout/projection-shape.ts'
export type {
  ProjectionPoint,
  ProjectionShape,
  ProjectionShapeState,
  ProjectionShapeMotionResult,
} from './layout/projection-shape.ts'

export { LayoutCoordinator } from './layout/layout-coordinator.ts'
