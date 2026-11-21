import type { FunctionArguments, RuntimeValue } from './reactive-value.ts'
import { easingCss, validateDurationSpring } from './timing-values.ts'

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

export function tween(args: FunctionArguments): RuntimeValue {
  const durationMs = numeric(args, 'duration', 300)

  if (durationMs < 0) throw new Error('Tween duration must be non-negative milliseconds')

  return Object.freeze({
    kind: 'tween',
    durationMs,
    easing: args.easing === undefined ? 'ease' : easingCss(args.easing),
  })
}

export function spring(args: FunctionArguments): RuntimeValue {
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

export function steps(args: FunctionArguments): RuntimeValue {
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

export function cubicBezier(args: FunctionArguments): RuntimeValue {
  const x1 = numeric(args, 'x1')
  const y1 = numeric(args, 'y1')
  const x2 = numeric(args, 'x2')
  const y2 = numeric(args, 'y2')

  if (x1 < 0 || x1 > 1 || x2 < 0 || x2 > 1) {
    throw new Error('Cubic Bezier x coordinates must be between 0 and 1')
  }

  return Object.freeze({ kind: 'easing', css: `cubic-bezier(${x1}, ${y1}, ${x2}, ${y2})` })
}
