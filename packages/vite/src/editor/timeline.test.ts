import { resolveComposition, type Definition } from '@liva/runtime'
import { renderTransition } from '../../../runtime/src/expression.ts'
import { describe, expect, it } from 'vite-plus/test'
import { compile } from '../compiler.ts'
import { readFileSync } from 'node:fs'
import {
  compositionTimelineTracks,
  compositionLifecycleTracks,
  timingText,
  editableDefinition,
} from './timeline.ts'

const definition = compile(
  readFileSync(new URL('../../../../fixtures/toggle.liv', import.meta.url), 'utf8'),
  true,
).definitions[0]

function fixtureTracks(source = definition, reverse = false) {
  const from = { layers: {}, states: { toggle: reverse ? 'on' : 'off' } }
  const to = { layers: {}, states: { toggle: reverse ? 'off' : 'on' } }

  return compositionTimelineTracks(
    resolveComposition(source, {}, from),
    resolveComposition(source, {}, to, from, [{ layer: 'toggle', index: reverse ? 1 : 0 }]),
  )
}

describe('timeline coordinates and inheritance', () => {
  it('keeps real-time coordinates distinct from per-property percentages', () => {
    const tracks = fixtureTracks()
    const scale = tracks.find((track) => track.property === 'scale')
    const color = tracks.find((track) => track.property === 'background-color')

    expect(scale?.duration).toBe(350)
    expect(color?.duration).toBe(200)
    expect(scale?.frames.map((frame) => frame.offset)).toEqual([0, 0.4, 0.7, 1])
  })

  it('uses the timing of the explicitly selected return transition', () => {
    const forward = fixtureTracks().find((track) => track.property === 'translate')
    const reverse = fixtureTracks(definition, true).find((track) => track.property === 'translate')

    expect(forward?.timing?.kind).toBe('spring-physics')
    expect(reverse?.timing?.kind).toBe('spring-duration')
    expect(reverse?.duration).toBe(350)
  })
})

it('contains spring solver failures within the affected track', () => {
  const source = readFileSync(
    new URL('../../../../fixtures/toggle.liv', import.meta.url),
    'utf8',
  ).replace('damping: 20', 'damping: 0.000001')
  const compiled = compile(source, true)
  const tracks = fixtureTracks(compiled.definitions[0])

  expect(compiled.diagnostics.filter((item) => item.severity === 'error')).toEqual([])
  expect(tracks.find((track) => track.property === 'translate')?.diagnostic).toBeTruthy()
  expect(tracks.find((track) => track.property === 'scale')?.duration).toBe(350)
})

it('formats evaluated timing variants as display labels', () => {
  expect(timingText({ kind: 'tween', durationMs: 100, easing: 'linear' })).toBe(
    'Tween: 100 ms, linear',
  )
  expect(timingText({ kind: 'spring-duration', durationMs: 200, bounce: 0.3 })).toBe(
    'Spring: 200 ms, bounce 0.3',
  )
  expect(timingText({ kind: 'spring-physics', stiffness: 100, damping: 10, mass: 1 })).toBe(
    'Spring: stiffness 100, damping 10, mass 1',
  )
})

