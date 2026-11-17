import { describe, expect, it } from 'vite-plus/test'
import {
  projectionShape,
  projectionShapeMotion,
  projectionShapeTransform,
  type ProjectionShape,
} from './projection-shape.ts'

const zero: ProjectionShape = {
  origin: { x: 0, y: 0 },
  xEdge: { x: 0, y: 0 },
  yEdge: { x: 0, y: 0 },
}
const all = { x: true, y: true, width: true, height: true }
const cases = [
  { from: [100, 20], to: [1, 20] },
  { from: [20, 100], to: [20, 1] },
  { from: [100, 100], to: [1, 1] },
].flatMap((size) => [
  { ...size, coefficients: [1, 0, 0, 1, 0, 0] },
  { ...size, coefficients: [0.906308, 0.422618, -0.229977, 0.996138, 0, 0] },
  { ...size, coefficients: [-0.906308, -0.422618, -0.229977, 0.996138, 0, 0] },
])

describe('physical size overshoot rendering', () => {
  it.each(cases)(
    'settles shrinking dimensions without mirroring a valid static frame: %j',
    ({ from, to, coefficients }) => {
      const frame = new DOMMatrix(coefficients)
      const destination = { x: 0, y: 0, width: to[0], height: to[1] }
      const start = projectionShape({ ...destination, width: from[0], height: from[1] }, frame)
      const end = projectionShape(destination, frame)

      if (!start || !end) throw new Error('Expected native shapes')

      const motion = projectionShapeMotion({ shape: start, velocity: zero }, end, all, {
        kind: 'spring-physics',
        stiffness: 300,
        damping: 25,
        mass: 1,
      })

      if (motion.kind !== 'motion') throw new Error('Expected spring motion')

      const root = document.createElement('div')
      const controlRoot = document.createElement('div')
      const target = document.createElement('div')
      const control = document.createElement('div')
      root.style.cssText =
        controlRoot.style.cssText = `position:absolute;left:0;top:0;transform-origin:0 0;transform:matrix(${coefficients.join(',')})`
      target.style.cssText =
        control.style.cssText = `width:${to[0]}px;height:${to[1]}px;transform-origin:0 0`
      root.append(target)
      controlRoot.append(control)
      document.body.append(root, controlRoot)

      try {
        const output = projectionShapeTransform(motion.sample(220).shape, destination, frame)

        expect(output).toEqual({ kind: 'settle', reason: 'geometry' })
        // Match the Executor's explicit settlement branch: release the temporary
        // transform and expose current natural layout, including reflected ancestors.
        target.style.transform = output.kind === 'projection' ? output.transform : ''
        const actual = target.getBoundingClientRect()
        const expected = control.getBoundingClientRect()

        expect(actual.x).toBeCloseTo(expected.x, 3)
        expect(actual.y).toBeCloseTo(expected.y, 3)
        expect(actual.width).toBeCloseTo(expected.width, 3)
        expect(actual.height).toBeCloseTo(expected.height, 3)
        expect(target.clientWidth).toBe(to[0])
        expect(target.clientHeight).toBe(to[1])
      } finally {
        root.remove()
        controlRoot.remove()
      }
    },
  )
})
