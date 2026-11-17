import { describe, expect, it } from 'vite-plus/test'
import {
  identityProjection,
  inverseProjection,
  multiplyProjection,
  projectionComponents,
  projectionMotion,
  projectionState,
  projectionTransform,
  type ProjectionMatrix,
  type ProjectionMotionResult,
} from './projection.ts'

const all = { x: true, y: true, width: true, height: true }
const axes = ['x', 'y', 'width', 'height'] as const
const physics = { kind: 'spring-physics', stiffness: 300, damping: 25, mass: 1 } as const
const destination = { x: 100, y: 80, width: 200, height: 100 }
const start = {
  box: { x: 10, y: 30, width: 100, height: 50 },
  velocity: { x: -0.3, y: 0.2, width: 0.1, height: -0.05 },
}

function moving(result: ProjectionMotionResult) {
  if (result.kind !== 'motion') throw new Error('Expected motion')

  return result
}

function expectMatrix(actual: ProjectionMatrix, expected: ProjectionMatrix) {
  for (const key of ['a', 'b', 'c', 'd', 'e', 'f'] as const) {
    // A few dozen IEEE-754 operations at these sub-1000px magnitudes incur far
    // less error than 1e-10; browser serialization has its own separate tolerance.
    expect(actual[key]).toBeCloseTo(expected[key], 10)
  }
}

