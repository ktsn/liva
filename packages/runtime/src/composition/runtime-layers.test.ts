import { describe, expect, it } from 'vite-plus/test'
import { resolveLayers } from './layers.ts'
import { cascadeTargets } from './layer-cascade.ts'
import {
  composeRuntimeLayers,
  ordinaryLayer,
  trackLayer,
  normalizeLifecycleTracks,
} from './runtime-layers.ts'

const timing = { kind: 'tween', durationMs: 100, easing: 'linear' } as const

describe('evaluated runtime layer composition', () => {
  it('shares value and independent timing precedence while preserving last-source order', () => {
    const normal = resolveLayers(
      {
        name: 'motion',
        layers: [
          {
            name: 'base',
            timing,
            targets: [
              {
                name: 'box',
                properties: [
                  { name: 'margin', value: { kind: 'literal', value: '10px' } },
                  { name: 'margin-left', value: { kind: 'literal', value: '20px' } },
                ],
              },
            ],
          },
        ],
      },
      {},
    )
    const overlay = {
      id: 'overlay',
      scope: [7],
      targets: [{ name: 'box', properties: [{ name: 'margin', owner: 'overlay', value: '30px' }] }],
    }

    const composed = composeRuntimeLayers([ordinaryLayer(normal), overlay], 7)
    const excluded = composeRuntimeLayers([ordinaryLayer(normal), overlay], 8)

    expect(
      composed.targets[0].properties.map((property) => [
        property.name,
        property.value,
        property.timing,
      ]),
    ).toEqual([
      ['margin-left', '20px', timing],
      ['margin', '30px', timing],
    ])
    expect(excluded).toEqual(normal.presentation)
    expect(normal.composition).toEqual({ layers: { base: true }, states: {} })
  })

  it('keeps an animated endpoint distinct from the final reconciled style', () => {
    const track = {
      target: 'box',
      property: 'opacity',
      timing,
      destinationValue: '1',
      keyframes: [
        { offset: 0, value: '0' },
        { offset: 1, value: '0.7' },
      ],
    }

    const start = trackLayer('operation', 0, [track], true)
    const end = trackLayer('operation', 0, [track])

    expect(start.targets[0].properties[0]).toMatchObject({ value: '0', timing: { durationMs: 0 } })
    expect(end.targets[0].properties[0]).toMatchObject({
      value: '0.7',
      completionValue: '1',
      timing,
    })
  })

  it('retains explicitly mapped undefined timing rather than inheriting an earlier provider', () => {
    const result = cascadeTargets<number, string | undefined>(
      [
        { name: 'box', properties: [{ name: 'opacity', value: 1, timing: { value: 'first' } }] },
        { name: 'box', properties: [{ name: 'opacity', value: 2, timing: { value: undefined } }] },
      ],
      'first',
    )

    expect(result[0].properties[0]).toEqual({ name: 'opacity', value: 2, timing: undefined })
  })
})

describe('presence normalization from captured values', () => {
  it('skips absent receivers without calling observation providers', () => {
    const transition = { timing, targets: [{ name: 'box', properties: [{ name: 'opacity' }] }] }

    expect(
      normalizeLifecycleTracks('leave', transition, { name: 'state', targets: [] }, new Map()),
    ).toEqual([])
  })

  it('shares frame normalization and authored target timing precedence', () => {
    const transition = {
      timing,
      targets: [
        {
          name: 'box',
          timing: { ...timing, durationMs: 200 },
          properties: [
            {
              name: 'opacity',
              keyframes: [{ offset: 0.5, value: { kind: 'literal', value: '0.4' } as const }],
            },
          ],
        },
      ],
    }

    const tracks = normalizeLifecycleTracks(
      'leave',
      transition,
      { name: 'state', targets: [] },
      new Map([['box\0opacity', '1']]),
    )

    expect(tracks[0].timing).toMatchObject({ durationMs: 200 })
    expect(tracks[0].keyframes.map((frame) => [frame.offset, frame.value])).toEqual([
      [0, '1'],
      [0.5, '0.4'],
      [1, '1'],
    ])
  })
})

it('normalizes an absent phase to no work and fills omitted authored animation endpoints', () => {
  expect(
    normalizeLifecycleTracks('enter', undefined, { name: 'state', targets: [] }, new Map()),
  ).toEqual([])
  const layer = trackLayer('custom', 0, [
    {
      target: 'box',
      property: 'opacity',
      timing,
      destinationValue: '1',
      keyframes: [{ offset: 0, value: '0' }],
    },
  ])

  expect(layer.targets[0].properties[0].value).toBe('1')
})
