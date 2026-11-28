import { springMotion } from '../motion/spring-motion.ts'
import type { Timing } from '../model/definition.ts'
import type { LayoutAxes } from '../model/layout.ts'
import {
  identityProjection,
  inverseProjection,
  projectionFrameTransform,
  type ProjectionBox,
  type ProjectionMatrix,
  type ProjectionTransformResult,
} from './projection.ts'
import { projectionTrajectory, type ProjectionTweenSampler } from './projection-trajectory.ts'

/** A point or edge vector in shared reference-plane physical CSS px. */
export interface ProjectionPoint {
  readonly x: number
  readonly y: number
}

/**
 * Displayed affine border-box parallelogram in one shared, scroll-neutral plane.
 * origin is its border origin; xEdge and yEdge are its complete width/height edges.
 * Every coordinate uses CSS px: normalized corners (u,v) map to
 * origin + u*xEdge + v*yEdge, for u/v in [0,1]. Full edges retain inherited direction
 * and shear that scalar lengths lose under unequal ancestor scales. This physical
 * shape is distinct from ProjectionMatrix's unitless linear coefficients.
 */
export interface ProjectionShape {
  readonly origin: ProjectionPoint
  readonly xEdge: ProjectionPoint
  readonly yEdge: ProjectionPoint
  /**
   * A fixed-direction size trajectory crossed zero. Raw sampled vectors remain
   * available for inspection, but this shape is not drawable. Preserve this marker
   * when forwarding a sampled shape to projectionShapeTransform or retargeting.
   * Ordinary reflected coordinate frames do not acquire this marker.
   */
  readonly invalidSize?: true
}

/** Displayed shape and corresponding six-component CSS-px/ms derivatives in the same plane. */
export interface ProjectionShapeState {
  readonly shape: ProjectionShape
  readonly velocity: ProjectionShape
}

function values(value: ProjectionShape): readonly number[] {
  return [
    value.xEdge.x,
    value.xEdge.y,
    value.yEdge.x,
    value.yEdge.y,
    value.origin.x,
    value.origin.y,
  ]
}

function shape(components: readonly number[]): ProjectionShape {
  return {
    xEdge: { x: components[0], y: components[1] },
    yEdge: { x: components[2], y: components[3] },
    origin: { x: components[4], y: components[5] },
  }
}

function finiteShape(value: ProjectionShape): boolean {
  return values(value).every(Number.isFinite)
}

function usableShape(value: ProjectionShape): boolean {
  if (value.invalidSize || !finiteShape(value)) return false

  const { xEdge, yEdge } = value

  if ((xEdge.x === 0 && xEdge.y === 0) || (yEdge.x === 0 && yEdge.y === 0)) return true

  const area = xEdge.x * yEdge.y - xEdge.y * yEdge.x

  return Number.isFinite(area) && area !== 0
}

/**
 * Converts local dimensions and an observed affine frame into a displayed shape.
 * box.x/y already use the shared plane; frame columns map local CSS px into it,
 * including inherited correction. Exclude the target's own ordinary CSS transform
 * according to projection ownership. Zero dimensions produce zero edges. Invalid
 * dimensions, singular/nonfinite frames or unrepresentable edges return undefined.
 */
export function projectionShape(
  box: ProjectionBox,
  frame: ProjectionMatrix,
): ProjectionShape | undefined {
  if (
    ![box.x, box.y, box.width, box.height].every(Number.isFinite) ||
    box.width < 0 ||
    box.height < 0 ||
    !inverseProjection(frame)
  )
    return undefined

  const result = {
    xEdge: { x: frame.a * box.width, y: frame.b * box.width },
    yEdge: { x: frame.c * box.height, y: frame.d * box.height },
    origin: { x: box.x, y: box.y },
  }

  if (
    (box.width > 0 && result.xEdge.x === 0 && result.xEdge.y === 0) ||
    (box.height > 0 && result.yEdge.x === 0 && result.yEdge.y === 0)
  )
    return undefined

  return usableShape(result) ? result : undefined
}

/** A retained full-shape trajectory or explicit immediate settlement. */
export type ProjectionShapeMotionResult =
  | { readonly kind: 'settle'; readonly reason: 'missing' | 'geometry' | 'inactive' }
  | {
      readonly kind: 'motion'
      readonly durationMs: number
      /** Elapsed performance-clock milliseconds; completion returns exact destination/rest. */
      sample(elapsedMs: number): ProjectionShapeState
    }

