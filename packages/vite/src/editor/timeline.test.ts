import { resolveComposition, type Definition } from '@liva/runtime'
import { describe, expect, it } from 'vite-plus/test'
import { compile } from '../compiler.ts'
import { readFileSync } from 'node:fs'
import {
  normalizedOffset,
  snapTime,
  timelineTracks,
  compositionTimelineTracks,
  compositionLifecycleTracks,
} from './timeline.ts'

const definition = compile(
  readFileSync(new URL('../../../../fixtures/toggle.liv', import.meta.url), 'utf8'),
  true,
).definitions[0]

const reverseTranslation = (general: boolean) =>
  timelineTracks(definition, 'on', 'off', general).find((track) => track.property === 'translate')!

describe('timeline coordinates and inheritance', () => {
  it('keeps real-time coordinates distinct from per-property percentages', () => {
    const tracks = timelineTracks(definition, 'off', 'on', false)
    const scale = tracks.find((track) => track.property === 'scale')!
    const color = tracks.find((track) => track.property === 'background-color')!

    expect(scale.duration).toBe(350)
    expect(color.duration).toBe(200)
    expect(scale.frames.map((frame) => frame.offset)).toEqual([0, 0.4, 0.7, 1])
    expect(scale.inheritedFrames).toBe(true)
    expect(normalizedOffset(140, scale.duration)).toBe(0.4)
    expect(normalizedOffset(140, color.duration)).toBe(0.7)
  })

  it('shows common settings independently of directional timing', () => {
    expect(reverseTranslation(false).timing?.kind).toBe('spring-duration')
    expect(reverseTranslation(true).timing?.kind).toBe('spring-physics')
    expect(reverseTranslation(false).duration).toBe(350)
  })

  it('snaps to real-time markers and bypasses snapping with the modifier', () => {
    expect(snapTime(143, 1000, [140], 1000, false)).toBe(140)
    expect(snapTime(143, 1000, [140], 1000, true)).toBe(143)
    expect(snapTime(151, 1000, [140], 1000, false)).toBe(151)
    expect(normalizedOffset(1, 3)).toBe(0.333333)
  })
})

it('contains spring solver failures within the affected track', () => {
  const source = readFileSync(
    new URL('../../../../fixtures/toggle.liv', import.meta.url),
    'utf8',
  ).replace('@spring: 300 20', '@spring: 300 0.000001')
  const compiled = compile(source, true)
  expect(compiled.diagnostics.filter((item) => item.severity === 'error')).toEqual([])

  const tracks = timelineTracks(compiled.definitions[0], 'off', 'on', false)
  expect(tracks.find((track) => track.property === 'translate')?.diagnostic).toBeTruthy()
  expect(tracks.find((track) => track.property === 'scale')?.duration).toBe(350)
})

it('formats all timing variants and handles missing states and timing', async () => {
  const { timingText } = await import('./timeline.ts')

  expect(timingText({ kind: 'tween', durationMs: 100, easing: 'linear' })).toBe(
    '@tween: 100ms linear',
  )
  expect(timingText({ kind: 'spring-duration', durationMs: 200, bounce: 0.3 })).toBe(
    '@spring: 200ms 0.3',
  )
  expect(timingText({ kind: 'spring-physics', stiffness: 100, damping: 10, mass: 1 })).toBe(
    '@spring: 100 10 1',
  )
  expect(timelineTracks(definition, 'off', 'missing', false)).toEqual([])
  expect(normalizedOffset(100, 0)).toBe(0)
  expect(normalizedOffset(-100, 10)).toBe(0)
  expect(normalizedOffset(100, 10)).toBe(1)

  const bare = { ...definition, generalTransition: undefined, directionalTransitions: [] }
  const tracks = timelineTracks(bare, 'missing', 'off', true)

  expect(tracks.every((track) => track.duration === 0)).toBe(true)
  expect(tracks[0].frames[0].value).toBe(tracks[0].frames[1].value)
})

it('previews motion-level lifecycle endpoints in the selected legacy state', async () => {
  const { editableDefinition, transitionAt, transitionPath } = await import('./timeline.ts')
  const compiled = compile(
    `motion panel {
    state idle { body { opacity: 1 } extra { opacity: 1 } }
    enter { @tween: 200ms; body { opacity: 0 } }
    leave { @tween: 300ms; body { translate: 10px 0 } extra { opacity: 0 } }
  }`,
    true,
  )
  const model = editableDefinition(compiled.definitions[0])

  expect(model).not.toBe(compiled.definitions[0])
  expect(transitionAt(model, 'idle', 'idle', false, 'enter')).toBe(model.enter)
  expect(transitionPath(model, 'idle', 'idle', false, 'enter')).toBe('panel/enter')

  const enter = timelineTracks(model, 'idle', 'idle', true, 'enter')[0]

  expect(enter.frames.map((frame) => frame.value)).toEqual(['0', '1'])
  expect(enter.duration).toBe(200)

  const leave = timelineTracks(model, 'idle', 'idle', true, 'leave').find(
    (track) => track.property === 'translate',
  )!

  expect(leave.frames.map((frame) => frame.value)).toEqual(['', '10px 0'])
  expect(leave.duration).toBe(300)
})

it('displays lifecycle-only targets without inventing an endpoint state', () => {
  const compiled = compile(
    'motion panel { state idle { extra { opacity: 1 } } leave { @tween: 200ms; extra { opacity: 0 } } }',
    false,
  ).definitions[0]
  const tracks = timelineTracks(compiled, 'missing', 'missing', false, 'leave')

  expect(tracks[0].target).toBe('extra')
  expect(tracks[0].frames.map((frame) => frame.value)).toEqual(['', '0'])
})

describe('composition timeline rows', () => {
  it('includes unchanged and untimed properties and resolves owning transition frames', () => {
    const source: Definition = {
      name: 'layers',
      states: [],
      directionalTransitions: [],
      layers: [
        {
          name: 'base',
          targets: [
            {
              name: 'body',
              properties: [
                {
                  name: 'scale',
                  value: '1',
                  timing: { kind: 'tween', durationMs: 100, easing: 'linear' },
                },
                { name: 'opacity', value: '1' },
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
              targets: [{ name: 'body', properties: [{ name: 'scale', value: '1' }] }],
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
                    properties: [{ name: 'scale', keyframes: [{ offset: 0.5, value: '2' }] }],
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
      states: [],
      directionalTransitions: [],
      layers: [
        {
          name: 'base',
          targets: [{ name: 'body', properties: [{ name: 'scale', value: '1', timing }] }],
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
    transition idle -> idle when false { body { opacity { 100%: 0 } } }
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
      const presentation = {
        name: 'baseline',
        targets: [{ name: 'body', properties: [{ name: 'opacity', value: '1' }] }],
      }
      const transition = {
        targets: [
          {
            name: 'body',
            properties: [
              {
                name: 'opacity',
                keyframes: [
                  { offset: 0, value: '0.2' },
                  { offset: 1, value: '0.6' },
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
    const presentation = {
      name: 'baseline',
      targets: [{ name: 'body', properties: [{ name: 'opacity', value: '0.8' }] }],
    }

    const [track] = compositionLifecycleTracks('panel', phase, presentation, undefined)

    expect(track.fromValue).toBe('0.8')
    expect(track.toValue).toBe('0.8')
  })
})
