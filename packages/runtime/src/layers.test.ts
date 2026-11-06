import { describe, expect, it } from 'vite-plus/test'
import type { Definition, Expression, Layer } from './definition.ts'
import {
  layerTargets,
  resolveLayers,
  resolveLayerTracks,
  resolveComposition,
  type Composition,
} from './layers.ts'

const ref = (name: string): Expression => ({ kind: 'reference', path: [name] })
const targets = (properties: Record<string, string>) => [
  {
    name: 'body',
    properties: Object.entries(properties).map(([name, value]) => ({ name, value })),
  },
]
const definition = (layers: readonly Layer[]): Definition => ({
  name: 'button',
  layers,
  states: [],
  directionalTransitions: [],
})
const styles = (result: ReturnType<typeof resolveLayers>) =>
  Object.fromEntries(
    result.presentation.targets[0].properties.map((property) => [property.name, property.value]),
  )

const reactive = definition([
  { name: 'base', targets: targets({ scale: '1', opacity: '1' }) },
  { name: 'hover', when: ref('hover'), targets: targets({ scale: '1.1' }) },
  { name: 'press', when: ref('press'), targets: targets({ scale: '.9' }) },
  { name: 'selected', when: ref('selected'), targets: targets({ opacity: '.5' }) },
])

const machine: Layer = {
  name: 'submission',
  targets: targets({ opacity: '1' }),
  initialState: 'idle',
  states: [
    { name: 'idle', targets: targets({ scale: '1' }) },
    { name: 'loading', targets: targets({ scale: '.8' }) },
    { name: 'success', targets: targets({ scale: '1.2' }) },
  ],
  transitions: [
    { from: 'idle', to: 'loading', when: ref('loading'), transition: { targets: [] } },
    { from: 'idle', to: 'success', when: ref('completed'), transition: { targets: [] } },
    { from: 'success', to: 'idle', when: ref('completed'), transition: { targets: [] } },
  ],
}

describe('layer cascade', () => {
  it('contributes no styles when the definition has no layers', () => {
    const result = resolveLayers({ name: 'empty', states: [], directionalTransitions: [] }, {})

    expect(result.presentation.targets).toEqual([])
  })

  it('overrides per property in source order and restores obscured layers', () => {
    const active = resolveLayers(reactive, { hover: true, press: true, selected: true })
    const released = resolveLayers(reactive, { hover: true, press: false, selected: true })

    expect(styles(active)).toEqual({ scale: '.9', opacity: '.5' })
    expect(styles(released)).toEqual({ scale: '1.1', opacity: '.5' })
  })

  it('resolves final inputs independently of delivery order', () => {
    const first = resolveLayers(reactive, { selected: false, press: true, hover: true })
    const second = resolveLayers(reactive, { hover: true, press: true, selected: false })

    expect(first.presentation).toEqual(second.presentation)
  })

  it('re-evaluates CSS interpolation without adding units', () => {
    const source = definition([
      {
        name: 'base',
        targets: [
          {
            name: 'body',
            properties: [{ name: 'translate', value: '', template: [ref('x'), 'px 0'] }],
          },
        ],
      },
    ])

    expect(styles(resolveLayers(source, { x: 10 })).translate).toBe('10px 0')
    expect(styles(resolveLayers(source, { x: 20 })).translate).toBe('20px 0')
  })
})

describe('layer state machines', () => {
  it('reports an invalid current state instead of silently dropping a machine', () => {
    expect(() =>
      resolveLayers(definition([{ ...machine, initialState: 'missing' }]), {
        loading: false,
        completed: false,
      }),
    ).toThrow('Unknown current state')
  })

  it('evaluates initially true guards once and lets the last declaration win', () => {
    const result = resolveLayers(definition([machine]), { loading: true, completed: true })

    expect(result.states.get('submission')).toBe('success')
    expect(styles(result)).toEqual({ opacity: '1', scale: '1.2' })
  })

  it('retains state without eligible outgoing transitions', () => {
    const first = resolveLayers(definition([machine]), { loading: true, completed: false })
    const next = resolveLayers(
      definition([machine]),
      { loading: false, completed: false },
      first.states,
    )

    expect(next.states.get('submission')).toBe('loading')
    expect(next.transitions.size).toBe(0)
  })

  it('advances cycles only on subsequent updates', () => {
    const first = resolveLayers(definition([machine]), { loading: false, completed: true })
    const second = resolveLayers(
      definition([machine]),
      { loading: false, completed: true },
      first.states,
    )

    expect(first.states.get('submission')).toBe('success')
    expect(second.states.get('submission')).toBe('idle')
  })

  it('keeps machines independent and cascades later layer values', () => {
    const source = definition([
      machine,
      { ...machine, name: 'other' },
      { name: 'pressed', targets: targets({ scale: '.5' }) },
    ])
    const result = resolveLayers(source, { loading: true, completed: false })

    expect([...result.states]).toEqual([
      ['submission', 'loading'],
      ['other', 'loading'],
    ])
    expect(styles(result).scale).toBe('.5')
    expect(layerTargets(source).length).toBeGreaterThan(source.layers!.length)
  })
})

