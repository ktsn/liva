import { describe, expect, it } from 'vite-plus/test'
import fixture from '../../../../fixtures/toggle.json'
import { decodeBundle, type Definition, type Timing } from '../definition.ts'
import { resolve } from '../resolve.ts'
import { sampleSpring, springResponse, SPRING_ERROR } from '../spring.ts'
import { waapiProperty } from '../instance.ts'

const definition = decodeBundle(JSON.stringify(fixture)).definitions[0]
const tween = (durationMs: number): Timing => ({ kind: 'tween', durationMs, easing: 'linear' })

function changed(mutator: (definition: any) => void): Definition {
  const copy = structuredClone(definition)
  mutator(copy)
  return copy
}

describe('transition resolution', () => {
  it('preserves general property timing over directional global timing', () => {
    const def = changed((d) => {
      d.directionalTransitions[0].transition.timing = tween(500)
    })
    const tracks = resolve(def, 'on', 'off')
    expect(tracks.find((t) => t.property === 'background-color')?.timing).toEqual({
      kind: 'tween',
      durationMs: 200,
      easing: 'ease-in-out',
    })
    expect(tracks.find((t) => t.property === 'translate')?.timing).toEqual({
      kind: 'spring-duration',
      durationMs: 350,
      bounce: 0.25,
    })
    expect(tracks.find((t) => t.property === 'scale')?.timing).toEqual(tween(500))
  })

  it('replaces frames atomically and schedules equal-value pulses', () => {
    const def = changed((d) => {
      d.directionalTransitions[0].transition.targets[0].properties.push({
        name: 'scale',
        keyframes: [{ offset: 0.6, value: '2' }],
      })
    })
    const scale = resolve(def, 'on', 'off').find((t) => t.property === 'scale')!
    expect(scale.keyframes.map((f) => f.offset)).toEqual([0, 0.6, 1])
    expect(scale.keyframes.map((f) => f.value)).toEqual(['1', '2', '1'])
    expect(resolve(def, 'off', 'off')).toEqual([])
    expect(() => resolve(def, 'off', 'missing')).toThrow('Unknown')
  })

  it('retains explicit endpoints and rejects effective spring frames', () => {
    const def = changed((d) => {
      d.generalTransition.targets[1].properties[1].keyframes = [
        { offset: 0, value: '2', easing: 'steps(2)' },
        { offset: 1, value: '3' },
      ]
    })
    const scale = resolve(def, 'off', 'on').find((t) => t.property === 'scale')!
    expect(scale.destinationValue).toBe('1')
    expect(scale.keyframes[0]).toEqual({ offset: 0, value: '2', easing: 'steps(2)' })
    const springFrames = changed((d) => {
      d.generalTransition.timing = { kind: 'spring-duration', durationMs: 350, bounce: 0.2 }
    })
    expect(() => resolve(springFrames, 'off', 'on')).toThrow('Spring')
  })

  it('maps WAAPI keys without probing browser support', () => {
    expect(
      [
        'background-color',
        '--offset',
        'offset',
        'float',
        'easing',
        'composite',
        'unknown-property',
      ].map(waapiProperty),
    ).toEqual([
      'backgroundColor',
      '--offset',
      'cssOffset',
      'cssFloat',
      '-easing',
      '-composite',
      'unknownProperty',
    ])
  })
})

