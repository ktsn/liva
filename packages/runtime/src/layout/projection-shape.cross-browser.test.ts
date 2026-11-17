import { describe, expect, it } from 'vite-plus/test'
import {
  projectionShape,
  projectionShapeMotion,
  projectionShapeTransform,
  type ProjectionShape,
} from './projection-shape.ts'
import { multiplyProjection, type ProjectionMatrix } from './projection.ts'

const all = { x: true, y: true, width: true, height: true }
const zero: ProjectionShape = {
  origin: { x: 0, y: 0 },
  xEdge: { x: 0, y: 0 },
  yEdge: { x: 0, y: 0 },
}

function css(matrix: ProjectionMatrix): string {
  return `matrix(${matrix.a}, ${matrix.b}, ${matrix.c}, ${matrix.d}, ${matrix.e}, ${matrix.f})`
}

function fixture(transform: string, width: number, height: number) {
  const root = document.createElement('div')
  const wrapper = document.createElement('div')
  const target = document.createElement('div')
  root.style.cssText = 'position:absolute;left:0;top:0;transform-origin:0 0'
  wrapper.style.cssText = `position:absolute;left:0;top:0;transform-origin:0 0;transform:${transform}`
  target.style.cssText = `position:absolute;left:0;top:0;width:${width}px;height:${height}px;transform-origin:50% 50%`
  const corners = [
    [0, 0],
    [100, 0],
    [100, 100],
    [0, 100],
  ].map(([x, y]) => {
    const marker = document.createElement('div')
    marker.style.cssText = `position:absolute;left:${x}%;top:${y}%;width:0;height:0`
    target.append(marker)
    return marker
  })
  root.append(wrapper)
  wrapper.append(target)
  document.body.append(root)

  return { root, wrapper, target, corners }
}

function points(corners: readonly HTMLElement[]) {
  return corners.map((marker) => {
    const rect = marker.getBoundingClientRect()

    return { x: rect.x, y: rect.y }
  })
}

function expectCorners(actual: readonly HTMLElement[], control: readonly HTMLElement[]) {
  const measured = points(actual)
  const expected = points(control)

  measured.forEach((point, index) => {
    // Preserve the integration's 0.0005px budget. Native controls render EACH
    // progress before observation: Firefox's DOMRect point quantization does not
    // commute with interpolation of already-observed endpoint rectangles.
    expect(point.x).toBeCloseTo(expected[index].x, 3)
    expect(point.y).toBeCloseTo(expected[index].y, 3)
  })
}

describe('full affine handoff against native controls', () => {
  it.each(['rotate(25deg) skewX(12deg)', 'rotate(70deg) skewX(-15deg)'])(
    'preserves all corners through enablement, parent timing and renderer rebasing: %s',
    (destinationTransform) => {
      const before = fixture('rotate(25deg) skewX(12deg)', 40, 20)
      const after = fixture(destinationTransform, 60, 20)
      const projected = fixture(destinationTransform, 60, 20)
      const control = fixture('none', 60, 20)
      const parent = new DOMMatrix([0.625, 0, 0, 0.5, 0, 0])
      before.root.style.transform = css(parent)
      const oldBasis = new DOMMatrix(getComputedStyle(before.wrapper).transform)
      const newBasis = new DOMMatrix(getComputedStyle(after.wrapper).transform)
      const oldFrame = parent.multiply(oldBasis)
      const source = projectionShape({ x: 0, y: 0, width: 40, height: 20 }, oldFrame)
      const destination = projectionShape({ x: 0, y: 0, width: 60, height: 20 }, newBasis)

      if (!source || !destination) throw new Error('Expected native source/destination shapes')

      const motion = projectionShapeMotion({ shape: source, velocity: zero }, destination, all, {
        kind: 'tween',
        durationMs: 1000,
        easing: 'linear',
      })

      if (motion.kind !== 'motion') throw new Error('Expected affine tween')

      try {
        for (const time of [0, 250, 750, 1000]) {
          const progress = time / 1000
          const parentProgress = Math.min(1, time / 750)
          const currentParent = new DOMMatrix([
            0.625 + 0.375 * parentProgress,
            0,
            0,
            0.5 + 0.5 * parentProgress,
            0,
            0,
          ])
          projected.root.style.transform = css(currentParent)

          // Independent native unit-square edge interpolation, not helper output.
          // The flat control and nested projected target undergo the same browser
          // observation/serialization paths at this clock instant.
          const expected = new DOMMatrix([
            (oldFrame.a * 40 * (1 - progress) + newBasis.a * 60 * progress) / 60,
            (oldFrame.b * 40 * (1 - progress) + newBasis.b * 60 * progress) / 60,
            oldFrame.c * (1 - progress) + newBasis.c * progress,
            oldFrame.d * (1 - progress) + newBasis.d * progress,
            0,
            0,
          ])
          control.root.style.transform = css(expected)

          // A containing-block ownership boundary may change the actual rendering
          // dimensions/frame without changing the retained desired physical shape.
          const reframed = time >= 750
          const width = reframed ? 80 : 60
          const height = reframed ? 30 : 20
          const local = { a: 1, b: 0, c: 0, d: 1, e: reframed ? 20 : 0, f: reframed ? -10 : 0 }
          const frame = multiplyProjection(newBasis, local)
          const correction = projectionShapeTransform(
            motion.sample(time).shape,
            { x: frame.e, y: frame.f, width, height },
            frame,
            currentParent,
            { x: width / 2, y: height / 2 },
          )

          if (correction.kind !== 'projection') throw new Error('Expected affine transform')

          projected.target.style.width = `${width}px`
          projected.target.style.height = `${height}px`
          projected.target.style.left = `${local.e}px`
          projected.target.style.top = `${local.f}px`
          projected.target.style.transform = correction.transform

          expectCorners(projected.corners, control.corners)
          expect(projected.target.clientWidth).toBe(width)
          expect(projected.target.clientHeight).toBe(height)
        }
      } finally {
        before.root.remove()
        after.root.remove()
        projected.root.remove()
        control.root.remove()
      }
    },
  )
})