describe('layer animation ownership', () => {
  const tween: Expression = {
    kind: 'call',
    function: 'tween',
    arguments: [{ name: 'duration', value: { kind: 'number', value: 200 } }],
  }
  const base: Layer = {
    name: 'base',
    targets: [
      {
        name: 'body',
        properties: [
          { name: 'scale', value: '1', timingExpression: tween },
          { name: 'opacity', value: '1', timingExpression: tween },
        ],
      },
    ],
  }
  const visibility: Layer = {
    name: 'visibility',
    targets: [],
    initialState: 'closed',
    states: [
      { name: 'closed', targets: targets({ scale: '.9' }) },
      { name: 'open', targets: targets({ scale: '1.1' }) },
    ],
    transitions: [
      {
        from: 'closed',
        to: 'open',
        when: ref('open'),
        transition: {
          targets: [
            {
              name: 'body',
              properties: [{ name: 'scale', keyframes: [{ offset: 0.7, value: '1.2' }] }],
            },
          ],
        },
      },
    ],
  }

  it('cascades timing independently from values and completes an owned transition endpoint', () => {
    const source = definition([base, visibility])
    const before = resolveLayers(source, { open: false })
    const after = resolveLayers(source, { open: true }, before.states)
    const warnings: string[] = []

    const tracks = resolveLayerTracks(
      before,
      after,
      { open: true },
      () => '.95',
      (message) => warnings.push(message),
    )

    expect(tracks[0].timing).toMatchObject({ kind: 'tween', durationMs: 200 })
    expect(tracks[0].keyframes.map((frame) => frame.value)).toEqual(['.95', '1.2', '1.1'])
    expect(warnings).toEqual([])
  })

  it('ignores transition frames from a layer obscured by a later owner', () => {
    const source = definition([
      base,
      visibility,
      { name: 'press', when: ref('press'), targets: targets({ scale: '.8' }) },
    ])
    const before = resolveLayers(source, { open: false, press: false })
    const after = resolveLayers(source, { open: true, press: true }, before.states)

    const tracks = resolveLayerTracks(
      before,
      after,
      {},
      () => '.9',
      () => {
        throw new Error('Unexpected endpoint warning')
      },
    )

    expect(tracks[0].keyframes.map((frame) => frame.value)).toEqual(['.9', '.8'])
  })

  it('warns about an explicit endpoint disagreement while retaining the resolved destination', () => {
    const source = definition([
      base,
      {
        ...visibility,
        transitions: [
          {
            from: 'closed',
            to: 'open',
            when: ref('open'),
            transition: {
              targets: [
                {
                  name: 'body',
                  properties: [{ name: 'scale', keyframes: [{ offset: 1, value: '2' }] }],
                },
              ],
            },
          },
        ],
      },
    ])
    const before = resolveLayers(source, { open: false })
    const after = resolveLayers(source, { open: true }, before.states)
    const warnings: string[] = []

    const [track] = resolveLayerTracks(
      before,
      after,
      {},
      () => '.9',
      (message) => warnings.push(message),
    )

    expect(track.destinationValue).toBe('1.1')
    expect(track.keyframes.at(-1)?.value).toBe('2')
    expect(warnings[0]).toContain('differs from resolved style')
  })
  it('selects a newly owning style track even when its final value is unchanged', () => {
    const source = definition([
      base,
      {
        name: 'press',
        when: ref('press'),
        targets: [
          {
            name: 'body',
            properties: [
              {
                name: 'scale',
                value: '1',
                keyframes: [
                  { offset: 0, value: '.8' },
                  { offset: 1, value: '1' },
                ],
              },
            ],
          },
        ],
      },
    ])
    const before = resolveLayers(source, { press: false })
    const after = resolveLayers(source, { press: true }, before.states)

    const [track] = resolveLayerTracks(
      before,
      after,
      {},
      () => '1',
      () => {},
    )

    expect(track.keyframes.map((frame) => frame.value)).toEqual(['.8', '1'])
  })

  it('applies selected transition shared timing to properties without directional tracks', () => {
    const source = definition([
      base,
      {
        ...visibility,
        states: [
          { name: 'closed', targets: targets({ scale: '.9' }) },
          { name: 'open', targets: targets({ scale: '1.1', opacity: '.5' }) },
        ],
        transitions: [
          {
            from: 'closed',
            to: 'open',
            when: ref('open'),
            transition: {
              timing: { kind: 'tween', durationMs: 50, easing: 'linear' },
              targets: [{ name: 'body', properties: [{ name: 'scale' }] }],
            },
          },
        ],
      },
    ])
    const before = resolveLayers(source, { open: false })
    const after = resolveLayers(source, { open: true }, before.states)

    const tracks = resolveLayerTracks(
      before,
      after,
      {},
      () => '1',
      () => {},
    )

    expect(tracks.find((track) => track.property === 'scale')?.timing).toMatchObject({
      durationMs: 50,
    })
    expect(tracks.find((track) => track.property === 'opacity')?.timing).toMatchObject({
      durationMs: 50,
    })
  })
})

