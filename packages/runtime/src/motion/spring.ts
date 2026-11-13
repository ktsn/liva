import type { Timing } from '../model/definition.ts'

type Spring = Exclude<Timing, { kind: 'tween' }>

/** Midpoint interpolation-error target for adaptive scalar easing samples. */
export const SPRING_ERROR = 0.0005

/** Rest-position tolerance for unit displacement, retaining the half-easing-error policy. */
export const SPRING_SETTLE_POSITION_ERROR = SPRING_ERROR / 2

/** Rest-speed tolerance for unit displacement, in value units per second. */
export const SPRING_SETTLE_VELOCITY_PER_SECOND = 0.001

/**
 * Consecutive sampled rest required by the scalar search, in seconds. Property
 * motion uses the same span for a two-point lookback, not a continuous rest check.
 */
export const SPRING_SETTLE_WINDOW_SECONDS = 0.064

/** Minimum coarse intervals, retaining short/slow curves' existing sampling density. */
export const SPRING_MIN_INTERVALS = 32

/**
 * Coarse intervals per radian of natural frequency: step <= (1 / density) / omega.
 * This retains the existing 0.1-radian step policy. Scalar easing additionally
 * refines interpolation error; the density alone does not bound that error.
 */
export const SPRING_SAMPLING_DENSITY = 10

export const SPRING_MAX_SECONDS = 10
export const SPRING_MAX_SAMPLES = 8192

/**
 * Samples one spring component from arbitrary start/end values and initial velocity.
 * Stiffness, damping, and mass must be positive finite physical parameters; elapsed
 * time is in seconds and incoming/returned velocities use value units per second.
 * Covers under-, critical-, and over-damped motion without clamping or snapping.
 */
export function springState(
  start: number,
  end: number,
  initialVelocity: number,
  stiffness: number,
  damping: number,
  mass: number,
  seconds: number,
) {
  const omega = Math.sqrt(stiffness / mass)
  const decay = damping / (2 * mass)
  const delta = omega * omega - decay * decay
  const displacement = start - end
  let value: number
  let velocity: number

  if (Math.abs(delta) < omega * omega * 1e-8) {
    const coefficient = initialVelocity + decay * displacement
    const exponential = Math.exp(-decay * seconds)
    value = (displacement + coefficient * seconds) * exponential
    velocity = (coefficient - decay * (displacement + coefficient * seconds)) * exponential
  } else if (delta > 0) {
    const frequency = Math.sqrt(delta)
    const coefficient = (initialVelocity + decay * displacement) / frequency
    const exponential = Math.exp(-decay * seconds)
    const cosine = Math.cos(frequency * seconds)
    const sine = Math.sin(frequency * seconds)
    const basis = displacement * cosine + coefficient * sine
    value = exponential * basis
    velocity =
      exponential *
      (-decay * basis - displacement * frequency * sine + coefficient * frequency * cosine)
  } else {
    const root = Math.sqrt(-delta)
    const slow = (-omega * omega) / (decay + root)
    const fast = -decay - root
    const a = (initialVelocity - fast * displacement) / (slow - fast)
    const b = displacement - a
    value = a * Math.exp(slow * seconds) + b * Math.exp(fast * seconds)
    velocity = a * slow * Math.exp(slow * seconds) + b * fast * Math.exp(fast * seconds)
  }

  return { value: end + value, velocity }
}

/**
 * Samples progress from 0 to 1 with zero initial velocity, using positive finite
 * physical parameters and elapsed seconds. Velocity is progress per second;
 * progress remains unclamped so the browser can preserve overshoot.
 */
export function springResponse(
  stiffness: number,
  damping: number,
  mass: number,
  seconds: number,
): { value: number; velocity: number } {
  return springState(0, 1, 0, stiffness, damping, mass, seconds)
}

function settlingTime(stiffness: number, damping: number, mass: number, cap: number): number {
  const step = Math.min(1 / 240, 1 / SPRING_SAMPLING_DENSITY / Math.sqrt(stiffness / mass))
  let stable = 0

  if (!Number.isFinite(step) || step <= 0 || cap / step > 200_000) {
    throw new Error('Spring exceeds solver sample cap')
  }

  for (let t = step; t <= cap; t += step) {
    const { value, velocity } = springResponse(stiffness, damping, mass, t)
    stable =
      Math.abs(1 - value) < SPRING_SETTLE_POSITION_ERROR &&
      Math.abs(velocity) < SPRING_SETTLE_VELOCITY_PER_SECOND
        ? stable + step
        : 0

    if (stable >= SPRING_SETTLE_WINDOW_SECONDS) {
      return t
    }
  }

  throw new Error('Spring did not converge before duration cap')
}

export function springParameters(timing: Spring): {
  stiffness: number
  damping: number
  mass: number
  durationMs: number
} {
  let stiffness: number
  let damping: number
  let mass = 1
  let duration: number

  if (timing.kind === 'spring-duration') {
    const ratio = 1 - 0.9 * timing.bounce
    const naturalDuration = settlingTime(1, 2 * ratio, 1, 120)
    const omega = naturalDuration / (timing.durationMs / 1000)
    stiffness = omega * omega
    damping = 2 * ratio * omega
    duration = timing.durationMs / 1000
  } else {
    ;({ stiffness, damping, mass } = timing)
    duration = settlingTime(stiffness, damping, mass, SPRING_MAX_SECONDS)
  }

  if (
    !Number.isFinite(duration) ||
    duration <= 0 ||
    ![stiffness, damping, mass].every((n) => Number.isFinite(n) && n > 0)
  ) {
    throw new Error('Invalid spring parameters')
  }

  return { stiffness, damping, mass, durationMs: duration * 1000 }
}

export function sampleSpring(timing: Spring): {
  durationMs: number
  easing: string
  samples: readonly { time: number; value: number }[]
} {
  const { stiffness, damping, mass, durationMs } = springParameters(timing)
  const duration = durationMs / 1000

  const samples: { time: number; value: number }[] = [{ time: 0, value: 0 }]
  const step = Math.min(
    duration / SPRING_MIN_INTERVALS,
    1 / SPRING_SAMPLING_DENSITY / Math.sqrt(stiffness / mass),
  )

  if (duration / step > SPRING_MAX_SAMPLES) {
    throw new Error('Spring exceeds easing sample cap')
  }

  const addInterval = (left: number, right: number, depth: number) => {
    const a = springResponse(stiffness, damping, mass, left).value
    const b = springResponse(stiffness, damping, mass, right).value
    const mid = (left + right) / 2
    const actual = springResponse(stiffness, damping, mass, mid).value

    if (Math.abs(actual - (a + b) / 2) > SPRING_ERROR) {
      /* v8 ignore if -- @preserve: The frequency-bounded step resolves curvature before this defensive recursion limit. */
      if (depth >= 20 || samples.length >= SPRING_MAX_SAMPLES) {
        throw new Error('Spring exceeds easing sample cap')
      }

      addInterval(left, mid, depth + 1)
      addInterval(mid, right, depth + 1)
    } else {
      samples.push({ time: right / duration, value: b })
    }
  }

  for (let left = 0; left < duration; left += step) {
    addInterval(left, Math.min(left + step, duration), 0)

    if (samples.length > SPRING_MAX_SAMPLES) {
      throw new Error('Spring exceeds easing sample cap')
    }
  }

  samples[samples.length - 1] = { time: 1, value: 1 }
  const easing = `linear(${samples.map(({ time, value }) => `${value.toFixed(7)} ${(time * 100).toFixed(7)}%`).join(', ')})`
  return { durationMs: duration * 1000, easing, samples }
}
