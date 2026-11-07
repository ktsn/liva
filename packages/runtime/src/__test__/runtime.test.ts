import { describe, expect, it } from 'vite-plus/test'
import fixture from '../../../../fixtures/toggle.json'
import { decodeBundle, type Definition, type Timing, type Transition } from '../definition.ts'
import { normalizeFrames } from '../resolve.ts'
import { resolveComposition, resolveLayerTracks } from '../layers.ts'
import { sampleSpring, springResponse, SPRING_ERROR } from '../spring.ts'
import { waapiProperty } from '../instance.ts'

const definition = decodeBundle(JSON.stringify(fixture)).definitions[0]
const tween = (durationMs: number): Timing => ({ kind: 'tween', durationMs, easing: 'linear' })

function withReturnTransition(transition: Transition): Definition {
  const layer = definition.layers[0]

  // The toggle fixture declares both outgoing and returning transitions.
  const transitions = layer.transitions!

  return {
    ...definition,
    layers: [{ ...layer, transitions: [transitions[0], { ...transitions[1], transition }] }],
  }
}

function returnTracks(source: Definition) {
  const from = { layers: {}, states: { toggle: 'on' } }
  const to = { layers: {}, states: { toggle: 'off' } }
  const previous = resolveComposition(source, {}, from)
  const next = resolveComposition(source, {}, to, from, [{ layer: 'toggle', index: 1 }])

  // Every animated property in this fixture has a declared value in both compositions.
  return resolveLayerTracks(
    previous,
    next,
    {},
    (target, property) =>
      previous.presentation.targets
        .find((item) => item.name === target)!
        .properties.find((item) => item.name === property)!.value,
    () => {},
  )
}

describe('transition resolution', () => {
  it('uses transition-wide timing ahead of layer timing and preserves property overrides', () => {
    const def = withReturnTransition({
      timing: tween(500),
      targets: [
        {
          name: 'thumb',
          properties: [
            {
              name: 'translate',
              timing: { kind: 'spring-duration', durationMs: 350, bounce: 0.25 },
            },
          ],
        },
      ],
    })
    const tracks = returnTracks(def)

    expect(tracks.find((track) => track.property === 'background-color')?.timing).toEqual(
      tween(500),
    )
    expect(tracks.find((track) => track.property === 'translate')?.timing).toEqual({
      kind: 'spring-duration',
      durationMs: 350,
      bounce: 0.25,
    })
  })

  it('schedules equal-value pulses from the explicitly selected transition', () => {
    const def = withReturnTransition({
      targets: [
        {
          name: 'thumb',
          properties: [{ name: 'scale', keyframes: [{ offset: 0.6, value: '2' }] }],
        },
      ],
    })
    const scale = returnTracks(def).find((track) => track.property === 'scale')

    expect(scale?.keyframes.map((frame) => frame.offset)).toEqual([0, 0.6, 1])
    expect(scale?.keyframes.map((frame) => frame.value)).toEqual(['1', '2', '1'])
  })

  it('preserves explicit endpoints separately from the settled destination', () => {
    const def = withReturnTransition({
      targets: [
        {
          name: 'thumb',
          properties: [
            {
              name: 'scale',
              keyframes: [
                { offset: 0, value: '2', easing: 'steps(2)' },
                { offset: 1, value: '3' },
              ],
            },
          ],
        },
      ],
    })
    const scale = returnTracks(def).find((track) => track.property === 'scale')

    expect(scale?.destinationValue).toBe('1')
    expect(scale?.keyframes[0]).toEqual({ offset: 0, value: '2', easing: 'steps(2)' })
  })

  it.each([[-0.1], [1.1], [NaN], [0.5, 0.5]])('rejects invalid frame offsets %j', (...offsets) => {
    expect(() =>
      normalizeFrames(
        '0',
        '1',
        offsets.map((offset) => ({ offset, value: '2' })),
        tween(100),
      ),
    ).toThrow('Invalid or duplicate')
  })

  it('supports intermediate frames and easing with evaluated spring timing', () => {
    const frames = normalizeFrames('0', '1', [{ offset: 0.5, value: '2', easing: 'ease-in' }], {
      kind: 'spring-duration',
      durationMs: 350,
      bounce: 0.2,
    })

    expect(frames).toEqual([
      { offset: 0, value: '0', easing: 'linear' },
      { offset: 0.5, value: '2', easing: 'ease-in' },
      { offset: 1, value: '1', easing: 'linear' },
    ])
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
