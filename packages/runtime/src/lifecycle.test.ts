import { expect, it } from 'vite-plus/test'
import type { State, Transition } from './definition.ts'
import { resolveLifecycleTracks } from './lifecycle.ts'

const state: State = {
  name: 'idle',
  targets: [{ name: 'body', properties: [{ name: 'opacity', value: '1' }] }],
}
it('resolves disconnected enter endpoints from the active state without style sampling', () => {
  const transition: Transition = {
    timing: { kind: 'tween', durationMs: 200, easing: 'ease-out' },
    targets: [
      { name: 'body', properties: [{ name: 'opacity', keyframes: [{ offset: 0, value: '0' }] }] },
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
            keyframes: [{ offset: 1, value: '0' }],
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
                { offset: 0, value: '0.2', easing: 'ease-in' },
                { offset: 1, value: '0.8' },
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
      { name: 'body', properties: [{ name: 'opacity', keyframes: [{ offset: 1, value: '0' }] }] },
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
