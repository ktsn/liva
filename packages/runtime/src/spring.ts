import type { Timing } from './definition.ts'

type Spring = Exclude<Timing, { kind: 'tween' }>
export const SPRING_ERROR = 0.0005
export const SPRING_MAX_SECONDS = 10
export const SPRING_MAX_SAMPLES = 8192

/** Analytic unit-step response; values remain scalar and may exceed one. */
export function springResponse(
  stiffness: number,
  damping: number,
  mass: number,
  seconds: number,
): { value: number; velocity: number } {
  const omega = Math.sqrt(stiffness / mass)
  const decay = damping / (2 * mass)
  const delta = omega * omega - decay * decay
  let displacement: number
  let velocity: number

  if (Math.abs(delta) < omega * omega * 1e-8) {
    const exponential = Math.exp(-decay * seconds)
    displacement = (1 + decay * seconds) * exponential
    velocity = decay * decay * seconds * exponential
  } else if (delta > 0) {
    const frequency = Math.sqrt(delta)
    const exponential = Math.exp(-decay * seconds)
    displacement =
      exponential *
      (Math.cos(frequency * seconds) + (decay / frequency) * Math.sin(frequency * seconds))
    velocity = exponential * ((omega * omega) / frequency) * Math.sin(frequency * seconds)
  } else {
    const root = Math.sqrt(-delta)
    const slow = (-omega * omega) / (decay + root)
    const fast = -decay - root
    displacement =
      (fast * Math.exp(slow * seconds) - slow * Math.exp(fast * seconds)) / (fast - slow)
    velocity = (slow * fast * (Math.exp(fast * seconds) - Math.exp(slow * seconds))) / (fast - slow)
  }

  return { value: 1 - displacement, velocity }
}

function settlingTime(stiffness: number, damping: number, mass: number, cap: number): number {
  const step = Math.min(1 / 240, 0.1 / Math.sqrt(stiffness / mass))
  let stable = 0

  if (!Number.isFinite(step) || step <= 0 || cap / step > 200_000) {
    throw new Error('Spring exceeds solver sample cap')
  }

  for (let t = step; t <= cap; t += step) {
    const { value, velocity } = springResponse(stiffness, damping, mass, t)
    stable =
      Math.abs(1 - value) < SPRING_ERROR / 2 && Math.abs(velocity) < 0.001 ? stable + step : 0

    if (stable >= 0.064) {
      return t
    }
  }

  throw new Error('Spring did not converge before duration cap')
}

export function sampleSpring(timing: Spring): {
  durationMs: number
  easing: string
  samples: readonly { time: number; value: number }[]
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

  const samples: { time: number; value: number }[] = [{ time: 0, value: 0 }]
  const step = Math.min(duration / 32, 0.1 / Math.sqrt(stiffness / mass))

  if (duration / step > SPRING_MAX_SAMPLES) {
    throw new Error('Spring exceeds easing sample cap')
  }

  const addInterval = (left: number, right: number, depth: number) => {
    const a = springResponse(stiffness, damping, mass, left).value
    const b = springResponse(stiffness, damping, mass, right).value
    const mid = (left + right) / 2
    const actual = springResponse(stiffness, damping, mass, mid).value

    if (Math.abs(actual - (a + b) / 2) > SPRING_ERROR) {
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
