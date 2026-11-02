import { describe, expect, it } from 'vite-plus/test'
import { compile } from '../compiler.ts'
import { readFileSync } from 'node:fs'
import { normalizedOffset, snapTime, timelineTracks } from './timeline.ts'

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
