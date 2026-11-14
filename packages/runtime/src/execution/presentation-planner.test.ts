import { describe, expect, it } from 'vite-plus/test'
import { resolveLayers, type LayerResolution } from '../composition/layers.ts'
import type { Definition } from '../model/definition.ts'
import {
  replacedEffects,
  layerPropertyKey,
  orderedResolution,
  ownsCanonicalProperty,
  planLayerChange,
  prepareLayerChange,
  type LayerPlanningSnapshot,
} from './presentation-planner.ts'

const timing = { kind: 'tween', durationMs: 300, easing: 'linear' } as const

function resolution(properties: readonly [string, string][]): LayerResolution {
  return resolveLayers(
    {
      name: 'motion',
      layers: [
        {
          name: 'base',
          timing,
          targets: [
            {
              name: 'box',
              properties: properties.map(([name, value]) => ({
                name,
                value: { kind: 'literal', value },
              })),
            },
          ],
        },
      ],
    },
    {},
  )
}

function snapshot(
  previous: LayerResolution,
  next: LayerResolution,
): LayerPlanningSnapshot & {
  displayed: ReadonlyMap<string, string>
  receivers: readonly {
    target: string
    addresses: readonly { name: string; addresses: readonly string[] }[]
  }[]
} {
  return {
    previous,
    next,
    values: {},
    displayed: new Map(
      next.presentation.targets.flatMap((target) =>
        target.properties.map((property) => [layerPropertyKey(target.name, property.name), '0.4']),
      ),
    ),
    receivers: [
      {
        target: 'box',
        addresses: next.presentation.targets.flatMap((target) =>
          target.properties.map((property) => ({
            name: property.name,
            addresses: [property.name],
          })),
        ),
      },
    ],
    active: [],
    retargets: new Set(),
  }
}

function planObservedChange(observations: ReturnType<typeof snapshot>) {
  return planLayerChange(
    prepareLayerChange(observations),
    observations.displayed,
    observations.receivers,
  )
}

