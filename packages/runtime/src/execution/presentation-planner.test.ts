import { describe, expect, it } from 'vite-plus/test'
import { resolveLayers, type LayerResolution } from '../composition/layers.ts'
import type { Definition } from '../model/definition.ts'
import {
  planTrack,
  trackTiming,
  trackObservationNeeds,
  type TrackSnapshot,
  planEffectChanges,
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

function layerSnapshot(
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

function planObservedChange(observations: ReturnType<typeof layerSnapshot>) {
  return planLayerChange(
    prepareLayerChange(observations),
    observations.displayed,
    observations.receivers,
  )
}

describe('pure presentation planning', () => {
  it('rejects missing displayed start values for implicit tracks', () => {
    const previous = resolution([['opacity', '0']])
    const next = resolution([['opacity', '1']])

    expect(() =>
      planObservedChange({ ...layerSnapshot(previous, next), displayed: new Map() }),
    ).toThrow('Missing displayed snapshot: box.opacity')
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

    const plan = planObservedChange(layerSnapshot(previous, next))

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

    const plan = planObservedChange(layerSnapshot(previous, next))

    expect([...plan.removedProperties]).toEqual([layerPropertyKey('box', 'color')])
    expect(plan.tracks).toEqual([])
  })

  it('creates a track when unchanged values are explicitly retargeted', () => {
    const current = resolution([['opacity', '1']])
    const observations = layerSnapshot(current, current)

    const plan = planObservedChange({
      ...observations,
      retargets: new Set([layerPropertyKey('box', 'opacity')]),
    })

    expect(plan.tracks).toMatchObject([{ property: 'opacity', timing }])
  })

  it('expands changed declarations using every receiver writing context', () => {
    const previous = resolution([['margin-inline-start', '0px']])
    const next = resolution([['margin-inline-start', '20px']])
    const observations = layerSnapshot(previous, next)

    const plan = planObservedChange({
      ...observations,
      displayed: new Map([[layerPropertyKey('box', 'margin-inline-start'), '0px']]),
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

    const plan = planObservedChange(layerSnapshot(previous, next))

    expect(plan.tracks).toHaveLength(1)
    expect(plan.tracks[0].keyframes.map((frame) => frame.value)).toEqual(['1', '1'])
    expect(plan.diagnostics).toEqual([])
  })

  it('replaces changed sources while preserving an unchanged higher canonical owner', () => {
    const previous = resolution([
      ['margin-left', '1px'],
      ['margin', '10px'],
      ['opacity', '1'],
    ])
    const next = resolution([
      ['margin-left', '2px'],
      ['margin', '10px'],
      ['opacity', '0'],
    ])
    const active = [
      {
        id: 1,
        target: 'box',
        sourceProperty: 'margin',
        property: 'margin-left',
        track: {
          target: 'box',
          property: 'margin-left',
          timing,
          keyframes: [],
          destinationValue: '10px',
        },
      },
      {
        id: 2,
        target: 'box',
        sourceProperty: 'opacity',
        property: 'opacity',
        track: { target: 'box', property: 'opacity', timing, keyframes: [], destinationValue: '1' },
      },
    ]
    const receivers = [
      {
        target: 'box',
        addresses: [
          { name: 'margin-left', addresses: ['margin-left'] },
          { name: 'margin', addresses: ['margin-left', 'margin-right'] },
          { name: 'opacity', addresses: ['opacity'] },
        ],
      },
    ]

    expect(planEffectChanges(previous, next, active, new Set(), receivers)).toEqual([2])
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

function receiverSnapshot(overrides: Partial<TrackSnapshot> = {}): TrackSnapshot {
  const track = {
    target: 'box',
    property: 'opacity',
    timing,
    implicitStart: true,
    destinationValue: '1',
    keyframes: [
      { offset: 0, value: '0.2' },
      { offset: 0.5, value: '0.6' },
      { offset: 1, value: '1' },
    ],
  }

  return {
    id: 17,
    receiver: 3,
    source: track,
    track,
    declarations: [{ name: 'opacity', addresses: ['opacity'] }],
    displayed: '0.4',
    interrupted: false,
    ...overrides,
  }
}

function finalPlan(snapshot: TrackSnapshot) {
  return planTrack(snapshot, trackTiming(snapshot.track), 'both')
}

describe('final pure track planning', () => {
  it.each([
    { implicit: true, interrupted: false, start: '0.4' },
    { implicit: false, interrupted: true, start: '0.4' },
    { implicit: false, interrupted: false, start: '0.2' },
  ])(
    'uses the appropriate start for implicit=$implicit and interrupted=$interrupted',
    ({ implicit, interrupted, start }) => {
      const snapshot = receiverSnapshot()
      const track = { ...snapshot.track, implicitStart: implicit }

      const plan = finalPlan({ ...snapshot, track, interrupted })

      expect(plan?.frames.map((frame) => frame.value)).toEqual([start, '0.6', '1'])
      expect(snapshot.track.keyframes[0].value).toBe('0.2')
    },
  )

  it('rejects missing displayed observations needed for interruption', () => {
    const snapshot = receiverSnapshot({ displayed: undefined })

    expect(() => finalPlan(snapshot)).toThrow('Missing displayed track snapshot: box.opacity')
  })

  it('omits an obscured canonical track before requiring its observations', () => {
    const snapshot = receiverSnapshot({
      displayed: undefined,
      declarations: [
        { name: 'opacity', addresses: ['opacity'] },
        { name: 'later', addresses: ['opacity'] },
      ],
    })

    expect(finalPlan(snapshot)).toBeUndefined()
  })

  it('keeps source declaration identity when a canonical property is expanded', () => {
    const snapshot = receiverSnapshot()
    const source = {
      ...snapshot.source,
      property: 'margin-inline',
      destinationValue: '10px 20px',
      keyframes: [
        { offset: 0, value: '0px 0px' },
        { offset: 1, value: '10px 20px' },
      ],
    }
    const track = {
      ...snapshot.track,
      property: 'margin-left',
      destinationValue: '10px',
      keyframes: [
        { offset: 0, value: '0px' },
        { offset: 1, value: '10px' },
      ],
    }

    const plan = finalPlan({
      ...snapshot,
      source,
      track,
      displayed: '0px',
      declarations: [{ name: 'margin-inline', addresses: ['margin-left', 'margin-right'] }],
    })

    expect(plan).toMatchObject({
      id: 17,
      receiver: 3,
      sourceProperty: 'margin-inline',
      sourceDestination: '10px 20px',
      track: { property: 'margin-left' },
    })
  })

  it('uses supplied canonical position and units-per-millisecond velocity for supported springs', () => {
    const snapshot = receiverSnapshot()
    const track = {
      ...snapshot.track,
      timing: { kind: 'spring-duration', durationMs: 500, bounce: 0.1 } as const,
      keyframes: [snapshot.track.keyframes[0], snapshot.track.keyframes[2]],
    }

    const plan = finalPlan({
      ...snapshot,
      track,
      motion: { start: { value: [0.4], velocity: [0.001] }, end: [1], relative: false },
    })
    const start = plan?.trajectory?.(0)

    // Analytic sampling at t=0 preserves initial conditions within floating-point roundoff.
    expect(start?.value[0]).toBeCloseTo(0.4, 12)
    expect(start?.velocity[0]).toBeCloseTo(0.001, 12)
    expect(plan?.frames.at(-1)?.value).toBe('1')
    expect(plan?.frames.length).toBeGreaterThan(2)
    expect(plan?.easing).toBe('linear')
  })

  it.each([
    { label: 'unreadable start', start: undefined, end: [20], relative: false, numeric: false },
    {
      label: 'unreadable destination',
      start: { value: [0], velocity: [0.01] },
      end: undefined,
      relative: false,
      numeric: false,
    },
    {
      label: 'incompatible components',
      start: { value: [0], velocity: [0.01] },
      end: [1, 2],
      relative: false,
      numeric: false,
    },
    {
      label: 'stationary absolute length',
      start: { value: [0], velocity: [0] },
      end: [20],
      relative: false,
      numeric: false,
    },
    {
      label: 'stationary relative length',
      start: { value: [0], velocity: [0] },
      end: [20],
      relative: true,
      numeric: true,
    },
  ])('preserves numeric handoff support limits for $label', ({ start, end, relative, numeric }) => {
    const snapshot = receiverSnapshot()
    const track = {
      ...snapshot.track,
      property: 'width',
      timing: { kind: 'spring-duration', durationMs: 500, bounce: 0.1 } as const,
      destinationValue: relative ? '50%' : '20px',
      keyframes: [
        { offset: 0, value: '0px' },
        { offset: 1, value: relative ? '50%' : '20px' },
      ],
    }

    const plan = finalPlan({
      ...snapshot,
      source: track,
      track,
      displayed: '0px',
      declarations: [{ name: 'width', addresses: ['width'] }],
      motion: { start, end, relative },
    })

    expect(plan?.trajectory !== undefined).toBe(numeric)
    expect(plan?.frames.at(-1)?.value).toBe('20px')
  })

  it('passes arbitrary CSS through scalar spring easing when numeric codecs do not support it', () => {
    const snapshot = receiverSnapshot()
    const track = {
      ...snapshot.track,
      property: 'color',
      timing: { kind: 'spring-duration', durationMs: 500, bounce: 0.1 } as const,
      destinationValue: 'red',
      keyframes: [
        { offset: 0, value: 'blue' },
        { offset: 1, value: 'red' },
      ],
    }

    const plan = finalPlan({
      ...snapshot,
      source: track,
      track,
      displayed: 'blue',
      declarations: [{ name: 'color', addresses: ['color'] }],
      motion: { start: { value: [0], velocity: [0.01] }, end: [1], relative: false },
    })

    expect(plan?.trajectory).toBeUndefined()
    expect(plan?.frames.at(-1)?.value).toBe('red')
  })

  it('preserves intermediate frames instead of using endpoint-only velocity handoff', () => {
    const observations = receiverSnapshot()
    const track = {
      ...observations.track,
      timing: { kind: 'spring-duration', durationMs: 500, bounce: 0.1 } as const,
    }

    const plan = finalPlan({
      ...observations,
      track,
      motion: { start: { value: [0.4], velocity: [0.001] }, end: [1], relative: false },
    })

    expect(plan?.trajectory).toBeUndefined()
    expect(plan?.frames.map((frame) => frame.value)).toEqual(['0.4', '0.6', '1'])
  })

  it('does not request motion samples for manual endpoint-spring previews', () => {
    const observations = receiverSnapshot()
    const track = {
      ...observations.track,
      timing: { kind: 'spring-duration', durationMs: 500, bounce: 0.1 } as const,
      keyframes: [observations.track.keyframes[0], observations.track.keyframes[2]],
    }

    expect(trackObservationNeeds(track, false, false).motion).toBe(false)
  })

  it('keeps explicit equal endpoints and preview fill without numeric observations', () => {
    const snapshot = receiverSnapshot()
    const track = {
      ...snapshot.track,
      implicitStart: false,
      keyframes: [
        { offset: 0, value: '1' },
        { offset: 1, value: '1' },
      ],
    }

    const plan = planTrack(
      { ...snapshot, track, displayed: undefined },
      trackTiming(track),
      'backwards',
    )

    expect(plan?.frames.map((frame) => frame.value)).toEqual(['1', '1'])
    expect(plan?.fill).toBe('backwards')
  })
})

it('uses completion as the observation endpoint when custom work omits its final frame', () => {
  expect(
    trackObservationNeeds(
      {
        target: 'box',
        property: 'opacity',
        timing: { kind: 'tween', durationMs: 100, easing: 'linear' },
        keyframes: [{ offset: 0, value: '0' }],
        destinationValue: '1',
      },
      false,
      false,
    ).endpoint,
  ).toBe('1')
})
