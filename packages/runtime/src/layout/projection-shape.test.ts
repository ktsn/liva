import { describe, expect, it } from 'vite-plus/test'
import {
  projectionShape,
  projectionShapeMotion,
  projectionShapeTransform,
  type ProjectionShape,
  type ProjectionShapeMotionResult,
} from './projection-shape.ts'
import { identityProjection, multiplyProjection, type ProjectionMatrix } from './projection.ts'

const all = { x: true, y: true, width: true, height: true }
const physics = { kind: 'spring-physics', stiffness: 300, damping: 25, mass: 1 } as const
const zero: ProjectionShape = {
  origin: { x: 0, y: 0 },
  xEdge: { x: 0, y: 0 },
  yEdge: { x: 0, y: 0 },
}
const frame = { a: 0.906308, b: 0.422618, c: -0.229977, d: 0.996138, e: 0, f: 0 }
const parent = { a: 0.625, b: 0, c: 0, d: 0.5, e: 0, f: 0 }
const oldShape: ProjectionShape = {
  origin: { x: 0, y: 0 },
  xEdge: { x: 22.6577, y: 8.45236 },
  yEdge: { x: -2.8747125, y: 9.96138 },
}
const endShape: ProjectionShape = {
  origin: { x: 0, y: 0 },
  xEdge: { x: 54.37848, y: 25.35708 },
  yEdge: { x: -4.59954, y: 19.92276 },
}

function moving(result: ProjectionShapeMotionResult) {
  if (result.kind !== 'motion') throw new Error('Expected affine motion')

  return result
}

function coordinates(value: ProjectionShape) {
  return [
    value.origin.x,
    value.origin.y,
    value.xEdge.x,
    value.xEdge.y,
    value.yEdge.x,
    value.yEdge.y,
  ]
}

function corners(value: ProjectionShape) {
  return [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ].map(([u, v]) => ({
    x: value.origin.x + u * value.xEdge.x + v * value.yEdge.x,
    y: value.origin.y + u * value.xEdge.y + v * value.yEdge.y,
  }))
}

function fromFrame(matrix: ProjectionMatrix, width: number, height: number): ProjectionShape {
  return {
    origin: { x: matrix.e, y: matrix.f },
    xEdge: { x: matrix.a * width, y: matrix.b * width },
    yEdge: { x: matrix.c * height, y: matrix.d * height },
  }
}