/** Unchanged zero edges need no scale; moving or changing them requires singular scaling. */
function usableEdge(
  initial: readonly number[],
  end: readonly number[],
  velocity: readonly number[],
  index: number,
): boolean {
  const fromZero = initial[index] === 0 && initial[index + 1] === 0
  const toZero = end[index] === 0 && end[index + 1] === 0

  return (
    (!fromZero && !toZero) ||
    (fromZero && toZero && velocity[index] === 0 && velocity[index + 1] === 0)
  )
}

type FixedEdge = { readonly component: number; readonly sign: number }

/**
 * Tests only numerical collinearity; it never adjusts a coordinate. Normalize
 * before evaluating the determinant to avoid overflow/underflow from units.
 * For scalar-multiple edges assembled as frame*extent, two component products,
 * four normalizations, two determinant products and subtraction contribute at
 * most gamma(9) roundoff: gamma(n)=n*u/(1-n*u), u=Number.EPSILON/2. This is an
 * operation-error bound, not a geometric epsilon or a replacement scale ratio.
 */
function collinear(value: readonly number[], reference: readonly number[], index: number): boolean {
  const magnitude = Math.max(Math.abs(value[index]), Math.abs(value[index + 1]))

  if (magnitude === 0) return true

  // fixedEdge established that the reference edge is nonzero.
  const basis = Math.max(Math.abs(reference[index]), Math.abs(reference[index + 1]))
  const left = (value[index] / magnitude) * (reference[index + 1] / basis)
  const right = (value[index + 1] / magnitude) * (reference[index] / basis)
  const unitRoundoff = Number.EPSILON / 2
  const roundoff = (9 * unitRoundoff) / (1 - 9 * unitRoundoff)

  return Math.abs(left - right) <= roundoff * (Math.abs(left) + Math.abs(right))
}

/** A fixed directed basis gives an unambiguous signed size, even when reflected. */
function fixedEdge(
  initial: readonly number[],
  end: readonly number[],
  velocity: readonly number[],
  index: number,
): FixedEdge | undefined {
  if (end[index] === 0 && end[index + 1] === 0) return undefined

  const component = Math.abs(end[index]) >= Math.abs(end[index + 1]) ? index : index + 1
  const sign = Math.sign(end[component])

  if (
    Math.sign(initial[component]) !== sign ||
    !collinear(initial, end, index) ||
    !collinear(velocity, end, index)
  )
    return undefined

  return { component, sign }
}

/**
 * Plans physical origin/edge-vector motion without DOM reads or writes. x/y select
 * reference-plane origin components; width selects both xEdge components and height
 * selects both yEdge components. Inactive components snap to destination/rest.
 * Retained direction/shear is geometry, not an authored rotation option or preserved
 * target CSS transform. Springs inherit all six derivatives; tweens follow the same
 * supplied-browser-easing policy as box motion. Inputs are copied. Missing/invalid
 * shapes and required zero-to-nonzero/nonzero-to-zero edges settle explicitly;
 * unchanged zero edges can move. Timing, solver and sample errors propagate.
 * For an edge whose endpoints and incoming velocity share one directed basis,
 * zero/negative sampled extent is marked invalidSize and settles at rendering,
 * matching box motion. Direction-changing affine edges keep their six-component
 * trajectory; no independent spring of magnitudes or determinant-sign restriction
 * is imposed. Static reflected frames remain supported. Caller owns cancellation,
 * reduced motion, the common clock and intermediate singular-shape settlement.
 */
