import { waapiProperty } from '../motion/animation.ts'
import type { TrackPlan } from './presentation-planner.ts'

/** Materializes a completed plan. Its caller owns playback, cancellation, and cleanup. */
export function materializeEffect(plan: TrackPlan, element: HTMLElement): Animation {
  return new Animation(
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
}
