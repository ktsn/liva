import type { Timing } from '../model/definition.ts'
import { springMotion, type MotionSample } from '../motion/property-motion.ts'

/** Browser-supplied eased progress and progress/ms derivative at elapsed milliseconds. */
export type ProjectionTweenSampler = (elapsedMs: number) => { value: number; velocity: number }

/** Retained numeric motion on the performance-clock millisecond time basis. */
export interface ProjectionTrajectory {
  readonly durationMs: number
  sample(elapsedMs: number): MotionSample
}

/**
 * Shared numeric timing for physical box components and affine edge vectors.
 * Callers supply copied, equally sized finite vectors in CSS px and px/ms after
 * selecting active components and validating their representation. Rest/instant
 * timing returns undefined. Invalid timing, missing nonlinear browser samplers,
 * nonfinite tween samples and spring solver failures throw without being wrapped.
 */
export function projectionTrajectory(
  initial: readonly number[],
  end: readonly number[],
  velocity: readonly number[],
  timing: Timing,
  tween?: ProjectionTweenSampler,
): ProjectionTrajectory | undefined {
  if (initial.every((value, index) => value === end[index] && velocity[index] === 0))
    return undefined

  let durationMs: number
  let sample: (milliseconds: number) => MotionSample

  if (timing.kind === 'tween') {
    durationMs = timing.durationMs

    if (!Number.isFinite(durationMs) || durationMs < 0)
      throw new Error('Invalid projection tween duration')
    if (durationMs === 0) return undefined
    if (!tween && timing.easing !== 'linear')
      throw new Error('Projection tween requires a browser easing sampler')

    const progress =
      tween ?? ((elapsed: number) => ({ value: elapsed / durationMs, velocity: 1 / durationMs }))

    sample = (milliseconds) => {
      const current = progress(milliseconds)

      if (![current.value, current.velocity].every(Number.isFinite))
        throw new Error('Projection tween sample must be finite')

      return {
        value: initial.map((value, index) => value + (end[index] - value) * current.value),
        velocity: initial.map((value, index) => (end[index] - value) * current.velocity),
      }
    }
  } else {
    const spring = springMotion(timing, initial, end, velocity)
    durationMs = spring.durationMs
    sample = spring.sample
  }

  return {
    durationMs,
    sample(elapsedMs) {
      if (!Number.isFinite(elapsedMs))
        throw new Error('Projection time must be finite milliseconds')
      if (elapsedMs >= durationMs) return { value: end, velocity: end.map(() => 0) }

      return sample(Math.max(0, elapsedMs))
    },
  }
}
