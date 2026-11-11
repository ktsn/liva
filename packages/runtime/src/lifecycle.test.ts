import { expect, it } from 'vite-plus/test'
import type { Transition } from './definition.ts'
import fixture from '../../../fixtures/lifecycle.json'
import { resolveLayers } from './layers.ts'
import { decodeBundle } from './definition.ts'
import { captureLifecycleDefinition, hasLifecycle, resolveLifecycleTracks } from './lifecycle.ts'

const state: import('./presentation.ts').RenderedState = {
  name: 'idle',
  targets: [{ name: 'body', properties: [{ name: 'opacity', value: '1' }] }],
}
it('resolves disconnected enter endpoints from the active state without style sampling', () => {
  const transition: Transition = {
    timing: { kind: 'tween', durationMs: 200, easing: 'ease-out' },
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
  }

  const work = resolveLifecycleTracks('enter', transition, state, () => '')

  expect(work[0].keyframes).toEqual([
    { offset: 0, value: '0', easing: 'ease-out' },
    { offset: 1, value: '1', easing: 'ease-out' },
  ])
  expect(transition.targets[0].properties[0].keyframes).toHaveLength(1)
})

it('samples the leave presentation and resolves per-property overrides', () => {
  const transition: Transition = {
    timing: { kind: 'tween', durationMs: 200, easing: 'linear' },
    targets: [
      {
        name: 'body',
        properties: [
          {
            name: 'opacity',
            timing: { kind: 'spring-physics', stiffness: 300, damping: 20, mass: 1 },
            keyframes: [
              {
                offset: 1,
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
  }

  const work = resolveLifecycleTracks('leave', transition, state, () => '0.42')

  expect(work[0].keyframes[0].value).toBe('0.42')
  expect(work[0].destinationValue).toBe('0')
  expect(work[0].timing.kind).toBe('spring-physics')
  expect(resolveLifecycleTracks('leave', transition, state, () => undefined)).toEqual([])
})

it.each(['enter', 'leave'] as const)(
  'preserves authored endpoints and easing during %s',
  (phase) => {
    const transition: Transition = {
      timing: { kind: 'tween', durationMs: 200, easing: 'ease-out' },
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
                  easing: 'ease-in',
                },
                {
                  offset: 1,
                  value: {
                    kind: 'literal',
                    value: '0.8',
                  },
                },
              ],
            },
          ],
        },
      ],
    }

    const tracks = resolveLifecycleTracks(phase, transition, state, () => '0.42')

    expect(tracks[0].keyframes).toEqual([
      { offset: 0, value: '0.2', easing: 'ease-in' },
      { offset: 1, value: '0.8', easing: 'ease-out' },
    ])
    expect(tracks[0].destinationValue).toBe(phase === 'enter' ? '1' : '0.8')
  },
)

it.each(['enter', 'leave'] as const)('uses captured CSS when %s has no state value', (phase) => {
  const transition: Transition = {
    timing: { kind: 'tween', durationMs: 200, easing: 'linear' },
    targets: [{ name: 'body', properties: [{ name: 'color' }] }],
  }

  const tracks = resolveLifecycleTracks(phase, transition, state, () => 'rgb(12, 34, 56)')

  expect(tracks[0].keyframes.map((frame) => frame.value)).toEqual([
    'rgb(12, 34, 56)',
    'rgb(12, 34, 56)',
  ])
  expect(tracks[0].destinationValue).toBe('rgb(12, 34, 56)')
})

it('resolves only registered targets and keeps their independent property timing', () => {
  const transition: Transition = {
    timing: { kind: 'tween', durationMs: 200, easing: 'linear' },
    targets: [
      {
        name: 'body',
        properties: [
          {
            name: 'opacity',
            keyframes: [
              {
                offset: 1,
                value: {
                  kind: 'literal',
                  value: '0',
                },
              },
            ],
          },
        ],
      },
      {
        name: 'badge',
        properties: [
          { name: 'opacity', timing: { kind: 'tween', durationMs: 500, easing: 'ease-out' } },
        ],
      },
      { name: 'absent', properties: [{ name: 'opacity' }] },
    ],
  }

  const tracks = resolveLifecycleTracks('leave', transition, state, (target) =>
    target === 'absent' ? undefined : '0.42',
  )

  expect(tracks.map((track) => track.target)).toEqual(['body', 'badge'])
  expect(tracks.map((track) => track.timing)).toEqual([
    { kind: 'tween', durationMs: 200, easing: 'linear' },
    { kind: 'tween', durationMs: 500, easing: 'ease-out' },
  ])
})

