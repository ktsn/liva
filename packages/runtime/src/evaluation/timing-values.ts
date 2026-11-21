import type { RuntimeValue } from './reactive-value.ts'
import type { Timing } from '../model/definition.ts'

export function easingCss(value: RuntimeValue): string {
  if (typeof value !== 'object' || value.kind !== 'easing' || typeof value.css !== 'string') {
    throw new Error('Expected easing value')
  }

  return value.css
}

export function timingValue(value: RuntimeValue): Timing {
  if (typeof value !== 'object') throw new Error('Expected timing value')

  if (
    value.kind === 'spring-duration' &&
    typeof value.durationMs === 'number' &&
    typeof value.bounce === 'number'
  ) {
    validateDurationSpring(value.durationMs, value.bounce)

    return { kind: 'spring-duration', durationMs: value.durationMs, bounce: value.bounce }
  }

  if (
    value.kind === 'tween' &&
    typeof value.durationMs === 'number' &&
    typeof value.easing === 'string'
  ) {
    return { kind: 'tween', durationMs: value.durationMs, easing: value.easing }
  }

  if (
    value.kind === 'spring-physics' &&
    typeof value.stiffness === 'number' &&
    typeof value.damping === 'number' &&
    typeof value.mass === 'number'
  ) {
    return {
      kind: 'spring-physics',
      stiffness: value.stiffness,
      damping: value.damping,
      mass: value.mass,
    }
  }

  throw new Error('Expected timing value')
}

export function validateDurationSpring(durationMs: number, bounce: number): void {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new Error('Spring duration must be finite positive milliseconds')
  }

  if (!Number.isFinite(bounce) || bounce < 0 || bounce >= 1) {
    throw new Error('Spring bounce must be finite and between 0 (inclusive) and 1 (exclusive)')
  }
}
