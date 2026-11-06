import type { RuntimeValue } from './reactive-value.ts'
import type { Timing } from './definition.ts'

const easingNames: Readonly<Record<string, string>> = {
  linear: 'linear',
  ease: 'ease',
  easeIn: 'ease-in',
  easeOut: 'ease-out',
  easeInOut: 'ease-in-out',
}

export function easingConstant(name: string): RuntimeValue | undefined {
  return Object.hasOwn(easingNames, name)
    ? Object.freeze({ kind: 'easing', css: easingNames[name] })
    : undefined
}

export function isTimingFunction(name: string): boolean {
  return ['tween', 'spring', 'cubicBezier'].includes(name)
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
      const stiffness = numeric(args, 'stiffness', 100)
      const damping = numeric(args, 'damping', 10)
      const mass = numeric(args, 'mass', 1)

      if (stiffness <= 0 || damping <= 0 || mass <= 0) {
        throw new Error('Spring stiffness, damping and mass must be positive')
      }

      return Object.freeze({ kind: 'spring-physics', stiffness, damping, mass })
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
