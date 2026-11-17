import { describe, expect, it } from 'vite-plus/test'
import {
  projectionShape,
  projectionShapeMotion,
  projectionShapeTransform,
  type ProjectionShape,
  type ProjectionShapeState,
} from './projection-shape.ts'
import {
  projectionMotion,
  projectionTransform,
  type ProjectionBox,
  type ProjectionMatrix,
} from './projection.ts'
import type { Timing } from '../model/definition.ts'
import { springMotion } from '../motion/property-motion.ts'

const all = { x: true, y: true, width: true, height: true }
const physics = { kind: 'spring-physics', stiffness: 300, damping: 25, mass: 1 } as const
const zero: ProjectionShape = {
  origin: { x: 0, y: 0 },
  xEdge: { x: 0, y: 0 },
  yEdge: { x: 0, y: 0 },
}
const frames = [
  { name: 'ordinary', matrix: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 } },
  { name: 'skewed', matrix: { a: 0.906308, b: 0.422618, c: -0.229977, d: 0.996138, e: 0, f: 0 } },
  {
    name: 'reflected',
    matrix: { a: -0.906308, b: -0.422618, c: -0.229977, d: 0.996138, e: 0, f: 0 },
  },
  { name: 'quarter-turn', matrix: { a: 0, b: 1, c: -1, d: 0, e: 0, f: 0 } },
]
const sizes = [
  {
    name: 'width',
    from: { x: 0, y: 0, width: 100, height: 20 },
    to: { x: 0, y: 0, width: 1, height: 20 },
  },
  {
    name: 'height',
    from: { x: 0, y: 0, width: 20, height: 100 },
    to: { x: 0, y: 0, width: 20, height: 1 },
  },
  {
    name: 'both',
    from: { x: 0, y: 0, width: 100, height: 100 },
    to: { x: 0, y: 0, width: 1, height: 1 },
  },
]
const cases = frames.flatMap((frame) =>
  sizes.map((size) => ({ ...size, name: `${frame.name}/${size.name}`, frame: frame.matrix })),
)

function measured(box: ProjectionBox, frame: ProjectionMatrix) {
  const result = projectionShape(box, frame)

  if (!result) throw new Error('Expected physical shape')

  return result
}

function trajectory(start: ProjectionShapeState, end: ProjectionShape, timing: Timing = physics) {
  const result = projectionShapeMotion(start, end, all, timing)

  if (result.kind !== 'motion') throw new Error('Expected shape motion')

  return result
}

function components(value: ProjectionShape) {
  return [
    value.xEdge.x,
    value.xEdge.y,
    value.yEdge.x,
    value.yEdge.y,
    value.origin.x,
    value.origin.y,
  ]
}