describe('composition lifecycle timeline', () => {
  const source = compile(
    `motion panel {
    layer base { body { opacity: 1 } extra { opacity: 1 } }
    @tween(duration: 200) enter { body { opacity: 0 } }
    @tween(duration: 300) leave { body { translate: 10px 0 } extra { opacity: 0 } }
  }`,
    true,
  ).definitions[0]

  it('resolves lifecycle endpoints from the selected composition', () => {
    const model = editableDefinition(source)
    const baseline = resolveComposition(
      model,
      {},
      { layers: { base: true }, states: {} },
    ).presentation
    const enter = compositionLifecycleTracks(
      model.name,
      'enter',
      baseline,
      renderTransition(model.enter!, {}),
    )[0]
    const leave = compositionLifecycleTracks(
      model.name,
      'leave',
      baseline,
      renderTransition(model.leave!, {}),
    ).find((track) => track.property === 'translate')

    expect(model).not.toBe(source)
    expect(enter.frames.map((frame) => frame.value)).toEqual(['0', '1'])
    expect(enter.duration).toBe(200)
    expect(leave?.frames.map((frame) => frame.value)).toEqual(['', '10px 0'])
    expect(leave?.duration).toBe(300)
  })

  it.each([
    { stiffness: 300, damping: 20, mass: 1, fails: false },
    { stiffness: 0.001, damping: 0.001, mass: 100, fails: true },
  ])(
    'exposes lifecycle spring duration or solver failure: $fails',
    ({ stiffness, damping, mass, fails }) => {
      const baseline = resolveComposition(
        source,
        {},
        { layers: { base: true }, states: {} },
      ).presentation
      const [row] = compositionLifecycleTracks(source.name, 'enter', baseline, {
        timing: { kind: 'spring-physics', stiffness, damping, mass },
        targets: [
          {
            name: 'body',
            properties: [
              {
                name: 'opacity',
                keyframes: [
                  {
                    offset: 0,
                    value: {
                      kind: 'literal',
                      value: '0',
                    },
                  },
                ],
              },
            ],
          },
        ],
      })

      expect(Boolean(row.diagnostic)).toBe(fails)
      expect(row.duration > 0).toBe(!fails)
      expect(row.frames.map((frame) => frame.value)).toEqual(['0', '1'])
    },
  )

  it('displays lifecycle-only targets without inventing a composition endpoint', () => {
    const baseline = resolveComposition(
      source,
      {},
      { layers: { base: false }, states: {} },
    ).presentation
    const tracks = compositionLifecycleTracks(
      source.name,
      'leave',
      baseline,
      renderTransition(source.leave!, {}),
    )
    const extra = tracks.find((track) => track.target === 'extra')

    expect(extra?.frames.map((frame) => frame.value)).toEqual(['', '0'])
  })
})

