import { describe, expect, it } from 'vite-plus/test'
import { springMotion } from './property-motion.ts'

const physics = { kind: 'spring-physics', stiffness: 300, damping: 25, mass: 1 } as const

describe('spring momentum', () => {
  it.each([
    { kind: 'spring-physics', stiffness: 1, damping: 0.01, mass: 1 } as const,
    { kind: 'spring-physics', stiffness: 1e12, damping: 1, mass: 1 } as const,
  ])('reports impractical physics sampling instead of producing truncated motion', (timing) => {
    expect(() => springMotion(timing, [0], [100], [1])).toThrow(/cap/)
  })

  it.each([
    physics,
    { kind: 'spring-physics', stiffness: 100, damping: 20, mass: 1 } as const,
    { kind: 'spring-physics', stiffness: 100, damping: 40, mass: 1 } as const,
    { kind: 'spring-duration', durationMs: 450, bounce: 0.2 } as const,
  ])('preserves independent initial velocities for $kind', (timing) => {
    const motion = springMotion(timing, [10, 20], [100, 200], [-0.5, 0.8])

    expect(motion.sample(0).value).toEqual([10, 20])
    expect(motion.sample(0).velocity[0]).toBeCloseTo(-0.5)
    expect(motion.sample(0).velocity[1]).toBeCloseTo(0.8)
    expect(motion.sample(1).value[0]).toBeLessThan(10)
    expect(motion.sample(1).value[1]).toBeGreaterThan(20)
    expect(motion.samples.at(-1)?.value).toEqual([100, 200])
  })

  it('animates zero displacement with incoming velocity before returning', () => {
    const motion = springMotion(physics, [100], [100], [1])

    expect(motion.sample(20).value[0]).toBeGreaterThan(100)
    expect(motion.samples.at(-1)?.value).toEqual([100])
  })

  it('treats configured duration as a settling target with incoming velocity', () => {
    const motion = springMotion(
      { kind: 'spring-duration', durationMs: 400, bounce: 0.1 },
      [0],
      [100],
      [2],
    )

    expect(motion.durationMs).toBe(400)
    expect(motion.sample(400).value[0]).toBeCloseTo(100, 1)
    expect(motion.sample(400).velocity[0]).toBeCloseTo(0, 3)
  })

  it('rejects momentum that cannot settle within solver limits', () => {
    expect(() =>
      springMotion({ kind: 'spring-duration', durationMs: 1000, bounce: 0.95 }, [0], [1], [1e50]),
    ).toThrow('property sample cap')
    expect(() => springMotion(physics, [0], [100], [1e100])).toThrow('duration cap')
    expect(() =>
      springMotion({ kind: 'spring-duration', durationMs: 100, bounce: 0.2 }, [0], [100], [1e300]),
    ).toThrow('requested duration')
  })
})