describe('explicit compositions', () => {
  it('resolves an empty selection for definitions without layers', () => {
    const source: Definition = { name: 'empty', states: [], directionalTransitions: [] }

    const result = resolveComposition(source, {}, { layers: {}, states: {} })

    expect(result.presentation.targets).toEqual([])
    expect(() => resolveComposition(source, {}, { layers: { unknown: true }, states: {} })).toThrow(
      'Invalid composition',
    )
  })

  const source = definition([reactive.layers![0], reactive.layers![1], machine])
  const from = { layers: { base: true, hover: false }, states: { submission: 'idle' } }
  const to = { layers: { base: false, hover: true }, states: { submission: 'loading' } }

  it('forces activation and states without evaluating guards', () => {
    const result = resolveComposition(source, {}, to)

    expect(styles(result)).toEqual({ scale: '.8', opacity: '1' })
    expect(result.composition).toEqual(to)
    expect(result.transitions.size).toBe(0)
  })

  it('selects duplicate state pairs by declaration index', () => {
    const first = machine.transitions![0]
    const second = {
      ...first,
      transition: {
        timing: { kind: 'tween' as const, durationMs: 50, easing: 'linear' },
        targets: [],
      },
    }
    const duplicate = definition([{ ...machine, transitions: [first, second] }])
    const before = { layers: {}, states: from.states }
    const after = { layers: {}, states: to.states }

    const result = resolveComposition(duplicate, {}, after, before, [
      { layer: 'submission', index: 1 },
    ])

    expect(result.transitions.get('submission')).toBe(second)
  })

  it.each<Composition>([
    { layers: { base: true }, states: from.states },
    { layers: { ...from.layers, unknown: true }, states: from.states },
    { layers: from.layers, states: { submission: 'missing' } },
    { layers: from.layers, states: {} },
  ])('rejects incomplete or unknown selections: %j', (composition) => {
    expect(() => resolveComposition(source, {}, composition)).toThrow('Invalid composition')
  })

  it.each([-1, 9, 0.5])('rejects invalid transition index %s', (index) => {
    expect(() =>
      resolveComposition(source, {}, to, from, [{ layer: 'submission', index }]),
    ).toThrow('Invalid composition transition')
  })

  it('requires FROM when selecting a transition', () => {
    expect(() =>
      resolveComposition(source, {}, to, undefined, [{ layer: 'submission', index: 0 }]),
    ).toThrow('Invalid composition transition')
  })

  it('rejects multiple transitions for one layer', () => {
    const transition = { layer: 'submission', index: 0 }

    expect(() => resolveComposition(source, {}, to, from, [transition, transition])).toThrow(
      'Invalid composition transition',
    )
  })

  it('rejects a selected transition incompatible with its endpoints', () => {
    expect(() =>
      resolveComposition(source, {}, from, to, [{ layer: 'submission', index: 0 }]),
    ).toThrow('Invalid composition transition')
  })
})

