import { describe, expect, it } from 'vite-plus/test'
import fixture from '../../../../fixtures/toggle.json'
import { decodeBundle, type Definition, type Timing, type Transition } from '../model/definition.ts'
import { normalizeFrames } from '../composition/resolve.ts'
import { resolveComposition, resolveLayerTracks } from '../composition/layers.ts'
import { sampleSpring, springResponse, springState, SPRING_ERROR } from '../motion/spring.ts'
import { waapiProperty } from '../execution/instance.ts'

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

function integrateSpring(
  parameters: { stiffness: number; damping: number; mass: number },
  start: number,
  end: number,
  initialVelocity: number,
  seconds: number,
) {
  let value = start
  let velocity = initialVelocity
  const step = 1 / 8192
  const acceleration = (position: number, speed: number) =>
    -(parameters.damping * speed + parameters.stiffness * (position - end)) / parameters.mass

  // RK4 integrates the equation of motion independently of the analytic damping
  // branches. Test times are exact multiples of this fixed step.
  for (let time = 0; time < seconds; time += step) {
    const x1 = velocity
    const v1 = acceleration(value, velocity)
    const x2 = velocity + (step * v1) / 2
    const v2 = acceleration(value + (step * x1) / 2, x2)
    const x3 = velocity + (step * v2) / 2
    const v3 = acceleration(value + (step * x2) / 2, x3)
    const x4 = velocity + step * v3
    const v4 = acceleration(value + step * x3, x4)

    value += (step * (x1 + 2 * x2 + 2 * x3 + x4)) / 6
    velocity += (step * (v1 + 2 * v2 + 2 * v3 + v4)) / 6
  }

  return { value, velocity }
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
          properties: [
            {
              name: 'scale',
              keyframes: [
                {
                  offset: 0.6,
                  value: {
                    kind: 'literal',
                    value: '2',
                  },
                },
              ],
            },
          ],
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
                {
                  offset: 0,
                  value: {
                    kind: 'literal',
                    value: '2',
                  },
                  easing: 'steps(2)',
                },
                {
                  offset: 1,
                  value: {
                    kind: 'literal',
                    value: '3',
                  },
                },
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
  const springs = [
    { name: 'underdamped', stiffness: 100, damping: 8, mass: 1 },
    { name: 'critical', stiffness: 100, damping: 20, mass: 1 },
    { name: 'overdamped', stiffness: 100, damping: 40, mass: 1 },
    { name: 'near critical from below', stiffness: 100, damping: 20 * (1 - 1e-10), mass: 1 },
    { name: 'near critical from above', stiffness: 100, damping: 20 * (1 + 1e-10), mass: 1 },
    { name: 'non-unit mass', stiffness: 300, damping: 25, mass: 2 },
  ]
  const initialStates = [
    { name: 'toward the target', start: 10, end: 100, velocity: 500 },
    { name: 'away from the target', start: 10, end: 100, velocity: -500 },
    { name: 'equal endpoints', start: 100, end: 100, velocity: 500 },
    { name: 'reversed destination', start: 100, end: -20, velocity: 200 },
  ]

  it.each(springs)('retains the rest unit-step response for $name', (parameters) => {
    for (const seconds of [0, 0.125, 0.5]) {
      const expected = integrateSpring(parameters, 0, 1, 0, seconds)
      const actual = springResponse(
        parameters.stiffness,
        parameters.damping,
        parameters.mass,
        seconds,
      )

      // Six decimal places allow integration error and the existing near-critical
      // approximation while remaining well below displayed-value tolerances.
      expect(actual.value).toBeCloseTo(expected.value, 6)
      expect(actual.velocity).toBeCloseTo(expected.velocity, 6)
    }
  })

  it.each(
    springs.flatMap((parameters) =>
      initialStates.map((initial) => ({
        ...parameters,
        ...initial,
        name: `${parameters.name}, ${initial.name}`,
      })),
    ),
  )('follows the equation of motion for $name', (parameters) => {
    for (const seconds of [0, 0.125, 0.5]) {
      const expected = integrateSpring(
        parameters,
        parameters.start,
        parameters.end,
        parameters.velocity,
        seconds,
      )
      const actual = springState(
        parameters.start,
        parameters.end,
        parameters.velocity,
        parameters.stiffness,
        parameters.damping,
        parameters.mass,
        seconds,
      )

      expect(actual.value).toBeCloseTo(expected.value, 6)
      expect(actual.velocity).toBeCloseTo(expected.velocity, 6)
    }
  })

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
