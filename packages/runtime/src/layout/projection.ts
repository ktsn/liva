import type { Timing } from '../model/definition.ts'
import type { LayoutAxes } from '../model/layout.ts'
import { springMotion, type MotionSample } from '../motion/property-motion.ts'

/**
 * Fractional physical CSS-pixel border box. x/y are the transformed border origin
 * in a stable, scroll-neutral reference plane shared by all participants. Width and
 * height follow target-local physical axes, before ordinary ancestor transforms.
 * Exclude the target's own CSS transform. The collector owns correspondence,
 * attachment and the existing single-box, supported-2D geometry checks.
 */
export interface ProjectionBox {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** Displayed box and px/ms derivatives: reference-plane position, target-local dimensions. */
export interface ProjectionState {
  readonly box: ProjectionBox
  readonly velocity: ProjectionBox
}

/**
 * Standard 2D affine map: (x,y) -> (a*x+c*y+e,b*x+d*y+f). Translation uses CSS px;
 * linear coefficients are unitless. Include ordinary transform-origin translations.
 * Coefficients may be inherited/getter-backed, including a 2D DOMMatrix; unrelated
 * properties are ignored. Caller guarantees the snapshot represents a 2D map.
 * Snapshots from different times must use the same scroll-neutral reference plane.
 */
export interface ProjectionMatrix {
  readonly a: number
  readonly b: number
  readonly c: number
  readonly d: number
  readonly e: number
  readonly f: number
}

/** Identity map in any projection plane. */
export const identityProjection: ProjectionMatrix = Object.freeze({
  a: 1,
  b: 0,
  c: 0,
  d: 1,
  e: 0,
  f: 0,
})

/** Composes affine maps in CSS order: right acts first, then left. No DOM APIs are required. */
export function multiplyProjection(
  left: ProjectionMatrix,
  right: ProjectionMatrix,
): ProjectionMatrix {
  return {
    a: left.a * right.a + left.c * right.b,
    b: left.b * right.a + left.d * right.b,
    c: left.a * right.c + left.c * right.d,
    d: left.b * right.c + left.d * right.d,
    e: left.a * right.e + left.c * right.f + left.e,
    f: left.b * right.e + left.d * right.f + left.f,
  }
}

/**
 * Inverts a finite affine snapshot. Exact singularity or numerically unrepresentable
 * determinant/inverse returns undefined; small finite scales are not replaced by epsilons.
 */
export function inverseProjection(matrix: ProjectionMatrix): ProjectionMatrix | undefined {
  if (![matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f].every(Number.isFinite))
    return undefined

  const determinant = matrix.a * matrix.d - matrix.b * matrix.c

  if (determinant === 0 || !Number.isFinite(determinant)) return undefined

  const result = {
    a: matrix.d / determinant,
    b: -matrix.b / determinant,
    c: -matrix.c / determinant,
    d: matrix.a / determinant,
    e: (matrix.c * matrix.f - matrix.d * matrix.e) / determinant,
    f: (matrix.b * matrix.e - matrix.a * matrix.f) / determinant,
  }

  return Object.values(result).every(Number.isFinite) ? result : undefined
}

const axes = ['x', 'y', 'width', 'height'] as const
const zeroBox: ProjectionBox = Object.freeze({ x: 0, y: 0, width: 0, height: 0 })

function vector(bounds: ProjectionBox): number[] {
  return axes.map((axis) => bounds[axis])
}

function box(values: readonly number[]): ProjectionBox {
  return { x: values[0], y: values[1], width: values[2], height: values[3] }
}

function measurableBox(value: ProjectionBox): boolean {
  return vector(value).every(Number.isFinite) && value.width >= 0 && value.height >= 0
}

/**
 * An unchanged collapsed dimension needs no scaling: identity/rate zero preserves
 * its physical state without dividing 0/0. Changed or moving collapsed dimensions
 * cannot be represented by an invertible generated scale and settle instead.
 */
function dimensionComponents(
  value: number,
  destination: number,
  velocity: number,
): readonly [number, number] | undefined {
  if (destination === 0) return value === 0 && velocity === 0 ? [1, 0] : undefined

  const scale = value / destination
  const rate = velocity / destination

  return scale > 0 && Number.isFinite(scale) && Number.isFinite(rate) ? [scale, rate] : undefined
}

/**
 * Missing correspondence is supplied as undefined. Unusable geometry cannot define
 * a scale ratio. Inactive includes absent timing, removed axes, instant timing, and rest.
 */
export type ProjectionMotionResult =
  | { readonly kind: 'settle'; readonly reason: 'missing' | 'geometry' | 'inactive' }
  | {
      readonly kind: 'motion'
      readonly durationMs: number
      /** Elapsed performance-clock milliseconds; completion returns exact destination/rest. */
      sample(elapsedMs: number): ProjectionState
    }

/** Browser-supplied eased tween progress and derivative in progress/ms at elapsed milliseconds. */
export type ProjectionTweenSampler = (elapsedMs: number) => { value: number; velocity: number }

/**
 * Plans retained four-component motion without DOM reads or writes. Active axes
 * retain displayed shape/velocity; inactive axes immediately use destination/rest.
 * Measurable zero width/height does not prevent position motion. An unchanged zero
 * dimension with no selected size velocity needs no scale; selected size motion
 * from/to zero settles because its generated scale would be undefined or singular.
 * Springs reuse property motion and inherit px/ms velocity, including at equal
 * endpoints. Tweens replace incoming velocity like ordinary CSS interpolation.
 * Linear easing is built in; other easings require a supplied browser sampler so
 * CSS easing semantics stay browser-owned. Missing samplers, invalid time/timing,
 * nonfinite tween samples and spring solver failures throw.
 *
 * Caller owns clock origin, cancellation and reduced-motion policy. Input snapshots
 * are copied before retention. No effect, frame loop or external state is created.
 */
export function projectionMotion(
  start: ProjectionState | undefined,
  destination: ProjectionBox | undefined,
  selection: LayoutAxes,
  timing: Timing | undefined,
  tween?: ProjectionTweenSampler,
): ProjectionMotionResult {
  if (!start || !destination) return { kind: 'settle', reason: 'missing' }

  if (
    !measurableBox(start.box) ||
    !measurableBox(destination) ||
    !vector(start.velocity).every(Number.isFinite)
  )
    return { kind: 'settle', reason: 'geometry' }

  if (!timing || !axes.some((axis) => selection[axis]))
    return { kind: 'settle', reason: 'inactive' }

  const end = vector(destination)
  const initial = axes.map((axis) => (selection[axis] ? start.box[axis] : destination[axis]))
  const velocity = axes.map((axis) => (selection[axis] ? start.velocity[axis] : 0))

  if (
    !dimensionComponents(initial[2], end[2], velocity[2]) ||
    !dimensionComponents(initial[3], end[3], velocity[3])
  )
    return { kind: 'settle', reason: 'geometry' }

  if (initial.every((value, index) => value === end[index] && velocity[index] === 0))
    return { kind: 'settle', reason: 'inactive' }

  let durationMs: number
  let sample: (milliseconds: number) => MotionSample

  if (timing.kind === 'tween') {
    durationMs = timing.durationMs

    if (!Number.isFinite(durationMs) || durationMs < 0)
      throw new Error('Invalid projection tween duration')
    if (durationMs === 0) return { kind: 'settle', reason: 'inactive' }
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
    kind: 'motion',
    durationMs,
    sample(elapsedMs) {
      if (!Number.isFinite(elapsedMs))
        throw new Error('Projection time must be finite milliseconds')
      if (elapsedMs >= durationMs) return { box: box(end), velocity: zeroBox }

      const current = sample(Math.max(0, elapsedMs))

      return { box: box(current.value), velocity: box(current.velocity) }
    },
  }
}

/** Reference-plane translation (px), local size ratios, and px/ms or ratio/ms derivatives. */
export interface ProjectionComponents {
  readonly translateX: number
  readonly translateY: number
  readonly scaleX: number
  readonly scaleY: number
  readonly velocityX: number
  readonly velocityY: number
  readonly velocityScaleX: number
  readonly velocityScaleY: number
}

/**
 * Converts displayed physical state into a new stationary destination basis.
 * Translation is relative to destination origin; scale and size velocity divide by
 * destination width/height. An unchanged zero dimension with zero size velocity
 * uses identity scale/rate zero. Changed or moving zero dimensions return undefined,
 * as do nonfinite or unrepresentable components.
 * Use physical state when retargeting, rather than reusing old scale ratios.
 */
export function projectionComponents(
  state: ProjectionState,
  destination: ProjectionBox,
): ProjectionComponents | undefined {
  if (
    !measurableBox(state.box) ||
    !measurableBox(destination) ||
    !vector(state.velocity).every(Number.isFinite)
  )
    return undefined

  const horizontal = dimensionComponents(state.box.width, destination.width, state.velocity.width)
  const vertical = dimensionComponents(state.box.height, destination.height, state.velocity.height)

  if (!horizontal || !vertical) return undefined

  const result = {
    translateX: state.box.x - destination.x,
    translateY: state.box.y - destination.y,
    scaleX: horizontal[0],
    scaleY: vertical[0],
    velocityX: state.velocity.x,
    velocityY: state.velocity.y,
    velocityScaleX: horizontal[1],
    velocityScaleY: vertical[1],
  }

  return Object.values(result).every(Number.isFinite) ? result : undefined
}

/**
 * Recovers displayed physical state from components in a stationary destination
 * basis. A zero destination dimension requires identity scale and rate zero, its
 * canonical representation; other components cannot preserve that physical state.
 * Undefined means negative/nonfinite geometry, a singular scale, or unrepresentable
 * components. Unchanged collapsed axes remain available for position-only motion.
 */
export function projectionState(
  components: ProjectionComponents,
  destination: ProjectionBox,
): ProjectionState | undefined {
  if (!measurableBox(destination) || !Object.values(components).every(Number.isFinite))
    return undefined

  if (
    components.scaleX <= 0 ||
    components.scaleY <= 0 ||
    (destination.width === 0 && (components.scaleX !== 1 || components.velocityScaleX !== 0)) ||
    (destination.height === 0 && (components.scaleY !== 1 || components.velocityScaleY !== 0))
  )
    return undefined

  const result = {
    box: {
      x: destination.x + components.translateX,
      y: destination.y + components.translateY,
      width: destination.width * components.scaleX,
      height: destination.height * components.scaleY,
    },
    velocity: {
      x: components.velocityX,
      y: components.velocityY,
      width: destination.width * components.velocityScaleX,
      height: destination.height * components.velocityScaleY,
    },
  }

  return measurableBox(result.box) && vector(result.velocity).every(Number.isFinite)
    ? result
    : undefined
}

/** One generated transform and cumulative correction for explicitly participating descendants. */
export type ProjectionTransformResult =
  | { readonly kind: 'settle'; readonly reason: 'geometry' | 'singular' }
  | {
      readonly kind: 'projection'
      /** CSS transform-property matrix adjusted for the target's used transform-origin. */
      readonly matrix: ProjectionMatrix
      readonly transform: string
      /** Total generated map in the shared reference plane; pass to children at the same sample time. */
      readonly cumulative: ProjectionMatrix
      /** Cumulative target-local generated linear map, with translation zeroed, for style correction. */
      readonly distortion: ProjectionMatrix
      /** Magnitudes of distortion's local x/y columns. */
      readonly scale: { readonly x: number; readonly y: number }
    }

/**
 * Maps the destination box to displayed state using one CSS transform. Positions
 * include ordinary ancestor transforms in the shared scroll-neutral reference
 * plane; dimensions remain target-local. localToReference maps the target's local
 * border box into that plane, including ordinary 2D ancestor transforms/origins,
 * excluding scroll translation, the target's own CSS transform, and all generated
 * correction. Its translation corresponds to destination.x/y. The default frame
 * is a pure translation to destination.x/y. ancestorCorrection is the cumulative
 * generated map in the same reference plane. origin is the used target pivot in
 * local border-box CSS px (default zero).
 *
 * Local width/height axes rotate with their frame. Inverting ancestor correction
 * prevents doubled projection; arbitrary supported 2D ancestors can create local
 * off-diagonal compensation terms. These are coordinate conversion, not composition
 * with the target's CSS transform, which the caller overrides until release.
 * Unchanged zero dimensions use identity scale, allowing position-only motion.
 * Changed zero dimensions require undefined/singular scaling and settle explicitly,
 * as do nonfinite/negative geometry and singular coordinate maps. Negative spring
 * size overshoot is settled instead of reflecting content through a collapsed box.
 * A stationary opted-in child still needs this compensation while any ancestor is
 * projected, even after its own motion finishes. Caller owns all writes,
 * explicit-transform suppression, and lifecycle cleanup.
 */
export function projectionTransform(
  displayed: ProjectionBox,
  destination: ProjectionBox,
  localToReference: ProjectionMatrix = {
    ...identityProjection,
    e: destination.x,
    f: destination.y,
  },
  ancestorCorrection: ProjectionMatrix = identityProjection,
  origin: Readonly<{ x: number; y: number }> = { x: 0, y: 0 },
): ProjectionTransformResult {
  if (
    !measurableBox(displayed) ||
    !measurableBox(destination) ||
    ![origin.x, origin.y].every(Number.isFinite)
  )
    return { kind: 'settle', reason: 'geometry' }

  const inverseFrame = inverseProjection(localToReference)
  const inverseAncestor = inverseProjection(ancestorCorrection)

  if (!inverseFrame || !inverseAncestor) return { kind: 'settle', reason: 'singular' }

  const horizontal = dimensionComponents(displayed.width, destination.width, 0)
  const vertical = dimensionComponents(displayed.height, destination.height, 0)

  if (!horizontal || !vertical) return { kind: 'settle', reason: 'geometry' }

  const sx = horizontal[0]
  const sy = vertical[0]
  const desiredFrame = {
    a: localToReference.a * sx,
    b: localToReference.b * sx,
    c: localToReference.c * sy,
    d: localToReference.d * sy,
    e: displayed.x,
    f: displayed.y,
  }
  const cumulative = multiplyProjection(desiredFrame, inverseFrame)
  const totalLocal = multiplyProjection(inverseFrame, desiredFrame)
  const local = multiplyProjection(inverseFrame, multiplyProjection(inverseAncestor, desiredFrame))
  const matrix = {
    ...local,
    e: local.e + (local.a - 1) * origin.x + local.c * origin.y,
    f: local.f + local.b * origin.x + (local.d - 1) * origin.y,
  }
  const scale = {
    x: Math.hypot(totalLocal.a, totalLocal.b),
    y: Math.hypot(totalLocal.c, totalLocal.d),
  }

  if (
    ![...Object.values(matrix), ...Object.values(cumulative), scale.x, scale.y].every(
      Number.isFinite,
    )
  )
    return { kind: 'settle', reason: 'geometry' }

  if (scale.x === 0 || scale.y === 0) return { kind: 'settle', reason: 'geometry' }

  return {
    kind: 'projection',
    matrix,
    cumulative,
    scale,
    distortion: { ...totalLocal, e: 0, f: 0 },
    transform: `matrix(${matrix.a}, ${matrix.b}, ${matrix.c}, ${matrix.d}, ${matrix.e}, ${matrix.f})`,
  }
}
