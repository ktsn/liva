import { describe, expect, it } from 'vite-plus/test'
import type { LayerResolution } from '../composition/layers.ts'
import type { ResolvedTrack } from '../composition/resolve.ts'
import type { Definition } from '../model/definition.ts'
import {
  normalizePresenceLayers,
  planPresenceExclusions,
  presenceDeclarationNames,
  presencePropertyKey,
  resolvePresenceTrack,
} from './presence-calculation.ts'

function resolution(value: string): LayerResolution {
  return {
    composition: { layers: {}, states: {} },
    states: new Map(),
    transitions: new Map(),
    presentation: {
      name: 'ordinary',
      targets: [
        {
          name: 'box',
          properties: [
            { name: 'margin', value, owner: 'base' },
            { name: 'margin-left', value: '4px', owner: 'higher' },
          ],
        },
      ],
    },
  }
}

const track: ResolvedTrack = {
  target: 'box',
  property: 'opacity',
  timing: { kind: 'tween', durationMs: 100, easing: 'linear' },
  keyframes: [
    { offset: 0, value: '0.6' },
    { offset: 1, value: '1' },
  ],
  destinationValue: '1',
}
const definition: Definition = {
  name: 'presence',
  layers: [],
  enter: {
    timing: track.timing,
    targets: [
      {
        name: 'box',
        properties: [
          {
            name: 'opacity',
            keyframes: [
              {
                offset: 0,
                value: { kind: 'template', parts: [{ kind: 'reference', path: ['amount'] }] },
              },
            ],
          },
        ],
      },
    ],
  },
}

describe('presence ownership calculation', () => {
  it.each(['playing enter', 'pending enter', 'leave'] as const)(
    'uses canonical winners and retained exclusions for %s',
    (mode) => {
      const previous = resolution('1px')
      const next = resolution('2px')
      const retained = presencePropertyKey(8, 'box', 'external')
      const addresses = [
        { name: 'margin', addresses: ['top', 'right', 'bottom', 'left'] },
        { name: 'margin-left', addresses: ['left'] },
      ]
      const planned = planPresenceExclusions(previous, next, [
        {
          id: 5,
          phase: mode === 'leave' ? 'leave' : 'enter',
          playing: mode !== 'pending enter',
          interrupted: new Set([retained]),
          receivers: [
            { id: 8, target: 'box', addresses },
            { id: 8, target: 'box', addresses },
          ],
        },
      ])

      expect(presenceDeclarationNames(previous, next, 'box')).toEqual(['margin', 'margin-left'])
      expect([...planned.get(5)!]).toEqual(
        mode === 'playing enter'
          ? [
              retained,
              ...['top', 'right', 'bottom'].map((property) =>
                presencePropertyKey(8, 'box', property),
              ),
            ]
          : [retained],
      )
    },
  )
})

describe('presence expression calculation', () => {
  it.each([false, true])(
    'evaluates accepted inputs while preserving interrupted starts=%s',
    (rebased) => {
      const ordinary = {
        ...resolution('1px'),
        presentation: {
          name: 'ordinary',
          targets: [{ name: 'box', properties: [{ name: 'opacity', value: '1', owner: 'base' }] }],
        },
      }
      const resolved = resolvePresenceTrack({
        receiver: 8,
        phase: 'enter',
        track,
        rebased,
        definition,
        values: { amount: 0.2 },
        presentation: ordinary.presentation,
        addresses: ['opacity'],
        excluded: new Set(),
      })

      expect(resolved?.keyframes[0].value).toBe(rebased ? '0.6' : '0.2')
      expect(resolved?.destinationValue).toBe('1')
    },
  )

  it('does not evaluate a declaration whose supplied addresses have all been excluded', () => {
    const input = {
      receiver: 8,
      phase: 'enter' as const,
      track,
      rebased: false,
      definition,
      values: {},
      presentation: resolution('1px').presentation,
      addresses: ['opacity'],
    }

    expect(
      resolvePresenceTrack({
        ...input,
        excluded: new Set([presencePropertyKey(8, 'box', 'opacity')]),
      }),
    ).toBeUndefined()
    expect(() => resolvePresenceTrack({ ...input, excluded: new Set() })).toThrow(
      'Unknown variable',
    )
  })
})

describe('presence normalization', () => {
  it.each([false, true])(
    'retains authored ownership while filtering canonical components and implicit starts=%s',
    (implicitStart) => {
      const source = { ...track, property: 'inset', destinationValue: '10px 20px' }
      const top = { ...track, property: 'top', destinationValue: '10px', implicitStart }
      const left = { ...track, property: 'left', destinationValue: '20px' }
      const layers = normalizePresenceLayers({
        operation: 5,
        index: 3,
        receiver: 8,
        source,
        components: [
          { track: top, addresses: ['top'] },
          { track: left, addresses: ['left'] },
        ],
        excluded: new Set([presencePropertyKey(8, 'box', 'left')]),
      })

      expect(layers).toHaveLength(1)
      expect(layers[0].scope).toEqual([8])
      expect(layers[0].targets[0].properties).toEqual([
        {
          name: 'top',
          owner: layers[0].id,
          sourceProperty: 'inset',
          sourceDestination: '10px 20px',
          value: '10px',
          timing: track.timing,
          keyframes: implicitStart ? top.keyframes.slice(1) : top.keyframes,
        },
      ])
    },
  )
})