describe('full affine displayed shape', () => {
  it('retains nonparallel inherited edges instead of just column norms', () => {
    const oldFrame = multiplyProjection(parent, frame)
    const observed = projectionShape({ x: 0, y: 0, width: 40, height: 20 }, oldFrame)

    if (!observed) throw new Error('Expected measured shape')

    coordinates(observed).forEach((value, index) =>
      expect(value).toBeCloseTo(coordinates(oldShape)[index], 10),
    )

    const result = projectionShapeTransform(
      observed,
      { x: 0, y: 0, width: 60, height: 20 },
      frame,
      parent,
    )

    if (result.kind !== 'projection') throw new Error('Expected shape projection')

    const actualFrame = multiplyProjection(parent, multiplyProjection(frame, result.matrix))
    const actual = corners(fromFrame(actualFrame, 60, 20))
    const expected = corners(oldShape)

    actual.forEach((point, index) => {
      expect(point.x).toBeCloseTo(expected[index].x, 10)
      expect(point.y).toBeCloseTo(expected[index].y, 10)
    })
  })

  it.each(
    Array.from({ length: 15 }, (_, index) => ({
      x: Boolean((index + 1) & 1),
      y: Boolean((index + 1) & 2),
      width: Boolean((index + 1) & 4),
      height: Boolean((index + 1) & 8),
    })),
  )('selects whole edges and physical origin components: %j', (selection) => {
    const observed = { ...oldShape, origin: { x: 10, y: 20 } }
    const velocity = {
      origin: { x: -0.1, y: 0.2 },
      xEdge: { x: -0.3, y: 0.4 },
      yEdge: { x: 0.5, y: -0.6 },
    }
    const motion = moving(
      projectionShapeMotion({ shape: observed, velocity }, endShape, selection, physics),
    )
    const first = motion.sample(0)
    const selected = [
      selection.x,
      selection.y,
      selection.width,
      selection.width,
      selection.height,
      selection.height,
    ]

    coordinates(first.shape).forEach((value, index) => {
      expect(value).toBeCloseTo(
        selected[index] ? coordinates(observed)[index] : coordinates(endShape)[index],
        10,
      )
      expect(coordinates(first.velocity)[index]).toBeCloseTo(
        selected[index] ? coordinates(velocity)[index] : 0,
        10,
      )
    })
  })

  it.each([physics, { kind: 'spring-duration', durationMs: 450, bounce: 0.2 } as const])(
    'preserves every edge derivative across $kind retargeting',
    (timing) => {
      const velocity = {
        origin: { x: -0.2, y: 0.1 },
        xEdge: { x: 0.04, y: 0.02 },
        yEdge: { x: -0.03, y: 0.01 },
      }
      const first = moving(
        projectionShapeMotion({ shape: oldShape, velocity }, endShape, all, timing),
      )
      const handoff = first.sample(80)
      const reversal = moving(projectionShapeMotion(handoff, oldShape, all, timing))
      const start = reversal.sample(0)
      const after = reversal.sample(0.001)

      coordinates(start.shape).forEach((value, index) => {
        expect(value).toBeCloseTo(coordinates(handoff.shape)[index], 10)
        expect(coordinates(start.velocity)[index]).toBeCloseTo(
          coordinates(handoff.velocity)[index],
          10,
        )
        // A 1-microsecond forward difference resolves these bounded initial derivatives.
        expect((coordinates(after.shape)[index] - value) / 0.001).toBeCloseTo(
          coordinates(handoff.velocity)[index],
          3,
        )
      })

      expect(reversal.sample(reversal.durationMs)).toEqual({ shape: oldShape, velocity: zero })
    },
  )

  it('inherits the physical edge velocity of the reported active anisotropic parent', () => {
    // Parent width/height rates are 0.1/200 and 0.16/240 per ms. The product
    // rule yields these reference-plane derivatives for the old 40x20 child.
    const velocity = {
      origin: { x: 0, y: 0 },
      xEdge: { x: 0.01812616, y: 0.011269813333333333 },
      yEdge: { x: -0.00229977, y: 0.01328184 },
    }
    const motion = moving(
      projectionShapeMotion({ shape: oldShape, velocity }, endShape, all, physics),
    )
    const first = motion.sample(0)
    const after = motion.sample(0.001)

    coordinates(first.velocity).forEach((value, index) => {
      expect(value).toBeCloseTo(coordinates(velocity)[index], 12)
      expect(
        (coordinates(after.shape)[index] - coordinates(first.shape)[index]) / 0.001,
      ).toBeCloseTo(coordinates(velocity)[index], 3)
    })
  })

  it('retains equal-endpoint edge momentum', () => {
    const motion = moving(
      projectionShapeMotion(
        { shape: oldShape, velocity: { ...zero, xEdge: { x: 0.1, y: -0.2 } } },
        oldShape,
        all,
        physics,
      ),
    )

    expect(motion.sample(20).shape.xEdge.x).toBeGreaterThan(oldShape.xEdge.x)
    expect(motion.sample(20).shape.xEdge.y).toBeLessThan(oldShape.xEdge.y)
  })

  it('copies inputs and samples corners from browser easing progress', () => {
    const observed = {
      origin: { ...oldShape.origin },
      xEdge: { ...oldShape.xEdge },
      yEdge: { ...oldShape.yEdge },
    }
    const end = {
      origin: { ...endShape.origin },
      xEdge: { ...endShape.xEdge },
      yEdge: { ...endShape.yEdge },
    }
    const motion = moving(
      projectionShapeMotion(
        { shape: observed, velocity: zero },
        end,
        all,
        { kind: 'tween', durationMs: 200, easing: 'ease-in' },
        (ms) => ({ value: (ms / 200) ** 2, velocity: ms / 20000 }),
      ),
    )

    observed.xEdge.x = 1000
    end.yEdge.y = 2000

    const actual = corners(motion.sample(100).shape)
    const before = corners(oldShape)
    const target = corners(endShape)

    actual.forEach((point, index) => {
      expect(point.x).toBeCloseTo(before[index].x * 0.75 + target[index].x * 0.25, 10)
      expect(point.y).toBeCloseTo(before[index].y * 0.75 + target[index].y * 0.25, 10)
    })
  })

  it('preserves a retained shape when the renderer changes dimensions, origin and frame', () => {
    const actualFrame = multiplyProjection(frame, { ...identityProjection, e: 20, f: -10 })
    const result = projectionShapeTransform(
      oldShape,
      { x: actualFrame.e, y: actualFrame.f, width: 100, height: 40 },
      actualFrame,
      parent,
      { x: 50, y: 20 },
    )

    if (result.kind !== 'projection') throw new Error('Expected reframed projection')

    const local = {
      ...result.matrix,
      e: result.matrix.e + 50 - result.matrix.a * 50 - result.matrix.c * 20,
      f: result.matrix.f + 20 - result.matrix.b * 50 - result.matrix.d * 20,
    }
    const rendered = fromFrame(
      multiplyProjection(parent, multiplyProjection(actualFrame, local)),
      100,
      40,
    )

    coordinates(rendered).forEach((value, index) =>
      expect(value).toBeCloseTo(coordinates(oldShape)[index], 10),
    )
  })
})