describe('pure presentation planning', () => {
  it('rejects incomplete displayed observations before preparing effects', () => {
    const previous = resolution([['opacity', '0']])
    const next = resolution([['opacity', '1']])

    expect(() => planObservedChange({ ...snapshot(previous, next), displayed: new Map() })).toThrow(
      'Missing displayed snapshot: box.opacity',
    )
  })

  it('uses the supplied displayed start and preserves unrelated properties', () => {
    const previous = resolution([
      ['opacity', '0'],
      ['color', 'red'],
    ])
    const next = resolution([
      ['opacity', '1'],
      ['color', 'red'],
    ])

    const plan = planObservedChange(snapshot(previous, next))

    expect(plan.tracks).toMatchObject([
      { property: 'opacity', keyframes: [{ value: '0.4' }, { value: '1' }] },
    ])
    expect([...plan.changed]).toEqual([layerPropertyKey('box', 'opacity')])
    expect(plan.removedProperties.size).toBe(0)
  })

  it('marks removed declarations without generating a replacement track', () => {
    const previous = resolution([
      ['opacity', '1'],
      ['color', 'red'],
    ])
    const next = resolution([['opacity', '1']])

    const plan = planObservedChange(snapshot(previous, next))

    expect([...plan.removedProperties]).toEqual([layerPropertyKey('box', 'color')])
    expect(plan.tracks).toEqual([])
  })

  it('retargets unchanged values without advancing layer selection', () => {
    const current = resolution([['opacity', '1']])
    const observations = snapshot(current, current)

    const plan = planObservedChange({
      ...observations,
      retargets: new Set([layerPropertyKey('box', 'opacity')]),
    })

    expect(plan.tracks).toMatchObject([{ property: 'opacity', timing }])
    expect(current.states.size).toBe(0)
  })

  it('invalidates a directional track when its local state changes', () => {
    const current = resolution([['opacity', '1']])
    const observations = snapshot(current, current)

    const plan = planObservedChange({
      ...observations,
      active: [
        {
          track: {
            target: 'box',
            property: 'opacity',
            timing,
            destinationValue: '1',
            keyframes: [],
            directionalOwner: 'base',
            ownerState: 'open',
          },
        },
      ],
    })

    expect(plan.tracks).toHaveLength(1)
    expect(plan.changed.has(layerPropertyKey('box', 'opacity'))).toBe(true)
  })

  it('expands changed declarations using every receiver writing context', () => {
    const previous = resolution([['margin-inline-start', '0px']])
    const next = resolution([['margin-inline-start', '20px']])
    const observations = snapshot(previous, next)

    const plan = planObservedChange({
      ...observations,
      receivers: [
        { target: 'box', addresses: [{ name: 'margin-inline-start', addresses: ['margin-left'] }] },
        {
          target: 'box',
          addresses: [{ name: 'margin-inline-start', addresses: ['margin-right'] }],
        },
        { target: 'other', addresses: [] },
      ],
    })

    expect([...plan.changed]).toEqual([
      'box\0margin-inline-start',
      'box\0margin-left',
      'box\0margin-right',
    ])
  })

  it('preserves explicit equal-endpoint tracks', () => {
    const previous = resolution([['opacity', '1']])
    const next: LayerResolution = {
      ...previous,
      presentation: {
        name: '@layers',
        targets: [
          {
            name: 'box',
            properties: [
              {
                name: 'opacity',
                owner: 'base',
                value: '1',
                timing,
                keyframes: [
                  { offset: 0, value: '1' },
                  { offset: 1, value: '1' },
                ],
              },
            ],
          },
        ],
      },
    }

    const plan = planObservedChange(snapshot(previous, next))

    expect(plan.tracks).toHaveLength(1)
    expect(plan.tracks[0].keyframes.map((frame) => frame.value)).toEqual(['1', '1'])
    expect(plan.diagnostics).toEqual([])
  })

  it('cancels affected authored and canonical tracks while preserving unrelated effects', () => {
    const active = [
      { id: 1, target: 'box', sourceProperty: 'margin', property: 'margin-left' },
      { id: 2, target: 'box', sourceProperty: 'margin-inline', property: 'margin-right' },
      { id: 3, target: 'box', sourceProperty: 'color', property: 'color' },
      { id: 4, target: 'other', sourceProperty: 'margin', property: 'margin-left' },
      { id: 5, target: 'box', sourceProperty: 'opacity', property: 'opacity' },
    ]

    const replaced = replacedEffects(
      active,
      new Set(['box\0margin-left', 'box\0margin-inline']),
      new Set(['box\0color']),
    )

    expect(replaced).toEqual([1, 2, 3])
  })

  it('reports explicit endpoints that differ from the completion presentation', () => {
    const previous = resolution([['opacity', '1']])
    const next: LayerResolution = {
      ...previous,
      presentation: {
        name: '@layers',
        targets: [
          {
            name: 'box',
            properties: [
              {
                name: 'opacity',
                owner: 'base',
                value: '1',
                timing,
                keyframes: [
                  { offset: 0, value: '1' },
                  { offset: 1, value: '0.5' },
                ],
              },
            ],
          },
        ],
      },
    }

    const plan = planObservedChange(snapshot(previous, next))

    expect(plan.tracks[0].destinationValue).toBe('1')
    expect(plan.tracks[0].keyframes).toEqual([
      { offset: 0, value: '1', easing: 'linear' },
      { offset: 1, value: '0.5', easing: 'linear' },
    ])
    expect(plan.diagnostics).toEqual([
      'Transition endpoint differs from resolved style: box.opacity; completion restores 1',
    ])
  })
})

describe('canonical declaration ownership', () => {
  it('uses the final declaration addressing a physical property', () => {
    const addresses = [
      { name: 'margin', addresses: ['margin-left', 'margin-right'] },
      { name: 'margin-left', addresses: ['margin-left'] },
    ]

    expect(ownsCanonicalProperty(addresses, 'margin', 'margin-left')).toBe(false)
    expect(ownsCanonicalProperty(addresses, 'margin', 'margin-right')).toBe(true)
    expect(ownsCanonicalProperty(addresses, 'margin-left', 'margin-left')).toBe(true)
    expect(ownsCanonicalProperty(addresses, 'margin', 'opacity')).toBe(true)
  })

  it('orders state declarations and common properties in source cascade order', () => {
    const definition: Definition = {
      name: 'motion',
      layers: [
        {
          name: 'base',
          targets: [
            {
              name: 'box',
              properties: [
                { name: 'margin-left', value: { kind: 'literal', value: '1px' } },
                { name: 'margin', value: { kind: 'literal', value: '2px' } },
              ],
            },
          ],
          initialState: 'open',
          states: [
            {
              name: 'open',
              targets: [
                {
                  name: 'box',
                  properties: [{ name: 'margin-left', value: { kind: 'literal', value: '3px' } }],
                },
              ],
            },
          ],
        },
      ],
    }
    const current = resolveLayers(definition, {})

    const ordered = orderedResolution(current, definition)

    expect(ordered.presentation.targets[0].properties.map((property) => property.name)).toEqual([
      'margin',
      'margin-left',
    ])
  })
})
