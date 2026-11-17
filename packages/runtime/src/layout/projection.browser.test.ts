import { describe, expect, it } from 'vite-plus/test'
import { readLayoutBounds } from './layout-bounds.ts'
import {
  multiplyProjection,
  projectionMotion,
  projectionTransform,
  type ProjectionMatrix,
} from './projection.ts'

function css(matrix: ProjectionMatrix): string {
  return `matrix(${matrix.a}, ${matrix.b}, ${matrix.c}, ${matrix.d}, ${matrix.e}, ${matrix.f})`
}

const ancestors = [
  { a: 0, b: 1, c: -1, d: 0, e: 150, f: 30 },
  { a: 1.5, b: 0.4, c: 0.7, d: 2, e: 20, f: 30 },
]
const cases = ancestors.flatMap((ancestor) => [
  { ancestor, oldWidth: 120, oldHeight: 20, width: 80, height: 40 },
  { ancestor, oldWidth: 80, oldHeight: 40, width: 120, height: 20 },
])

function expectRenderedBox(
  child: HTMLElement,
  frame: ProjectionMatrix,
  width: number,
  height: number,
) {
  const points = [
    [0, 0],
    [width, 0],
    [width, height],
    [0, height],
  ].map(([x, y]) => ({
    x: frame.a * x + frame.c * y + frame.e,
    y: frame.b * x + frame.d * y + frame.f,
  }))
  const xs = points.map(({ x }) => x)
  const ys = points.map(({ y }) => y)
  const bounds = child.getBoundingClientRect()

  // CSS matrix serialization and getBoundingClientRect round at browser precision.
  // 0.001px is below existing geometry tolerances at these sub-1000px magnitudes.
  expect(bounds.left).toBeCloseTo(Math.min(...xs), 3)
  expect(bounds.top).toBeCloseTo(Math.min(...ys), 3)
  expect(bounds.right).toBeCloseTo(Math.max(...xs), 3)
  expect(bounds.bottom).toBeCloseTo(Math.max(...ys), 3)
}