describe('affine shape boundaries', () => {
  it('settles missing, invalid or inactive inputs', () => {
    expect(projectionShapeMotion(undefined, endShape, all, physics)).toEqual({
      kind: 'settle',
      reason: 'missing',
    })
    expect(
      projectionShapeMotion({ shape: oldShape, velocity: zero }, undefined, all, physics).kind,
    ).toBe('settle')
    expect(
      projectionShapeMotion(
        { shape: { ...oldShape, origin: { x: NaN, y: 0 } }, velocity: zero },
        endShape,
        all,
        physics,
      ),
    ).toEqual({ kind: 'settle', reason: 'geometry' })
    expect(
      projectionShapeMotion(
        { shape: oldShape, velocity: { ...zero, yEdge: { x: Infinity, y: 0 } } },
        endShape,
        all,
        physics,
      ).kind,
    ).toBe('settle')
    expect(
      projectionShapeMotion(
        { shape: oldShape, velocity: zero },
        { ...endShape, xEdge: endShape.yEdge },
        all,
        physics,
      ).kind,
    ).toBe('settle')
    expect(
      projectionShapeMotion({ shape: oldShape, velocity: zero }, endShape, all, undefined),
    ).toEqual({ kind: 'settle', reason: 'inactive' })
    expect(
      projectionShapeMotion(
        { shape: oldShape, velocity: zero },
        endShape,
        { x: false, y: false, width: false, height: false },
        physics,
      ).kind,
    ).toBe('settle')
    expect(
      projectionShapeMotion({ shape: oldShape, velocity: zero }, oldShape, all, physics).kind,
    ).toBe('settle')
    expect(
      projectionShapeMotion({ shape: oldShape, velocity: zero }, endShape, all, {
        kind: 'tween',
        durationMs: 0,
        easing: 'linear',
      }).kind,
    ).toBe('settle')
  })

  it.each(['xEdge', 'yEdge'] as const)(
    'moves a collapsed %s and clears inactive size velocity',
    (edge) => {
      const collapsed = { ...oldShape, [edge]: { x: 0, y: 0 } }
      const next = { ...collapsed, origin: { x: 30, y: 40 } }
      const motion = moving(
        projectionShapeMotion(
          { shape: collapsed, velocity: { ...zero, [edge]: { x: 2, y: 3 } } },
          next,
          { x: true, y: true, width: edge !== 'xEdge', height: edge !== 'yEdge' },
          { kind: 'tween', durationMs: 100, easing: 'linear' },
        ),
      )

      expect(motion.sample(50).shape[edge]).toEqual({ x: 0, y: 0 })
      expect(motion.sample(50).velocity[edge]).toEqual({ x: 0, y: 0 })
      expect(motion.sample(50).shape.origin).toEqual({ x: 15, y: 20 })
      expect(
        projectionShapeMotion({ shape: collapsed, velocity: zero }, endShape, all, physics),
      ).toEqual({ kind: 'settle', reason: 'geometry' })
      expect(
        projectionShapeMotion({ shape: endShape, velocity: zero }, collapsed, all, physics).kind,
      ).toBe('settle')
      expect(
        projectionShapeMotion(
          { shape: collapsed, velocity: { ...zero, [edge]: { x: 1, y: 0 } } },
          collapsed,
          all,
          physics,
        ).kind,
      ).toBe('settle')
      expect(
        projectionShapeMotion(
          { shape: collapsed, velocity: { ...zero, [edge]: { x: 0, y: 1 } } },
          collapsed,
          all,
          physics,
        ).kind,
      ).toBe('settle')
    },
  )

  it('represents collapsed visible lines with a canonical nonparallel missing column', () => {
    const basis = { a: 1, b: 1, c: 1, d: 2, e: 0, f: 0 }
    const widthZero = { origin: { x: 10, y: 20 }, xEdge: { x: 0, y: 0 }, yEdge: { x: 40, y: 40 } }
    const heightZero = { origin: { x: 10, y: 20 }, xEdge: { x: 20, y: 40 }, yEdge: { x: 0, y: 0 } }

    expect(
      projectionShapeTransform(widthZero, { x: 0, y: 0, width: 0, height: 20 }, basis).kind,
    ).toBe('projection')
    expect(
      projectionShapeTransform(heightZero, { x: 0, y: 0, width: 20, height: 0 }, basis).kind,
    ).toBe('projection')
    expect(projectionShapeTransform(zero, { x: 0, y: 0, width: 0, height: 0 }).kind).toBe(
      'projection',
    )
    expect(
      projectionShapeTransform(
        widthZero,
        { x: 0, y: 0, width: 0, height: 20 },
        { ...basis, a: -1, b: -1 },
      ).kind,
    ).toBe('projection')
  })

  it('rejects invalid or numerically unrepresentable shape construction', () => {
    const unit = { x: 0, y: 0, width: 1, height: 1 }

    expect(projectionShape({ ...unit, width: -1 }, identityProjection)).toBeUndefined()
    expect(projectionShape({ ...unit, height: -1 }, identityProjection)).toBeUndefined()
    expect(projectionShape(unit, { ...identityProjection, a: 0 })).toBeUndefined()
    expect(
      projectionShape({ ...unit, width: 1e308 }, { ...identityProjection, a: 1e308, d: 1e-308 }),
    ).toBeUndefined()
    expect(
      projectionShape({ ...unit, width: 1e-200 }, { ...identityProjection, a: 1e-200, d: 1e200 }),
    ).toBeUndefined()
    expect(
      projectionShape({ ...unit, height: 1e-200 }, { ...identityProjection, a: 1e200, d: 1e-200 }),
    ).toBeUndefined()
  })

  it('rejects singular or invalid rendered shapes without emitting invalid transforms', () => {
    const unit = { x: 0, y: 0, width: 1, height: 1 }

    expect(projectionShapeTransform({ ...oldShape, yEdge: oldShape.xEdge }, unit)).toEqual({
      kind: 'settle',
      reason: 'geometry',
    })
    expect(projectionShapeTransform({ ...oldShape, origin: { x: NaN, y: 0 } }, unit).kind).toBe(
      'settle',
    )
    expect(projectionShapeTransform(oldShape, { ...unit, width: -1 }).kind).toBe('settle')
    expect(projectionShapeTransform(oldShape, { ...unit, height: -1 }).kind).toBe('settle')
    expect(projectionShapeTransform(oldShape, { ...unit, width: 0 }).kind).toBe('settle')
    expect(projectionShapeTransform(oldShape, { ...unit, height: 0 }).kind).toBe('settle')
    expect(
      projectionShapeTransform(oldShape, unit, identityProjection, identityProjection, {
        x: Infinity,
        y: 0,
      }).kind,
    ).toBe('settle')
  })
})
