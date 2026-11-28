import type { LayerResolution } from '../composition/layers.ts'
import {
  presentationWrites,
  type PresentationPlan,
  type ReceiverFacts,
  type TrackPlan,
} from './presentation-planner.ts'

/** Preview acceptance is isolated from application composition and always supports manual seeking. */
export function planPreviewPresentation(
  resolution: LayerResolution,
  receivers: readonly ReceiverFacts[],
  start: readonly TrackPlan[],
): PresentationPlan {
  return {
    resolution,
    mode: 'preview',
    cancel: [],
    restore: true,
    preserveLifecycle: false,
    writes: presentationWrites(resolution, receivers),
    start,
  }
}