describe('affine projection in real browsers', () => {
  it.each(cases)(
    'preserves old local geometry through anisotropic parent correction: %j',
    ({ ancestor, oldWidth, oldHeight, width, height }) => {
      const root = document.createElement('div')
      const wrapper = document.createElement('div')
      const child = document.createElement('div')
      const parent = { a: 2, b: 0, c: 0, d: 0.5, e: 10, f: 20 }
      const frame = multiplyProjection(ancestor, { a: 1, b: 0, c: 0, d: 1, e: 20, f: 40 })
      const oldFrame = multiplyProjection(ancestor, { a: 1, b: 0, c: 0, d: 1, e: 10, f: 30 })
      const destination = { x: frame.e, y: frame.f, width, height }
      const displayed = { x: oldFrame.e, y: oldFrame.f, width: oldWidth, height: oldHeight }
      const result = projectionTransform(displayed, destination, frame, parent, { x: 16, y: 12 })

      if (result.kind !== 'projection') throw new Error('Expected projection')

      root.style.cssText = `position: absolute; left: 0; top: 0; transform-origin: 0 0; transform: ${css(parent)}`
      wrapper.style.cssText = `position: absolute; left: 0; top: 0; transform-origin: 0 0; transform: ${css(ancestor)}`
      child.style.cssText = `position: absolute; left: 20px; top: 40px; width: ${width}px; height: ${height}px; transform-origin: 16px 12px; transform: ${result.transform}`
      root.append(wrapper)
      wrapper.append(child)
      document.body.append(root)

      try {
        // Independent expected geometry: transform the old physical local box with
        // the ordinary ancestor. This catches incorrectly scaling root-axis width
        // when the target's width axis is rotated into reference-plane height.
        expectRenderedBox(child, oldFrame, oldWidth, oldHeight)
        expect(child.clientWidth).toBe(width)
        expect(child.clientHeight).toBe(height)

        const untransformed = readLayoutBounds(child, wrapper)

        expect(untransformed.attached).toBe(true)
        expect(untransformed.x).toBeCloseTo(20, 3)
        expect(untransformed.y).toBeCloseTo(40, 3)
        expect(untransformed.width).toBe(width)
        expect(untransformed.height).toBe(height)
      } finally {
        root.remove()
      }
    },
  )

  it('keeps a child on its own trajectory while the parent has different timing', () => {
    const root = document.createElement('div')
    const wrapper = document.createElement('div')
    const child = document.createElement('div')
    const ancestor = ancestors[1]
    const frame = multiplyProjection(ancestor, { a: 1, b: 0, c: 0, d: 1, e: 20, f: 40 })
    const destination = { x: frame.e, y: frame.f, width: 80, height: 40 }
    const motion = projectionMotion(
      {
        box: { ...destination, x: destination.x - 40, width: 120, height: 20 },
        velocity: { x: 0, y: 0, width: 0, height: 0 },
      },
      destination,
      { x: true, y: true, width: true, height: true },
      { kind: 'tween', durationMs: 200, easing: 'linear' },
    )

    if (motion.kind !== 'motion') throw new Error('Expected motion')

    root.style.cssText = 'position: absolute; left: 0; top: 0; transform-origin: 0 0'
    wrapper.style.cssText = `position: absolute; left: 0; top: 0; transform-origin: 0 0; transform: ${css(ancestor)}`
    child.style.cssText =
      'position: absolute; left: 20px; top: 40px; width: 80px; height: 40px; transform-origin: 0 0'
    root.append(wrapper)
    wrapper.append(child)
    document.body.append(root)

    try {
      for (const time of [0, 50, 100, 150, 200]) {
        // Parent timing progresses twice as slowly as the child; its scale and
        // translation therefore cannot be assumed equal to the child's sample.
        const parentProgress = time / 400
        const parent = {
          a: 2 - parentProgress,
          b: 0,
          c: 0,
          d: 0.5 + parentProgress / 2,
          e: 40 * (1 - parentProgress),
          f: 20 * (1 - parentProgress),
        }
        const sample = motion.sample(time)
        const correction = projectionTransform(sample.box, destination, frame, parent)

        if (correction.kind !== 'projection') throw new Error('Expected projection')

        root.style.transform = css(parent)
        child.style.transform = correction.transform

        const progress = time / 200
        const expected = { ...ancestor, e: frame.e - 40 * (1 - progress), f: frame.f }

        expectRenderedBox(child, expected, 120 - 40 * progress, 20 + 20 * progress)
        expect(child.clientWidth).toBe(80)
        expect(child.clientHeight).toBe(40)
      }
    } finally {
      root.remove()
    }
  })
  it.each([
    { width: 0, oldHeight: 40, height: 40 },
    { width: 50, oldHeight: 0, height: 0 },
    { width: 0, oldHeight: 0, height: 0 },
    { width: 0, oldHeight: 40, height: 80 },
  ])(
    'projects measurable collapsed axes through a skewed frame: %j',
    ({ width, oldHeight, height }) => {
      const wrapper = document.createElement('div')
      const child = document.createElement('div')
      const ancestor = ancestors[1]
      const frame = multiplyProjection(ancestor, { a: 1, b: 0, c: 0, d: 1, e: 20, f: 100 })
      const oldFrame = multiplyProjection(ancestor, { a: 1, b: 0, c: 0, d: 1, e: 20, f: 20 })
      const destination = { x: frame.e, y: frame.f, width, height }
      const motion = projectionMotion(
        {
          box: { x: oldFrame.e, y: oldFrame.f, width, height: oldHeight },
          velocity: { x: 0, y: 0, width: 0, height: 0 },
        },
        destination,
        { x: true, y: true, width: false, height: true },
        { kind: 'tween', durationMs: 100, easing: 'linear' },
      )

      if (motion.kind !== 'motion') throw new Error('Expected collapsed-axis motion')

      wrapper.style.cssText = `position: absolute; left: 0; top: 0; transform-origin: 0 0; transform: ${css(ancestor)}`
      child.style.cssText = `position: absolute; left: 20px; top: 100px; width: ${width}px; height: ${height}px; transform-origin: 0 0`
      wrapper.append(child)
      document.body.append(wrapper)

      try {
        for (const time of [0, 50, 100]) {
          const sample = motion.sample(time)
          const correction = projectionTransform(sample.box, destination, frame)

          if (correction.kind !== 'projection') throw new Error('Expected collapsed-axis transform')

          child.style.transform = correction.transform

          const progress = time / 100
          const expected = {
            ...ancestor,
            e: oldFrame.e + (frame.e - oldFrame.e) * progress,
            f: oldFrame.f + (frame.f - oldFrame.f) * progress,
          }
          const measured = readLayoutBounds(child, wrapper)

          expectRenderedBox(child, expected, width, oldHeight + (height - oldHeight) * progress)
          expect(measured.attached).toBe(true)
          expect(measured.width).toBe(width)
          expect(measured.height).toBe(height)
        }
      } finally {
        wrapper.remove()
      }
    },
  )
})