describe('scalar spring solver', () => {
  it.each([10, 20, 40, 300])('is deterministic and converges for damping %s', (damping) => {
    const timing = { kind: 'spring-physics', stiffness: 300, damping, mass: 1 } as const
    const a = sampleSpring(timing)
    expect(a).toEqual(sampleSpring(timing))
    expect(a.samples[0]).toEqual({ time: 0, value: 0 })
    expect(a.samples.at(-1)).toEqual({ time: 1, value: 1 })
    expect(a.durationMs).toBeLessThan(10_000)

    for (let i = 1; i < a.samples.length; i++) {
      const left = a.samples[i - 1]
      const right = a.samples[i]

      for (const fraction of [0.25, 0.5, 0.75]) {
        const time = left.time + (right.time - left.time) * fraction
        const linear = left.value + (right.value - left.value) * fraction
        expect(
          Math.abs(linear - springResponse(300, damping, 1, (time * a.durationMs) / 1000).value),
        ).toBeLessThan(SPRING_ERROR * 1.02)
      }
    }
  })

  it('retains overshoot and scales duration mode', () => {
    const physics = sampleSpring({ kind: 'spring-physics', stiffness: 300, damping: 10, mass: 1 })
    expect(Math.max(...physics.samples.map((s) => s.value))).toBeGreaterThan(1.3)
    const a = sampleSpring({ kind: 'spring-duration', durationMs: 350, bounce: 0.5 })
    const b = sampleSpring({ kind: 'spring-duration', durationMs: 700, bounce: 0.5 })
    expect(a.durationMs).toBe(350)
    expect(b.durationMs).toBe(700)
    expect(a.samples.length).toBe(b.samples.length)
    expect(Math.max(...a.samples.map((s) => s.value))).toBeGreaterThan(1)
  })

  it('reports nonconvergence and excessive work', () => {
    expect(() =>
      sampleSpring({ kind: 'spring-physics', stiffness: 300, damping: 0.0001, mass: 1 }),
    ).toThrow('cap')
    expect(() =>
      sampleSpring({ kind: 'spring-physics', stiffness: 1e100, damping: 1, mass: 1 }),
    ).toThrow('cap')
  })
})

it('rejects incomplete transitions and invalid frame offsets', () => {
  const incomplete = changed((d) => {
    d.states[0].targets = []
  })

  expect(() => resolve(incomplete, 'off', 'on')).toThrow('Incomplete state')

  const missing = changed((d) => {
    d.generalTransition = undefined
    d.directionalTransitions = []
  })

  expect(() => resolve(missing, 'off', 'on')).toThrow('Missing timing')

  for (const offsets of [[-0.1], [1.1], [NaN], [0.5, 0.5]]) {
    const invalid = changed((d) => {
      d.generalTransition.targets[1].properties[1].keyframes = offsets.map((offset) => ({
        offset,
        value: '2',
      }))
    })

    expect(() => resolve(invalid, 'off', 'on')).toThrow('Invalid or duplicate')
  }
})

it('settles reactive template properties without transition timing', () => {
  const def = changed((d) => {
    d.generalTransition = undefined
    d.directionalTransitions = []

    for (const state of d.states) {
      for (const target of state.targets) {
        for (const property of target.properties) property.template = [property.value]
      }
    }
  })

  expect(resolve(def, 'off', 'on')).toEqual([])
})

it('rejects invalid duration springs and resolves critical damping', () => {
  for (const durationMs of [0, -1, Infinity, NaN]) {
    expect(() => sampleSpring({ kind: 'spring-duration', durationMs, bounce: 0 })).toThrow(
      'Invalid spring parameters',
    )
  }

  const critical = springResponse(100, 20, 1, 0.5)

  expect(critical.value).toBeCloseTo(1 - 6 * Math.exp(-5), 12)
  expect(critical.velocity).toBeCloseTo(50 * Math.exp(-5), 12)
  expect(() =>
    sampleSpring({ kind: 'spring-physics', stiffness: -1, damping: 1, mass: 1 }),
  ).toThrow('solver sample cap')
})

it('bounds the number of easing samples for a stiff, slowly damped spring', () => {
  expect(() =>
    sampleSpring({ kind: 'spring-physics', stiffness: 100000, damping: 5, mass: 1 }),
  ).toThrow('easing sample cap')
})

it('enforces the sample cap after adaptive refinement', () => {
  expect(() =>
    sampleSpring({ kind: 'spring-physics', stiffness: 100000, damping: 10.02, mass: 1 }),
  ).toThrow('easing sample cap')
})

it('rejects easing attached to spring endpoints', () => {
  const invalid = changed((d) => {
    const property = d.generalTransition.targets[1].properties[0]

    property.keyframes = [{ offset: 0, value: '0 0', easing: 'linear' }]
  })

  expect(() => resolve(invalid, 'off', 'on')).toThrow('Spring tracks cannot')
})
