import {
  inverseProjection,
  multiplyProjection,
  type ProjectionBox,
  type ProjectionMatrix,
} from './projection.ts'
import {
  projectionShape,
  projectionShapeTransform,
  type ProjectionShapeState,
} from './projection-shape.ts'

type PhysicalFrame = Readonly<{ box: ProjectionBox; frame: ProjectionMatrix }>

/**
 * Converts a fresh displayed child's frame into retained physical edge state when
 * it first participates under a projected parent. Frames share one scroll-neutral
 * reference plane in CSS px; sample uses the absolute performance clock in ms and
 * returns derivatives in px/ms. The parent's cumulative map is its current output.
 *
 * No DOM observation or style ownership occurs here. A noninvertible cumulative
 * map, invalid parent sample or undefined neighboring sample returns undefined:
 * callers settle rather than inventing a handoff velocity at a geometry boundary.
 */
export function captureInheritedProjection(
  visual: PhysicalFrame,
  parent: Readonly<{
    cumulative: ProjectionMatrix
    frame: PhysicalFrame
    sample: (timeMs: number) => ProjectionShapeState
  }>,
  timeMs: number,
): ProjectionShapeState | undefined {
  const inverse = inverseProjection(parent.cumulative)
  if (!inverse) return undefined

  const base = multiplyProjection(inverse, visual.frame)
  const at = (milliseconds: number) => {
    const output = projectionShapeTransform(
      parent.sample(milliseconds).shape,
      parent.frame.box,
      parent.frame.frame,
    )
    if (output.kind === 'settle') return undefined

    const frame = multiplyProjection(output.cumulative, base)
    return projectionShape({ ...visual.box, x: frame.e, y: frame.f }, frame)
  }
  const shape = at(timeMs)
  const before = at(timeMs - 0.01)
  const after = at(timeMs + 0.01)
  if (!shape || !before || !after) return undefined

  const derivative = (key: 'origin' | 'xEdge' | 'yEdge') => ({
    x: (after[key].x - before[key].x) / 0.02,
    y: (after[key].y - before[key].y) / 0.02,
  })

  return {
    shape,
    velocity: {
      origin: derivative('origin'),
      xEdge: derivative('xEdge'),
      yEdge: derivative('yEdge'),
    },
  }
}