describe('projection motion', () => {
  it('retargets physical size and velocity into a changed destination basis', () => {
    const old = projectionComponents(start, destination)

    if (!old) throw new Error('Expected components')

    const retained = projectionState(old, destination)

    if (!retained) throw new Error('Expected physical state')

    const next = projectionComponents(retained, { ...destination, width: 50, height: 200 })

    expect(retained).toEqual(start)
    expect(old.scaleX).toBe(0.5)
    expect(old.velocityScaleX).toBe(0.0005)
    expect(next?.scaleX).toBe(2)
    expect(next?.velocityScaleX).toBe(0.002)
    expect(next?.velocityScaleY).toBe(-0.00025)
  })

  it.each([physics, { kind: 'spring-duration', durationMs: 450, bounce: 0.2 } as const])(
    'preserves independent handoff derivatives for $kind and finishes at rest',
    (timing) => {
      const motion = moving(projectionMotion(start, destination, all, timing))
      const first = motion.sample(0)
      const later = motion.sample(0.001)

      for (const axis of axes) {
        expect(first.box[axis]).toBeCloseTo(start.box[axis], 10)
        expect(first.velocity[axis]).toBeCloseTo(start.velocity[axis], 10)
        expect((later.box[axis] - first.box[axis]) / 0.001).toBeCloseTo(start.velocity[axis], 2)
      }

      expect(motion.sample(motion.durationMs)).toEqual({
        box: destination,
        velocity: { x: 0, y: 0, width: 0, height: 0 },
      })
    },
  )

  it.each(
    Array.from({ length: 15 }, (_, index) => ({
      x: Boolean((index + 1) & 1),
      y: Boolean((index + 1) & 2),
      width: Boolean((index + 1) & 4),
      height: Boolean((index + 1) & 8),
    })),
  )('retains only selected component position and velocity: %j', (selection) => {
    const result = projectionMotion(start, destination, selection, physics)

    const first = moving(result).sample(0)

    for (const axis of axes) {
      expect(first.box[axis]).toBeCloseTo(selection[axis] ? start.box[axis] : destination[axis], 10)
      expect(first.velocity[axis]).toBeCloseTo(selection[axis] ? start.velocity[axis] : 0, 10)
    }
  })

  it('settles a disabled selection even with incoming velocity', () => {
    expect(
      projectionMotion(
        start,
        destination,
        { x: false, y: false, width: false, height: false },
        physics,
      ),
    ).toEqual({ kind: 'settle', reason: 'inactive' })
  })

  it('retains momentum at equal endpoints', () => {
    const motion = moving(
      projectionMotion({ ...start, box: destination }, destination, all, physics),
    )

    expect(motion.sample(20).box.x).toBeLessThan(destination.x)
    expect(motion.sample(20).box.y).toBeGreaterThan(destination.y)
    expect(motion.sample(20).box.width).toBeGreaterThan(destination.width)
    expect(motion.sample(20).box.height).toBeLessThan(destination.height)
  })

  it('retargets a reversal from displayed state rather than the old destination', () => {
    const first = moving(projectionMotion(start, destination, all, physics))
    const handoff = first.sample(100)
    const reversal = moving(projectionMotion(handoff, start.box, all, physics))
    const resumed = reversal.sample(0)

    for (const axis of axes) {
      expect(resumed.box[axis]).toBeCloseTo(handoff.box[axis], 10)
      expect(resumed.velocity[axis]).toBeCloseTo(handoff.velocity[axis], 10)
    }

    expect(reversal.sample(reversal.durationMs).box).toEqual(start.box)
  })

  it('samples supplied browser easing and replaces incoming spring momentum', () => {
    const motion = moving(
      projectionMotion(
        start,
        destination,
        all,
        { kind: 'tween', durationMs: 200, easing: 'ease-in' },
        (ms) => ({ value: (ms / 200) ** 2, velocity: ms / 20000 }),
      ),
    )

    expect(motion.sample(100).box.x).toBe(32.5)
    expect(motion.sample(100).velocity.x).toBe(0.45)
    expect(motion.sample(-20).box).toEqual(start.box)
    expect(() => motion.sample(NaN)).toThrow('finite milliseconds')
  })

  it('copies retained snapshots and computes linear tween time independently of reads', () => {
    const input = { ...start, box: { ...start.box } }
    const end = { ...destination }
    const motion = moving(
      projectionMotion(input, end, all, { kind: 'tween', durationMs: 100, easing: 'linear' }),
    )

    input.box.x = -1000
    end.x = -2000

    expect(motion.sample(25).box.x).toBe(32.5)
    expect(motion.sample(50).box.x).toBe(55)
    expect(motion.sample(50).velocity.x).toBe(0.9)
    expect(motion.sample(25).box.x).toBe(32.5)
  })

  it.each([undefined, { ...destination, width: 0 }, { ...destination, height: NaN }])(
    'settles unusable destination: %j',
    (end) => {
      expect(projectionMotion(start, end, all, physics).kind).toBe('settle')
    },
  )

  it('settles absent starts, invalid velocity, rest, instant timing and absent timing', () => {
    expect(projectionMotion(undefined, destination, all, physics)).toEqual({
      kind: 'settle',
      reason: 'missing',
    })
    expect(
      projectionMotion(
        { ...start, velocity: { ...start.velocity, y: Infinity } },
        destination,
        all,
        physics,
      ),
    ).toEqual({ kind: 'settle', reason: 'geometry' })
    expect(
      projectionMotion(
        { box: destination, velocity: { x: 0, y: 0, width: 0, height: 0 } },
        destination,
        all,
        physics,
      ),
    ).toEqual({ kind: 'settle', reason: 'inactive' })
    expect(projectionMotion(start, destination, all, undefined).kind).toBe('settle')
    expect(
      projectionMotion(start, destination, all, { kind: 'tween', durationMs: 0, easing: 'linear' })
        .kind,
    ).toBe('settle')
  })

  it('reports invalid tween contracts instead of substituting easing', () => {
    expect(() =>
      projectionMotion(start, destination, all, {
        kind: 'tween',
        durationMs: -1,
        easing: 'linear',
      }),
    ).toThrow('duration')
    expect(() =>
      projectionMotion(start, destination, all, { kind: 'tween', durationMs: 100, easing: 'ease' }),
    ).toThrow('easing sampler')

    const motion = moving(
      projectionMotion(
        start,
        destination,
        all,
        { kind: 'tween', durationMs: 100, easing: 'ease' },
        () => ({ value: NaN, velocity: 0 }),
      ),
    )

    expect(() => motion.sample(50)).toThrow('sample must be finite')
  })
})