const definition = decodeBundle(JSON.stringify(fixture)).definitions[0]

it.each(['enter', 'leave'] as const)('captures %s expression values once', (phase) => {
  const values = { open: true, distance: 40 }
  const captured = captureLifecycleDefinition(definition, phase, values)

  expect(captured).toBeDefined()

  if (!captured) throw new Error('Expected lifecycle definition')

  values.open = false
  values.distance = 90

  const capturedProperty = (name: string) =>
    captured.targets
      .find((target) => target.name === 'content')!
      .properties.find((property) => property.name === name)!

  expect(capturedProperty('translate').keyframes?.[0].value).toEqual({
    kind: 'literal',
    value: '40px 0',
  })
  expect(capturedProperty('scale').keyframes).toHaveLength(1)
  expect(capturedProperty('scale').keyframes?.[0].value).toEqual({
    kind: 'literal',
    value: phase === 'enter' ? '0.8' : '1.2',
  })
  expect(capturedProperty('opacity').keyframes?.[0].value).toEqual({ kind: 'literal', value: '0' })
  expect(captured.targets.some((target) => target.name === 'badge')).toBe(true)

  const selected = resolveLayers(definition, { open: true, distance: 40 }).presentation
  const tracks = resolveLifecycleTracks(phase, captured, selected, () => '0.42')
  const opacity = tracks.find(
    (track) => track.target === 'content' && track.property === 'opacity',
  )!

  expect(opacity.keyframes.map((frame) => frame.value)).toEqual(
    phase === 'enter' ? ['0', '1'] : ['0.42', '0'],
  )
  expect(captureLifecycleDefinition(definition, phase, values)?.targets).toHaveLength(2)
})

it('does not evaluate an inactive lifecycle expression', () => {
  const enterOnly = { ...definition, leave: undefined }
  const withoutLifecycle = { ...enterOnly, enter: undefined }

  expect(hasLifecycle(enterOnly)).toBe(true)
  expect(hasLifecycle(withoutLifecycle)).toBe(false)
  expect(captureLifecycleDefinition(enterOnly, 'leave', {})).toBeUndefined()
  expect(() => captureLifecycleDefinition(enterOnly, 'enter', {})).toThrow('Unknown variable')
})

it('uses an empty presentation fallback and validates missing lifecycle timing', () => {
  const transition: Transition = { targets: [{ name: 'body', properties: [{ name: 'opacity' }] }] }

  expect(() => resolveLifecycleTracks('leave', transition, state, () => '')).toThrow(
    'Missing lifecycle timing',
  )

  const timed = {
    ...transition,
    timing: { kind: 'tween', durationMs: 10, easing: 'linear' } as const,
  }
  const resolved = resolveLifecycleTracks('leave', timed, state, () => '')

  expect(resolved[0].keyframes[0].value).toBe(state.targets[0].properties[0].value)
  expect(resolveLifecycleTracks('enter', undefined, state, () => '')).toEqual([])
})

const duration = (name: string): import('./definition.ts').Expression => ({
  kind: 'call',
  function: 'tween',
  arguments: [{ name: 'duration', value: { kind: 'reference', path: [name] } }],
})

it.each(['enter', 'leave'] as const)(
  'snapshots shared, target, and property timing for %s',
  (phase) => {
    const transition: Transition = {
      timingExpression: duration('shared'),
      targets: [
        { name: 'shared', properties: [{ name: 'opacity' }] },
        {
          name: 'local',
          timingExpression: duration('target'),
          properties: [
            { name: 'opacity' },
            { name: 'scale', timingExpression: duration('property') },
          ],
        },
      ],
    }
    const values = { shared: 100, target: 200, property: 300 }
    const source = { ...definition, [phase]: transition }
    const captured = captureLifecycleDefinition(source, phase, values)

    values.shared = 400
    values.target = 500
    values.property = 600
    const tracks = resolveLifecycleTracks(phase, captured, state, () => '1')

    expect(tracks.map((track) => track.timing)).toEqual([
      { kind: 'tween', durationMs: 100, easing: 'ease' },
      { kind: 'tween', durationMs: 200, easing: 'ease' },
      { kind: 'tween', durationMs: 300, easing: 'ease' },
    ])
  },
)