describe('signed size boundary in full-shape motion', () => {
  it.each(cases)(
    'settles negative physical extent with a fixed directed basis: $name',
    ({ frame, from, to }) => {
      const motion = trajectory(
        { shape: measured(from, frame), velocity: zero },
        measured(to, frame),
      )
      const sample = motion.sample(220)
      const legacy = projectionMotion(
        { box: from, velocity: { x: 0, y: 0, width: 0, height: 0 } },
        to,
        all,
        physics,
      )

      if (legacy.kind !== 'motion') throw new Error('Expected legacy motion')

      expect(projectionTransform(legacy.sample(220).box, to, frame).kind).toBe('settle')
      expect(projectionShapeTransform(sample.shape, to, frame)).toEqual({
        kind: 'settle',
        reason: 'geometry',
      })
      expect(projectionShapeTransform(motion.sample(0).shape, to, frame).kind).toBe('projection')
      expect(projectionShapeTransform(motion.sample(motion.durationMs).shape, to, frame).kind).toBe(
        'projection',
      )
    },
  )
  it.each([
    { timing: physics, rate: -0.2, invalidAt: 220 },
    { timing: physics, rate: 0.2, invalidAt: 220 },
    // Duration fitting depends on the incoming derivative. These distinct sample
    // times lie inside each reference trajectory's negative-extent interval.
    {
      timing: { kind: 'spring-duration', durationMs: 450, bounce: 0.2 } as const,
      rate: -0.2,
      invalidAt: 160,
    },
    {
      timing: { kind: 'spring-duration', durationMs: 450, bounce: 0.2 } as const,
      rate: 0.2,
      invalidAt: 220,
    },
  ])(
    'preserves six-component trajectories for $timing.kind at radial rate $rate',
    ({ timing, rate, invalidAt }) => {
      const basis = frames[1].matrix
      const start = measured(sizes[0].from, basis)
      const end = measured(sizes[0].to, basis)
      const velocity = { ...zero, xEdge: { x: basis.a * rate, y: basis.b * rate } }
      const direct = springMotion(timing, components(start), components(end), components(velocity))
      const motion = trajectory({ shape: start, velocity }, end, timing)

      expect(motion.durationMs).toBe(direct.durationMs)

      for (const time of [0, 0.001, 40, 100, 220]) {
        const actual = motion.sample(time)
        const expected = direct.sample(time)

        expect(components(actual.shape)).toEqual(expected.value)
        expect(components(actual.velocity)).toEqual(expected.velocity)
      }

      const invalid = motion.sample(invalidAt)

      expect(invalid.shape.xEdge.x).toBeLessThan(0)
      expect(invalid.shape.invalidSize).toBe(true)
      expect(projectionShapeMotion(invalid, end, all, timing)).toEqual({
        kind: 'settle',
        reason: 'geometry',
      })
      expect(motion.sample(motion.durationMs)).toEqual({ shape: end, velocity: zero })
    },
  )

  it('does not treat nonparallel direction changes as a signed scalar size', () => {
    const start = { origin: { x: 0, y: 0 }, xEdge: { x: 10, y: 0 }, yEdge: { x: 0, y: 10 } }
    const end = { origin: { x: 0, y: 0 }, xEdge: { x: 0, y: 10 }, yEdge: { x: -10, y: 0 } }
    const motion = trajectory({ shape: start, velocity: zero }, end)
    const sample = motion.sample(220)
    const direct = springMotion(physics, components(start), components(end), components(zero))

    expect(components(sample.shape)).toEqual(direct.sample(220).value)
    expect(sample.shape.invalidSize).toBeUndefined()
    expect(projectionShapeTransform(sample.shape, { x: 0, y: 0, width: 10, height: 10 }).kind).toBe(
      'projection',
    )
  })

  it('preserves noncollinear incoming edge velocity without introducing a magnitude trajectory', () => {
    const basis = frames[1].matrix
    const start = measured(sizes[0].from, basis)
    const end = measured(sizes[0].to, basis)
    const velocity = { ...zero, xEdge: { x: 0.1, y: -0.2 } }
    const motion = trajectory({ shape: start, velocity }, end)
    const direct = springMotion(physics, components(start), components(end), components(velocity))
    const sample = motion.sample(40)

    expect(components(sample.shape)).toEqual(direct.sample(40).value)
    expect(components(sample.velocity)).toEqual(direct.sample(40).velocity)
    expect(sample.shape.invalidSize).toBeUndefined()
  })

  it('marks exact zero extent without latching invalidity onto later positive samples', () => {
    const from = { x: 0, y: 0, width: 2, height: 20 }
    const to = { ...from, width: 1 }
    const start = measured(from, frames[0].matrix)
    const end = measured(to, frames[0].matrix)
    const result = projectionShapeMotion(
      { shape: start, velocity: zero },
      end,
      all,
      { kind: 'tween', durationMs: 100, easing: 'custom' },
      () => ({ value: 2, velocity: 0 }),
    )

    if (result.kind !== 'motion') throw new Error('Expected controlled tween')

    const collapsed = result.sample(50)

    expect(collapsed.shape.xEdge).toEqual({ x: 0, y: 0 })
    expect(collapsed.shape.invalidSize).toBe(true)
    expect(projectionShapeTransform(collapsed.shape, to).kind).toBe('settle')
    expect(result.sample(100).shape).toEqual(end)

    const fresh = trajectory({ shape: end, velocity: zero }, start)

    expect(fresh.sample(0).shape.invalidSize).toBeUndefined()
    expect(projectionShapeTransform(fresh.sample(0).shape, from).kind).toBe('projection')
  })
})
