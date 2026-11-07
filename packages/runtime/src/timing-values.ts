import type { RuntimeValue } from './reactive-value.ts'
import type { Timing } from './definition.ts'

const easingNames: Readonly<Record<string, string>> = {
  linear: 'linear',
  ease: 'ease',
  easeIn: 'ease-in',
  easeOut: 'ease-out',
  easeInOut: 'ease-in-out',
  stepStart: 'step-start',
  stepEnd: 'step-end',
}

export function easingConstant(name: string): RuntimeValue | undefined {
  return Object.hasOwn(easingNames, name)
    ? Object.freeze({ kind: 'easing', css: easingNames[name] })
    : undefined
}

export function isTimingFunction(name: string): boolean {
  return ['tween', 'spring', 'cubicBezier', 'steps'].includes(name)
}

function numeric(
  args: Readonly<Record<string, RuntimeValue>>,
  name: string,
  fallback?: number,
): number {
  const value = args[name] ?? fallback

  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Expected finite number for ${name}`)
  }

  return value
}

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

function validateDurationSpring(durationMs: number, bounce: number): void {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new Error('Spring duration must be finite positive milliseconds')
  }

  if (!Number.isFinite(bounce) || bounce < 0 || bounce >= 1) {
    throw new Error('Spring bounce must be finite and between 0 (inclusive) and 1 (exclusive)')
  }
}

export function callTiming(
  name: string,
  args: Readonly<Record<string, RuntimeValue>>,
): RuntimeValue {
  switch (name) {
    case 'tween': {
      const durationMs = numeric(args, 'duration', 300)

      if (durationMs < 0) throw new Error('Tween duration must be non-negative milliseconds')

      return Object.freeze({
        kind: 'tween',
        durationMs,
        easing: args.easing === undefined ? 'ease' : easingCss(args.easing),
      })
    }
    case 'spring': {
      if (Object.hasOwn(args, 'duration') || Object.hasOwn(args, 'bounce')) {
        if (['stiffness', 'damping', 'mass'].some((parameter) => Object.hasOwn(args, parameter))) {
          throw new Error('Spring duration/bounce and physics arguments must be separate')
        }

        const durationMs = numeric(args, 'duration')
        const bounce = numeric(args, 'bounce', 0)

        validateDurationSpring(durationMs, bounce)

        return Object.freeze({ kind: 'spring-duration', durationMs, bounce })
      }

      const stiffness = numeric(args, 'stiffness', 100)
      const damping = numeric(args, 'damping', 10)
      const mass = numeric(args, 'mass', 1)

      if (stiffness <= 0 || damping <= 0 || mass <= 0) {
        throw new Error('Spring stiffness, damping and mass must be positive')
      }

      return Object.freeze({ kind: 'spring-physics', stiffness, damping, mass })
    }
    case 'steps': {
      const count = numeric(args, 'count')
      const position = args.position ?? 'end'

      if (!Number.isInteger(count) || count <= 0) {
        throw new Error('Step count must be a positive integer')
      }

      if (
        typeof position !== 'string' ||
        !['start', 'end', 'jump-start', 'jump-end', 'jump-none', 'jump-both'].includes(position)
      ) {
        throw new Error(
          'Unsupported step position: use start, end, jump-start, jump-end, jump-none, or jump-both',
        )
      }

      if (position === 'jump-none' && count < 2) {
        throw new Error('Step count must be at least 2 for jump-none')
      }

      return Object.freeze({ kind: 'easing', css: `steps(${count}, ${position})` })
    }
    case 'cubicBezier': {
      const x1 = numeric(args, 'x1')
      const y1 = numeric(args, 'y1')
      const x2 = numeric(args, 'x2')
      const y2 = numeric(args, 'y2')

      if (x1 < 0 || x1 > 1 || x2 < 0 || x2 > 1) {
        throw new Error('Cubic Bezier x coordinates must be between 0 and 1')
      }

      return Object.freeze({ kind: 'easing', css: `cubic-bezier(${x1}, ${y1}, ${x2}, ${y2})` })
    }
    default:
      throw new Error(`Unknown timing function: ${name}`)
  }
}