describe('composition animation ownership', () => {
  const timing = { kind: 'tween' as const, durationMs: 200, easing: 'linear' }
  const source = definition([
    {
      name: 'base',
      targets: [{ name: 'body', properties: [{ name: 'scale', value: '1', timing }] }],
    },
    {
      name: 'machine',
      targets: [],
      initialState: 'idle',
      states: [
        { name: 'idle', targets: targets({ scale: '1' }) },
        { name: 'active', targets: targets({ scale: '1' }) },
      ],
      transitions: [
        {
          from: 'idle',
          to: 'active',
          when: ref('unavailable'),
          transition: {
            targets: [
              {
                name: 'body',
                properties: [{ name: 'scale', keyframes: [{ offset: 0.5, value: '1.5' }] }],
              },
            ],
          },
        },
      ],
    },
    { name: 'cover', targets: targets({ scale: '1' }) },
  ])

  it.each([false, true])(
    'keeps intermediate motion only for the final owner (covered=%s)',
    (covered) => {
      const from = { layers: { base: true, cover: covered }, states: { machine: 'idle' } }
      const to = { ...from, states: { machine: 'active' } }
      const previous = resolveComposition(source, {}, from)
      const next = resolveComposition(source, {}, to, from, [{ layer: 'machine', index: 0 }])

      const tracks = resolveLayerTracks(
        previous,
        next,
        {},
        () => '1',
        () => {},
      )

      expect(tracks.map((track) => track.keyframes.map((frame) => frame.value))).toEqual(
        covered ? [] : [['1', '1.5', '1']],
      )
      expect(next.presentation.targets[0].properties[0].timing).toEqual(timing)
    },
  )
})

const timingScopes = [
  'transition property',
  'transition target',
  'transition shared',
  'state property',
  'state target',
  'state shared',
  'layer property',
  'layer target',
  'layer shared',
]

function hierarchicalDefinition(enabled: readonly number[]): Definition {
  const timingExpression = (index: number): Expression | undefined =>
    enabled.includes(index)
      ? {
          kind: 'call',
          function: 'tween',
          arguments: [{ name: 'duration', value: { kind: 'number', value: (index + 1) * 100 } }],
        }
      : undefined

  return definition([
    {
      name: 'machine',
      initialState: 'idle',
      timingExpression: timingExpression(8),
      targets: [
        {
          name: 'body',
          timingExpression: timingExpression(7),
          properties: [{ name: 'scale', value: '1', timingExpression: timingExpression(6) }],
        },
      ],
      states: [
        { name: 'idle', targets: [] },
        {
          name: 'active',
          timingExpression: timingExpression(5),
          targets: [
            {
              name: 'body',
              timingExpression: timingExpression(4),
              properties: [{ name: 'scale', value: '2', timingExpression: timingExpression(3) }],
            },
          ],
        },
      ],
      transitions: [
        {
          from: 'idle',
          to: 'active',
          when: { kind: 'boolean', value: true },
          transition: {
            timingExpression: timingExpression(2),
            targets: [
              {
                name: 'body',
                timingExpression: timingExpression(1),
                properties: [{ name: 'scale', timingExpression: timingExpression(0) }],
              },
            ],
          },
        },
      ],
    },
  ])
}

function hierarchicalTracks(source: Definition) {
  const from = { layers: {}, states: { machine: 'idle' } }
  const to = { layers: {}, states: { machine: 'active' } }
  const before = resolveComposition(source, {}, from)
  const after = resolveComposition(source, {}, to, from, [{ layer: 'machine', index: 0 }])

  return resolveLayerTracks(
    before,
    after,
    {},
    () => '1',
    () => {},
  )
}

describe('hierarchical timing precedence', () => {
  const pairs = timingScopes.flatMap((higherName, higher) =>
    timingScopes
      .slice(higher + 1)
      .map((lowerName, offset) => ({ higherName, lowerName, higher, lower: higher + 1 + offset })),
  )

  it.each(pairs)('$higherName overrides $lowerName', ({ higher, lower }) => {
    const [track] = hierarchicalTracks(hierarchicalDefinition([higher, lower]))

    expect(track.timing).toMatchObject({ kind: 'tween', durationMs: (higher + 1) * 100 })
  })

  it('applies destination-state shared timing to layer-common properties', () => {
    const source = hierarchicalDefinition([5, 6])
    const changed = {
      ...source,
      layers: source.layers?.map((layer) => ({
        ...layer,
        states: layer.states?.map((state) => ({ ...state, targets: [] })),
      })),
    }

    const [track] = hierarchicalTracks(changed)

    expect(track.timing).toMatchObject({ durationMs: 600 })
    expect(track.destinationValue).toBe('1')
  })

  it('applies shared timing from a transition without a body', () => {
    const source = hierarchicalDefinition([2, 3])
    const changed = {
      ...source,
      layers: source.layers?.map((layer) => ({
        ...layer,
        transitions: layer.transitions?.map((transition) => ({
          ...transition,
          transition: { ...transition.transition, targets: [] },
        })),
      })),
    }

    const [track] = hierarchicalTracks(changed)

    expect(track.timing).toMatchObject({ durationMs: 300 })
    expect(track.directionalOwner).toBe('machine')
  })
})