describe('projection coordinates and ancestor compensation', () => {
  it.each([
    identityProjection,
    { a: 0, b: 2, c: -3, d: 0, e: 100.25, f: -41.75 },
    { a: 1.5, b: 0.4, c: 0.7, d: 2, e: -230.5, f: 43.25 },
  ])('matches the desired local-size frame through anisotropic parent correction: %j', (frame) => {
    const parent = { a: 2, b: 0, c: 0, d: 0.5, e: 40, f: -20 }
    const origin = { x: 23.5, y: 7.25 }
    const result = projectionTransform(
      start.box,
      { ...destination, x: frame.e, y: frame.f },
      frame,
      parent,
      origin,
    )

    if (result.kind !== 'projection') throw new Error('Expected projection')

    // Undo CSS's target-pivot convention before composing into the shared plane.
    const local = {
      ...result.matrix,
      e: result.matrix.e + origin.x - result.matrix.a * origin.x - result.matrix.c * origin.y,
      f: result.matrix.f + origin.y - result.matrix.b * origin.x - result.matrix.d * origin.y,
    }
    const rendered = multiplyProjection(parent, multiplyProjection(frame, local))
    const desired = {
      a: frame.a * 0.5,
      b: frame.b * 0.5,
      c: frame.c * 0.5,
      d: frame.d * 0.5,
      e: start.box.x,
      f: start.box.y,
    }

    expectMatrix(rendered, desired)
    expectMatrix(multiplyProjection(result.cumulative, frame), desired)
    expect(result.transform).toContain('matrix(')
    expect(result.scale.x).toBeCloseTo(0.5, 12)
    expect(result.scale.y).toBeCloseTo(0.5, 12)
  })

  it('avoids doubled parent correction when a child follows the same trajectory', () => {
    const frame = { ...identityProjection, e: destination.x, f: destination.y }
    const parent = projectionTransform(start.box, destination, frame)

    if (parent.kind !== 'projection') throw new Error('Expected projection')

    const child = projectionTransform(start.box, destination, frame, parent.cumulative)

    if (child.kind !== 'projection') throw new Error('Expected projection')

    expectMatrix(child.matrix, identityProjection)
    expect(child.scale).toEqual({ x: 0.5, y: 0.5 })
  })

  it('leaves unchanged scroll-neutral shapes at identity', () => {
    const unchanged = { ...destination, x: 301.25, y: 47.5 }
    const frame = { ...identityProjection, e: unchanged.x, f: unchanged.y }
    const result = projectionTransform(unchanged, unchanged, frame)

    if (result.kind !== 'projection') throw new Error('Expected projection')

    expect(result.scale).toEqual({ x: 1, y: 1 })
    expectMatrix(result.matrix, identityProjection)
  })

  it('rejects singular geometry and preserves tiny representable scale inverses', () => {
    expect(inverseProjection({ ...identityProjection, a: 0 })).toBeUndefined()
    expect(projectionTransform(start.box, destination, { ...identityProjection, a: 0 })).toEqual({
      kind: 'settle',
      reason: 'singular',
    })
    expect(projectionTransform({ ...start.box, width: 0 }, destination)).toEqual({
      kind: 'settle',
      reason: 'geometry',
    })
    expect(inverseProjection({ ...identityProjection, a: 1e-20 })?.a).toBe(1e20)
  })
})

describe('projection numeric boundaries', () => {
  it('rejects nonfinite and numerically unrepresentable affine inverses', () => {
    expect(inverseProjection({ ...identityProjection, e: Infinity })).toBeUndefined()
    expect(inverseProjection({ ...identityProjection, a: 1e308, d: 1e308 })).toBeUndefined()
    expect(inverseProjection({ ...identityProjection, a: Number.MIN_VALUE })).toBeUndefined()
  })

  it('rejects invalid and unrepresentable shape/derivative ratios', () => {
    const tiny = { ...destination, width: Number.MIN_VALUE }
    const huge = { ...destination, x: 1e308, width: 1e308 }

    expect(projectionComponents(start, { ...destination, height: 0 })).toBeUndefined()
    expect(
      projectionComponents({ ...start, box: { ...start.box, height: 0 } }, destination),
    ).toBeUndefined()
    expect(
      projectionComponents({ ...start, velocity: { ...start.velocity, x: NaN } }, destination),
    ).toBeUndefined()
    expect(projectionComponents(start, tiny)).toBeUndefined()
    expect(projectionTransform(start.box, tiny)).toEqual({ kind: 'settle', reason: 'geometry' })
    expect(projectionTransform(tiny, huge)).toEqual({ kind: 'settle', reason: 'geometry' })
    expect(
      projectionTransform(start.box, destination, identityProjection, {
        ...identityProjection,
        a: 0,
      }).kind,
    ).toBe('settle')
    expect(
      projectionTransform(start.box, destination, identityProjection, identityProjection, {
        x: NaN,
        y: 0,
      }).kind,
    ).toBe('settle')
  })

  it('rejects invalid or overflowing physical reconstruction', () => {
    const components = projectionComponents(start, destination)

    if (!components) throw new Error('Expected components')

    expect(projectionState(components, { ...destination, width: 0 })).toBeUndefined()
    expect(projectionState({ ...components, scaleX: Infinity }, destination)).toBeUndefined()
    expect(projectionState({ ...components, scaleX: 0 }, destination)).toBeUndefined()
    expect(projectionState({ ...components, velocityScaleX: 1e308 }, destination)).toBeUndefined()
  })
})
