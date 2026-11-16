import type { ResolvedTrack } from '../composition/resolve.ts'
import { describe, expect, it } from 'vite-plus/test'
import { resolveLayers, type LayerResolution } from '../composition/layers.ts'
import type { Definition } from '../model/definition.ts'
import {
  planTrack,
  planControllerBindings,
  planControllerPresentation,
  planTrackObservations,
  planPresentation,
  planEffectCompletion,
  planPreviewPresentation,
  planMotionChange,
  type PresentationFacts,
  trackTiming,
  trackObservationNeeds,
  type TrackSnapshot,
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

  it('invalidates canonical directional effects even when their logical declaration is unchanged', () => {
    const previous = {
      ...resolution([
        ['inset-inline', '0px'],
        ['right', '0px'],
      ]),
      states: new Map([['base', 'old']]),
    }
    const next = { ...previous, states: new Map([['base', 'new']]) }
    const directional: ResolvedTrack = {
      target: 'box',
      property: 'left',
      owner: 'base',
      directionalOwner: 'base',
      ownerState: 'old',
      timing,
      destinationValue: '0px',
      keyframes: [
        { offset: 0, value: '20px' },
        { offset: 1, value: '0px' },
      ],
    }
    const preparation = prepareLayerChange({
      previous,
      next,
      values: {},
      active: [{ track: directional }],
      retargets: new Set(),
    })
    const change = planLayerChange(preparation, new Map(), [
      {
        target: 'box',
        addresses: [
          { name: 'inset-inline', addresses: ['left', 'right'] },
          { name: 'right', addresses: ['right'] },
        ],
      },
    ])

    const replaced = replacedEffects(
      [
        { id: 1, target: 'box', sourceProperty: 'inset-inline', property: 'left', owner: 'base' },
        { id: 2, target: 'box', sourceProperty: 'right', property: 'right', owner: 'base' },
      ],
      change.changed,
      change.removedProperties,
      change.preserved,
    )

    expect(replaced).toEqual([1])
  })

  it('preserves only the unchanged canonical owner, independently of lower writes and other targets', () => {
    const active = [
      { id: 1, target: 'box', sourceProperty: 'inset-inline', property: 'left', owner: 'presence' },
      { id: 2, target: 'box', sourceProperty: 'inset-inline', property: 'right', owner: 'base' },
      {
        id: 3,
        target: 'other',
        sourceProperty: 'inset-inline',
        property: 'left',
        owner: 'presence',
      },
      { id: 4, target: 'box', sourceProperty: 'color', property: 'color', owner: 'base' },
      { id: 5, target: 'box', sourceProperty: 'left', property: 'left', owner: 'new' },
      { id: 6, target: 'box', sourceProperty: 'left', property: 'left', owner: 'presence' },
    ]

    const replaced = replacedEffects(
      active,
      new Set(['box\0inset-inline', 'other\0inset-inline', 'box\0left']),
      new Set(),
      [
        { target: 'box', property: 'left', sourceProperty: 'inset-inline', owner: 'presence' },
        { target: 'box', property: 'right', sourceProperty: 'inset-inline', owner: 'other' },
      ],
    )

    expect(replaced).toEqual([2, 3, 5, 6])
  })

  it('selects replacement effects by authored/canonical properties and removed declarations', () => {
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
  it('suppresses a target-wide controller if any receiver has an overlapping winning declaration', () => {
    const current = resolution([
      ['margin-inline', '0px'],
      ['margin-left', '10px'],
    ])
    const bound: LayerResolution = {
      ...current,
      presentation: {
        ...current.presentation,
        targets: [
          {
            ...current.presentation.targets[0],
            properties: current.presentation.targets[0].properties.map((property) =>
              property.name === 'margin-inline'
                ? { ...property, binding: { kind: 'reference', path: ['controller'] } }
                : property,
            ),
          },
        ],
      },
    }
    const receiver = {
      id: 1,
      target: 'box',

      fallbacks: [],
      addresses: [
        { name: 'margin-inline', addresses: ['margin-right'] },
        { name: 'margin-left', addresses: ['margin-left'] },
      ],
    }
    const conflicting = {
      ...receiver,
      id: 2,
      addresses: [
        { name: 'margin-inline', addresses: ['margin-left'] },
        { name: 'margin-left', addresses: ['margin-left'] },
      ],
    }

    expect(planControllerBindings(bound, [receiver])).toHaveLength(1)
    expect(planControllerBindings(bound, [receiver, conflicting])).toEqual([])
  })

  it.each([
    {
      label: 'unreadable controller',
      outputs: new Map<string, string | undefined>([['box\0opacity', undefined]]),
      expected: ['0.2'],
    },
    { label: 'obscured controller', outputs: new Map<string, string | undefined>(), expected: [] },
    {
      label: 'readable controller',
      outputs: new Map<string, string | undefined>([['box\0opacity', '0.6']]),
      expected: ['0.6'],
    },
  ])('uses normal fallback only for a selected $label', ({ outputs, expected }) => {
    const definition: Definition = {
      name: 'bound',
      layers: [
        {
          name: 'base',
          targets: [
            {
              name: 'box',
              properties: [{ name: 'opacity', value: { kind: 'literal', value: '0.2' } }],
            },
          ],
        },
      ],
    }
    const normal = resolveLayers(definition, {})
    const bound: LayerResolution = {
      ...normal,
      presentation: {
        ...normal.presentation,
        targets: [
          {
            ...normal.presentation.targets[0],
            properties: [
              {
                ...normal.presentation.targets[0].properties[0],
                binding: { kind: 'reference', path: ['controller'] },
              },
            ],
          },
        ],
      },
    }

    const plan = planControllerPresentation(bound, normal, outputs, definition)

    expect(plan.presentation.targets[0].properties.map((property) => property.value)).toEqual(
      expected,
    )
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
  it.each([true, false])(
    'requests receiving-element interruption observations during live=%s',
    (live) => {
      const snapshot = receiverSnapshot()
      const track = { ...snapshot.track, implicitStart: false }
      const candidates = [1, 2].map((receiver) => ({
        receiver,
        source: track,
        track,
        declarations: snapshot.declarations,
      }))

      const plan = planTrackObservations(candidates, executionFacts().active, live)

      expect(plan.requests.map((request) => request.needs.displayed)).toEqual(
        live ? [true, false] : [false, false],
      )
      expect(plan.requests.map((request) => request.interrupted)).toEqual([live, false])
      expect(plan.requests.map((request) => request.reference)).toEqual([live, live])
      expect([...plan.changed]).toEqual(['box\0opacity'])
    },
  )
})

function executionFacts(): PresentationFacts {
  const track = receiverSnapshot().track

  return {
    mode: 'live',
    suspended: false,
    reduced: false,
    preserveLifecycle: true,
    receivers: [
      { id: 1, target: 'box' },
      { id: 2, target: 'box' },
    ],
    active: [
      {
        id: 9,
        preview: false,
        receiver: 1,
        target: 'box',
        property: 'opacity',
        sourceProperty: 'opacity',
        sourceDestination: '1',
        track,
      },
      {
        id: 10,
        preview: false,
        receiver: 2,
        target: 'box',
        property: 'color',
        sourceProperty: 'color',
        sourceDestination: 'blue',
        track: { ...track, property: 'color' },
      },
    ],
  }
}

describe('complete presentation planning', () => {
  it.each([
    { reduced: false, mode: 'live' as const },
    { reduced: true, mode: 'preview' as const },
  ])('preserves effects for reduced=$reduced and mode=$mode', ({ reduced, mode }) => {
    const next = resolution([['opacity', '1']])

    const facts: PresentationFacts = {
      ...executionFacts(),
      reduced,
      mode,
      active: executionFacts().active.map((effect) => ({ ...effect, preview: mode === 'preview' })),
    }

    expect(planMotionChange(next, facts)).toBeUndefined()
  })

  it('settles all live effects and restores ordinary ownership under reduced motion', () => {
    const next = resolution([
      ['opacity', '1'],
      ['color', 'red'],
    ])
    const facts: PresentationFacts = {
      ...executionFacts(),
      reduced: true,
      receivers: [
        { id: 1, target: 'box' },
        { id: 2, target: 'box' },
      ],
    }

    const plan = planMotionChange(next, facts)

    expect(plan?.cancel).toEqual([9, 10])
    expect(plan?.restore).toBe(true)
    expect(plan?.preserveLifecycle).toBe(false)
    expect(plan?.resetMotion).toBe(true)
    expect(plan?.writes).toEqual([
      { receiver: 1, property: 'opacity', value: '1' },
      { receiver: 2, property: 'opacity', value: '1' },
      { receiver: 1, property: 'color', value: 'red' },
      { receiver: 2, property: 'color', value: 'red' },
    ])
  })

  it.each(['preparing-preview', 'preview'] as const)(
    'settles only live effects without changing frozen %s presentation',
    (mode) => {
      const next = resolution([['opacity', '1']])
      const facts: PresentationFacts = {
        ...executionFacts(),
        reduced: true,
        mode,
        active: executionFacts().active.map((effect) => ({
          ...effect,
          preview: effect.id === 10,
        })),
      }

      const plan = planMotionChange(next, facts)

      expect(plan?.mode).toBe('maintenance')
      expect(plan?.cancel).toEqual([9])
      expect(plan?.restore).toBe(false)
      expect(plan?.preserveLifecycle).toBe(true)
      expect(plan?.resetMotion).toBe(false)
      expect(plan?.writes).toEqual([])
      expect(plan?.start).toEqual([])
    },
  )

  it('restores suspended playback without writing unavailable targets', () => {
    const next = resolution([['opacity', '1']])
    const facts: PresentationFacts = {
      ...executionFacts(),
      reduced: true,
      suspended: true,
    }

    const plan = planMotionChange(next, facts)

    expect(plan?.restore).toBe(true)
    expect(plan?.preserveLifecycle).toBe(false)
    expect(plan?.writes).toEqual([])
  })

  it('restores removed declarations and reapplies the ordered cascade', () => {
    const next = resolution([
      ['opacity', '1'],
      ['color', 'red'],
    ])

    const plan = planPresentation(
      next,
      executionFacts(),
      new Set(['box\0opacity']),
      new Set(['box\0width']),
      [],
    )

    expect(plan.cancel).toEqual([9])
    expect(plan.restore).toBe(true)
    expect(plan.preserveLifecycle).toBe(true)
    expect(plan.writes).toEqual([
      { receiver: 1, property: 'opacity', value: '1' },
      { receiver: 2, property: 'opacity', value: '1' },
      { receiver: 1, property: 'color', value: 'red' },
      { receiver: 2, property: 'color', value: 'red' },
    ])
  })

  it('accepts suspended presentation changes without restoring or writing DOM styles', () => {
    const next = resolution([['opacity', '1']])

    const plan = planPresentation(
      next,
      { ...executionFacts(), suspended: true },
      new Set(['box\0opacity']),
      new Set(['box\0color']),
      [],
    )

    expect(plan.resolution).toBe(next)
    expect(plan.cancel).toEqual([9, 10])
    expect(plan.restore).toBe(false)
    expect(plan.writes).toEqual([])
  })

  it('reconciles completion only on the completed receiver and ignores stale effect IDs', () => {
    const next = resolution([
      ['opacity', '1'],
      ['color', 'red'],
    ])
    const facts = executionFacts()

    const plan = planEffectCompletion(next, facts, 10)

    expect(plan?.cancel).toEqual([10])
    expect(plan?.writes).toEqual([
      { receiver: 2, property: 'color', value: 'blue' },
      { receiver: 2, property: 'opacity', value: '1' },
      { receiver: 2, property: 'color', value: 'red' },
    ])
    expect(planEffectCompletion(next, facts, 11)).toBeUndefined()
  })

  it('plans an isolated preview baseline for every current receiver', () => {
    const next = resolution([['opacity', '1']])

    const plan = planPreviewPresentation(next, executionFacts().receivers, [])

    expect(plan.mode).toBe('preview')
    expect(plan.writes).toEqual([
      { receiver: 1, property: 'opacity', value: '1' },
      { receiver: 2, property: 'opacity', value: '1' },
    ])
  })
})