describe('composition timeline rows', () => {
  it('includes unchanged and untimed properties and resolves owning transition frames', () => {
    const source: Definition = {
      name: 'layers',
      layers: [
        {
          name: 'base',
          targets: [
            {
              name: 'body',
              properties: [
                {
                  name: 'scale',
                  value: {
                    kind: 'literal',
                    value: '1',
                  },
                  timing: { kind: 'tween', durationMs: 100, easing: 'linear' },
                },
                {
                  name: 'opacity',
                  value: {
                    kind: 'literal',
                    value: '1',
                  },
                },
              ],
            },
          ],
        },
        {
          name: 'machine',
          targets: [],
          initialState: 'idle',
          states: [
            {
              name: 'idle',
              targets: [
                {
                  name: 'body',
                  properties: [
                    {
                      name: 'scale',
                      value: {
                        kind: 'literal',
                        value: '1',
                      },
                    },
                  ],
                },
              ],
            },
          ],
          transitions: [
            {
              from: 'idle',
              to: 'idle',
              when: { kind: 'boolean', value: false },
              transition: {
                targets: [
                  {
                    name: 'body',
                    properties: [
                      {
                        name: 'scale',
                        keyframes: [
                          {
                            offset: 0.5,
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
              },
            },
          ],
        },
      ],
    }
    const selection = { layers: { base: true }, states: { machine: 'idle' } }
    const from = resolveComposition(source, {}, selection)
    const to = resolveComposition(source, {}, selection, selection, [
      { layer: 'machine', index: 0 },
    ])

    const rows = compositionTimelineTracks(from, to)

    expect(rows.map((row) => row.property)).toEqual(['scale', 'opacity'])
    expect(rows[0].frames.map((frame) => frame.value)).toEqual(['1', '2', '1'])
    expect(rows[0].explicit).toEqual([{ offset: 0.5, value: '2' }])
    expect(rows[1].duration).toBe(0)
    expect(rows[1].fromValue).toBe('1')
    expect(rows[1].toValue).toBe('1')
  })

  it.each([
    { timing: { kind: 'spring-duration' as const, durationMs: 300, bounce: 0.2 }, expected: 300 },
    {
      timing: { kind: 'spring-physics' as const, stiffness: 0.001, damping: 0.001, mass: 100 },
      expected: 0,
    },
  ])('represents spring durations and diagnostics: $timing.kind', ({ timing, expected }) => {
    const source: Definition = {
      name: 'layers',
      layers: [
        {
          name: 'base',
          targets: [
            {
              name: 'body',
              properties: [
                {
                  name: 'scale',
                  value: {
                    kind: 'literal',
                    value: '1',
                  },
                  timing,
                },
              ],
            },
          ],
        },
      ],
    }
    const from = resolveComposition(source, {}, { layers: { base: false }, states: {} })
    const to = resolveComposition(source, {}, { layers: { base: true }, states: {} })

    const [row] = compositionTimelineTracks(from, to)

    expect(row.duration).toBe(expected)
    expect(Boolean(row.diagnostic)).toBe(expected === 0)
    expect(row.fromValue).toBe('')
  })

  it('keeps the resolved TO value separate from a disagreeing explicit endpoint', () => {
    const source = compile(
      `motion sample { layer base {
    state idle initial { body { opacity: 1 @tween(duration: 100) } }
    transition idle -> idle when false { body { opacity ~> { 100%: 0 } } }
  } }`,
      true,
    ).definitions[0]
    const composition = { layers: {}, states: { base: 'idle' } }
    const from = resolveComposition(source, {}, composition)
    const to = resolveComposition(source, {}, composition, composition, [
      { layer: 'base', index: 0 },
    ])

    const [row] = compositionTimelineTracks(from, to)

    expect(row.toValue).toBe('1')
    expect(row.frames.at(-1)?.value).toBe('0')
  })
})

describe('composition lifecycle resolved endpoints', () => {
  it.each(['enter', 'leave'] as const)(
    'distinguishes explicit %s endpoints from the completion baseline',
    (phase) => {
      const presentation: import('@liva/runtime').RenderedState = {
        name: 'baseline',
        targets: [{ name: 'body', properties: [{ name: 'opacity', value: '1' }] }],
      }
      const transition: import('@liva/runtime').Transition = {
        timing: { kind: 'tween' as const, durationMs: 200, easing: 'linear' },
        targets: [
          {
            name: 'body',
            properties: [
              {
                name: 'opacity',
                keyframes: [
                  {
                    offset: 0,
                    value: {
                      kind: 'literal',
                      value: '0.2',
                    },
                  },
                  {
                    offset: 1,
                    value: {
                      kind: 'literal',
                      value: '0.6',
                    },
                  },
                ],
              },
            ],
          },
        ],
      }

      const [track] = compositionLifecycleTracks('panel', phase, presentation, transition)

      expect(track.fromValue).toBe('0.2')
      expect(track.toValue).toBe(phase === 'enter' ? '1' : '0.6')
      expect(track.frames.at(-1)?.value).toBe('0.6')
    },
  )

  it.each(['enter', 'leave'] as const)('uses implicit baseline endpoints for %s', (phase) => {
    const presentation: import('@liva/runtime').RenderedState = {
      name: 'baseline',
      targets: [{ name: 'body', properties: [{ name: 'opacity', value: '0.8' }] }],
    }

    const [track] = compositionLifecycleTracks('panel', phase, presentation, undefined)

    expect(track.fromValue).toBe('0.8')
    expect(track.toValue).toBe('0.8')
  })
})

it('labels immediate timing without exposing meaningless easing', () => {
  expect(timingText({ kind: 'tween', durationMs: 0, easing: 'ease' })).toBe('Instant')
})
