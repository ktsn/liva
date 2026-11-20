import { describe, expect, it } from 'vite-plus/test'
import { captureInheritedProjection } from './layout-capture.ts'
import { identityProjection } from './projection.ts'
import {
  projectionShape,
  projectionShapeMotion,
  projectionShapeTransform,
} from './projection-shape.ts'

const axes = { x: true, y: true, width: true, height: true }
const zero = { origin: { x: 0, y: 0 }, xEdge: { x: 0, y: 0 }, yEdge: { x: 0, y: 0 } }
const frame = { box: { x: 0, y: 0, width: 1, height: 80 }, frame: identityProjection }
const initial = projectionShape({ ...frame.box, width: 100 }, identityProjection)!
const destination = projectionShape(frame.box, identityProjection)!
const spring = projectionShapeMotion({ shape: initial, velocity: zero }, destination, axes, {
  kind: 'spring-physics',
  stiffness: 300,
  damping: 25,
  mass: 1,
})

function sample(time: number) {
  if (spring.kind !== 'motion') throw new Error('Expected a size spring')
  return spring.sample(time)
}

function childAt(time: number) {
  const output = projectionShapeTransform(sample(time).shape, frame.box, frame.frame)
  if (output.kind !== 'projection') throw new Error('Expected a valid parent sample')
  return {
    visual: { box: { x: 0, y: 0, width: 20, height: 10 }, frame: output.cumulative },
    parent: { frame, cumulative: output.cumulative, sample },
  }
}

/** Finds an actual solver validity crossing without changing its sampled values. */
function crossing(low: number, high: number) {
  const invalid = sample(low).shape.invalidSize
  for (let index = 0; index < 50; index++) {
    const mid = (low + high) / 2
    if (sample(mid).shape.invalidSize === invalid) low = mid
    else high = mid
  }
  return (low + high) / 2
}

describe('inherited projection handoff', () => {
  it('retains physical edge position and velocity through an affine parent basis', () => {
    const child = childAt(100)
    const captured = captureInheritedProjection(child.visual, child.parent, 100)
    const before = childAt(99.99)
    const after = childAt(100.01)

    expect(captured?.shape.xEdge.x).toBeCloseTo(20 * sample(100).shape.xEdge.x, 8)
    expect(captured?.velocity.xEdge.x).toBeCloseTo(
      ((after.visual.frame.a - before.visual.frame.a) * 20) / 0.02,
      8,
    )
  })

  it('settles a noninvertible inherited map before estimating a derivative', () => {
    const child = childAt(100)
    expect(
      captureInheritedProjection(
        child.visual,
        { ...child.parent, cumulative: { a: 0, b: 0, c: 0, d: 0, e: 0, f: 0 } },
        100,
      ),
    ).toBeUndefined()
  })

  it('settles a currently invalid spring size sample without dropping its validity marker', () => {
    const child = childAt(100)
    expect(sample(220).shape.invalidSize).toBe(true)
    expect(captureInheritedProjection(child.visual, child.parent, 220)).toBeUndefined()
  })

  it.each([
    { low: 0, high: 220, offset: -0.005 },
    { low: 220, high: 500, offset: 0.005 },
  ])(
    'settles a valid current sample whose neighboring derivative sample crosses invalid geometry: %j',
    ({ low, high, offset }) => {
      const at = crossing(low, high) + offset
      const child = childAt(at)
      expect(sample(at).shape.invalidSize).toBeUndefined()
      expect(captureInheritedProjection(child.visual, child.parent, at)).toBeUndefined()
    },
  )
})