export function planProjectionShapeMotion(
  start: ProjectionShapeState | undefined,
  destination: ProjectionShape | undefined,
  selection: LayoutAxes,
  timing: Timing | undefined,
  tween?: ProjectionTweenSampler,
  spring?: Parameters<typeof projectionTrajectory>[5],
): ProjectionShapeMotionResult {
  if (!start || !destination) return { kind: 'settle', reason: 'missing' }
  if (!usableShape(start.shape) || !finiteShape(start.velocity) || !usableShape(destination))
    return { kind: 'settle', reason: 'geometry' }

  const selected = [
    selection.width,
    selection.width,
    selection.height,
    selection.height,
    selection.x,
    selection.y,
  ]

  if (!timing || !selected.some(Boolean)) return { kind: 'settle', reason: 'inactive' }

  const end = values(destination)
  const observed = values(start.shape)
  const observedVelocity = values(start.velocity)
  const initial = selected.map((active, index) => (active ? observed[index] : end[index]))
  const velocity = selected.map((active, index) => (active ? observedVelocity[index] : 0))

  if (!usableEdge(initial, end, velocity, 0) || !usableEdge(initial, end, velocity, 2))
    return { kind: 'settle', reason: 'geometry' }

  const fixed = [fixedEdge(initial, end, velocity, 0), fixedEdge(initial, end, velocity, 2)]
  const trajectory = projectionTrajectory(initial, end, velocity, timing, tween, spring)

  if (!trajectory) return { kind: 'settle', reason: 'inactive' }

  return {
    kind: 'motion',
    durationMs: trajectory.durationMs,
    sample(elapsedMs) {
      const current = trajectory.sample(elapsedMs)

      const invalidSize = fixed.some(
        (edge) => edge !== undefined && Math.sign(current.value[edge.component]) !== edge.sign,
      )
      const sampled = shape(current.value)

      return {
        shape: invalidSize ? { ...sampled, invalidSize: true } : sampled,
        velocity: shape(current.velocity),
      }
    },
  }
}

/**
 * Computes one transform for a retained shape against the current rendering frame
 * and local dimensions. Origins/edges use the shared reference plane, dimensions
 * use local CSS px; ancestor and origin conventions match projectionTransform.
 * Supply the actual identity-installed frame when projection changes a containing
 * block. Reframing the renderer does not change retained shape or its derivatives.
 *
 * Full edges divide by current local dimensions to preserve every corner. A zero
 * edge with zero dimension uses its natural frame column as an unobservable identity;
 * if parallel to the visible edge, a perpendicular canonical column avoids singular
 * output while preserving that line. Required undefined scaling, singular visible
 * shapes, invalidSize samples, negative/nonfinite dimensions/origin or unrepresentable output settle
 * explicitly. The caller owns styles, explicit-transform suppression and cleanup.
 */
export function projectionShapeTransform(
  displayed: ProjectionShape,
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
    displayed.invalidSize ||
    !finiteShape(displayed) ||
    ![
      destination.x,
      destination.y,
      destination.width,
      destination.height,
      origin.x,
      origin.y,
    ].every(Number.isFinite) ||
    destination.width < 0 ||
    destination.height < 0
  )
    return { kind: 'settle', reason: 'geometry' }
  if (
    (destination.width === 0 && (displayed.xEdge.x !== 0 || displayed.xEdge.y !== 0)) ||
    (destination.height === 0 && (displayed.yEdge.x !== 0 || displayed.yEdge.y !== 0))
  )
    return { kind: 'settle', reason: 'geometry' }

  const desired = {
    a: destination.width === 0 ? localToReference.a : displayed.xEdge.x / destination.width,
    b: destination.width === 0 ? localToReference.b : displayed.xEdge.y / destination.width,
    c: destination.height === 0 ? localToReference.c : displayed.yEdge.x / destination.height,
    d: destination.height === 0 ? localToReference.d : displayed.yEdge.y / destination.height,
    e: displayed.origin.x,
    f: displayed.origin.y,
  }

  if (desired.a * desired.d - desired.b * desired.c === 0) {
    const sign =
      localToReference.a * localToReference.d - localToReference.b * localToReference.c < 0 ? -1 : 1

    if (destination.width === 0 && destination.height > 0) {
      desired.a = desired.d * sign
      desired.b = -desired.c * sign
    } else if (destination.height === 0 && destination.width > 0) {
      desired.c = -desired.b * sign
      desired.d = desired.a * sign
    }
  }

  if (!inverseProjection(desired)) return { kind: 'settle', reason: 'geometry' }

  return projectionFrameTransform(desired, localToReference, ancestorCorrection, origin)
}

export function projectionShapeMotion(
  ...[start, destination, selection, timing, tween]: Parameters<typeof planProjectionShapeMotion>
) {
  return planProjectionShapeMotion(start, destination, selection, timing, tween, springMotion)
}
