import { describe, expect, it, vi } from 'vite-plus/test'
import type { Definition, Expression, Layer, Property, State, Timing } from './definition.ts'
import {
  compositionLayerSelection,
  resolveLayerCascade,
  timingProvider,
  transitionPropertySources,
  type LayerSelection,
  type PropertySource,
  type TimingDeclaration,
  type TimingSource,
} from './layer-cascade.ts'

const tween: Timing = { kind: 'tween', durationMs: 200, easing: 'linear' }
const dynamic: Expression = { kind: 'reference', path: ['duration'] }
const identity = <T>(value: T) => value
const property = (name: string, value: string): Property => ({ name, value })
const layer = (name: string, properties: readonly Property[]): Layer => ({
  name,
  targets: [{ name: 'body', properties }],
})
const definition = (layers: readonly Layer[]): Definition => ({
  name: 'sample',
  layers,
})
const resolveSources = (selection: Iterable<LayerSelection>) =>
  resolveLayerCascade(selection, identity<PropertySource>, identity<TimingSource>)

const timingScopes = [
  'state property',
  'state target',
  'state shared',
  'common property',
  'common target',
  'layer shared',
] as const

function timingCases(scopes: readonly string[]) {
  return Array.from({ length: 2 ** scopes.length }, (entry, mask) => ({
    label: scopes.filter((_, index) => mask & (1 << index)).join(', ') || 'none',
    enabled: scopes.map((_, index) => Boolean(mask & (1 << index))),
  }))
}

function scopedSelection(enabled: readonly boolean[], kind: 'value' | 'expression') {
  const declarations: TimingDeclaration[] = enabled.map((active, index) =>
    !active
      ? {}
      : kind === 'value'
        ? { timing: { ...tween, durationMs: index + 1 } }
        : { timingExpression: { kind: 'reference', path: [`timing${index}`] } },
  )
  const state: State = {
    name: 'active',
    ...declarations[2],
    targets: [
      {
        name: 'body',
        ...declarations[1],
        properties: [{ name: 'opacity', value: '0.5', ...declarations[0] }],
      },
    ],
  }
  const common: Layer = {
    name: 'base',
    ...declarations[5],
    states: [state],
    targets: [
      {
        name: 'body',
        ...declarations[4],
        properties: [{ name: 'opacity', value: '1', ...declarations[3] }],
      },
    ],
  }

  return { layer: common, state }
}

function expectedTimingSource(selection: { layer: Layer; state: State }, winner: number) {
  if (winner < 0) return undefined

  const isState = winner < 3
  const scope = winner % 3
  const sourceTarget = (isState ? selection.state : selection.layer).targets[0]
  const declaration =
    scope === 0
      ? sourceTarget.properties[0]
      : scope === 1
        ? sourceTarget
        : isState
          ? selection.state
          : selection.layer

  return {
    layer: selection.layer,
    state: isState ? selection.state : undefined,
    ...(scope < 2 ? { target: sourceTarget } : {}),
    ...(scope === 0 ? { property: sourceTarget.properties[0] } : {}),
    declaration,
  }
}

describe('compositionLayerSelection', () => {
  it('accepts a definition without contributing layers', () => {
    expect([...compositionLayerSelection(definition([]), { layers: {}, states: {} })]).toEqual([])
  })

  it('uses explicit activation and state selections in definition order without evaluating guards', () => {
    const first = { ...layer('first', []), when: dynamic }
    const disabled = layer('disabled', [])
    const idle: State = { name: 'idle', targets: [] }
    const active: State = { name: 'active', targets: [] }
    const machine: Layer = {
      name: 'machine',
      targets: [],
      states: [idle, active],
      initialState: 'idle',
      when: dynamic,
      transitions: [{ from: 'active', to: 'idle', when: dynamic, transition: { targets: [] } }],
    }
    const last = { ...layer('last', []), states: [] }
    const source = definition([first, disabled, machine, last])

    const result = [
      ...compositionLayerSelection(source, {
        layers: { last: true, disabled: false, first: true },
        states: { machine: 'active' },
      }),
    ]

    expect(result).toEqual([{ layer: first }, { layer: machine, state: active }, { layer: last }])
  })

  it.each<Record<string, string>>([{}, { machine: 'missing' }])(
    'rejects a missing or unknown selected state (%j)',
    (states) => {
      const machine: Layer = {
        name: 'machine',
        targets: [],
        states: [{ name: 'idle', targets: [] }],
      }

      expect(() => [
        ...compositionLayerSelection(definition([machine]), { layers: {}, states }),
      ]).toThrow('Unknown current state in layer machine:')
    },
  )
})

describe('resolveLayerCascade', () => {
  it.each([{ selection: [] }, { selection: [{ layer: { name: 'empty', targets: [] } }] }])(
    'resolves empty contributions (%j)',
    ({ selection }) => {
      const mapValue = vi.fn<(source: PropertySource) => PropertySource>(identity)
      const mapTiming = vi.fn<(source: TimingSource) => TimingSource>(identity)

      expect(resolveLayerCascade(selection, mapValue, mapTiming)).toEqual([])
      expect(mapValue).not.toHaveBeenCalled()
      expect(mapTiming).not.toHaveBeenCalled()
    },
  )

  it('preserves empty targets without inventing properties', () => {
    expect(resolveSources([{ layer: layer('empty', []) }])).toEqual([
      { name: 'body', properties: [] },
    ])
  })

  it('overrides common and earlier layer values per property while retaining declaration history', () => {
    const base = layer('base', [property('opacity', '1'), property('scale', '1')])
    const upper = layer('upper', [property('opacity', '0.8')])
    const state: State = {
      name: 'active',
      targets: [{ name: 'body', properties: [property('opacity', '0.5')] }],
    }

    const [target] = resolveSources([{ layer: base }, { layer: upper, state }])
    const [opacity, scale] = target.properties

    expect(opacity.source).toMatchObject({ layer: upper, state, property: { value: '0.5' } })
    expect(
      opacity.declarations.map((source) => [
        source.layer.name,
        source.state?.name,
        source.property.value,
      ]),
    ).toEqual([
      ['base', undefined, '1'],
      ['upper', undefined, '0.8'],
      ['upper', 'active', '0.5'],
    ])
    expect(scale.source.layer).toBe(base)
    expect(scale.declarations).toHaveLength(1)
  })

  it('keeps targets independent and preserves first-seen target and property order', () => {
    const base: Layer = {
      name: 'base',
      targets: [
        { name: 'body', properties: [property('scale', '1'), property('opacity', '1')] },
        { name: 'badge', properties: [property('opacity', '0.2')] },
      ],
    }
    const state: State = {
      name: 'active',
      targets: [
        { name: 'body', properties: [property('opacity', '0.5'), property('color', 'red')] },
        { name: 'label', properties: [property('opacity', '0.9')] },
      ],
    }

    const result = resolveSources([{ layer: base, state }])

    expect(
      result.map((target) => [
        target.name,
        target.properties.map((item) => [item.name, item.source.property.value]),
      ]),
    ).toEqual([
      [
        'body',
        [
          ['scale', '1'],
          ['opacity', '0.5'],
          ['color', 'red'],
        ],
      ],
      ['badge', [['opacity', '0.2']]],
      ['label', [['opacity', '0.9']]],
    ])
  })

  describe.each(['value', 'expression'] as const)('%s timing precedence', (kind) => {
    it.each(timingCases(timingScopes))(
      'selects the highest provider among $label',
      ({ enabled }) => {
        const selection = scopedSelection(enabled, kind)
        const mapTiming = vi.fn<(source: TimingSource) => TimingSource>(identity)

        const [target] = resolveLayerCascade([selection], identity<PropertySource>, mapTiming)
        const timing = target.properties[0].timing
        const winner = enabled.indexOf(true)

        const expected = expectedTimingSource(selection, winner)

        expect(timing).toEqual(expected)
        expect(mapTiming).toHaveBeenCalledTimes(winner < 0 ? 0 : 1)
      },
    )
  })

  it.each([false, true])(
    'inherits timing independently of the value owner (upper override=%s)',
    (override) => {
      const base = { ...layer('base', [property('opacity', '1')]), timing: tween }
      const upper = {
        ...layer('upper', [property('opacity', '0.5')]),
        ...(override ? { timingExpression: dynamic } : {}),
      }

      const [target] = resolveSources([{ layer: base }, { layer: upper }])

      expect(target.properties[0].source.layer).toBe(upper)
      expect(target.properties[0].timing?.layer).toBe(override ? upper : base)
    },
  )

  it('does not inherit timing across properties or from a layer without the property', () => {
    const base = layer('base', [
      { ...property('opacity', '1'), timing: tween },
      property('scale', '1'),
    ])
    const unrelated: Layer = { name: 'unrelated', timingExpression: dynamic, targets: [] }

    const [target] = resolveSources([{ layer: base }, { layer: unrelated }])

    expect(target.properties.map((item) => item.timing?.layer.name)).toEqual(['base', undefined])
  })

  it('applies state-wide timing to a common property even without a state target', () => {
    const common = layer('base', [{ ...property('opacity', '1'), timing: tween }])
    const state: State = { name: 'active', timingExpression: dynamic, targets: [] }

    const [target] = resolveSources([{ layer: common, state }])

    expect(target.properties[0].source.state).toBeUndefined()
    expect(target.properties[0].timing?.declaration).toBe(state)
  })

  it('applies state-target timing to a common property absent from the state target', () => {
    const common = layer('base', [{ ...property('opacity', '1'), timing: tween }])
    const state: State = {
      name: 'active',
      targets: [
        {
          name: 'body',
          timingExpression: dynamic,
          properties: [property('scale', '2')],
        },
      ],
    }

    const [target] = resolveSources([{ layer: common, state }])

    expect(target.properties[0].source.state).toBeUndefined()
    expect(target.properties[0].timing?.declaration).toBe(state.targets[0])
  })

  it.each(['target', 'layer'] as const)(
    'inherits common %s timing for a state-only property',
    (scope) => {
      const common: Layer = {
        name: 'base',
        timing: tween,
        targets: [
          {
            name: 'body',
            ...(scope === 'target' ? { timingExpression: dynamic } : {}),
            properties: [property('scale', '1')],
          },
        ],
      }
      const state: State = {
        name: 'active',
        targets: [{ name: 'body', properties: [property('opacity', '0.5')] }],
      }

      const [target] = resolveSources([{ layer: common, state }])
      const opacity = target.properties.find((item) => item.name === 'opacity')

      expect(opacity?.source.state).toBe(state)
      expect(opacity?.timing?.declaration).toBe(scope === 'target' ? common.targets[0] : common)
    },
  )

  it('leaves input declarations unchanged while accumulating overrides', () => {
    const first = scopedSelection([true, true, true, true, true, true], 'value')
    const second = { layer: layer('upper', [property('opacity', '0')]) }
    const selection = [first, second]
    const original = structuredClone(selection)

    resolveSources(selection)

    expect(selection).toEqual(original)
  })

  it('maps timing before the winning value of each layer, including later-obscured contributions', () => {
    const first = { ...layer('first', [property('opacity', '1')]), timing: tween }
    const state: State = {
      name: 'active',
      targets: [{ name: 'body', properties: [property('opacity', '0.8')] }],
    }
    const last = layer('last', [property('opacity', '0.5')])
    const events: string[] = []

    const [target] = resolveLayerCascade(
      [{ layer: first, state }, { layer: last }],
      (source) => {
        events.push(`value:${source.layer.name}:${source.property.value}`)
        return Number(source.property.value)
      },
      (source) => {
        events.push(`timing:${source.layer.name}`)
        return 'mapped timing'
      },
    )

    expect(events).toEqual(['timing:first', 'value:first:0.8', 'value:last:0.5'])
    expect(target.properties[0]).toMatchObject({ value: 0.5, timing: 'mapped timing' })
  })

  it.each(['timing', 'value'] as const)(
    'propagates %s mapping failure before visiting subsequent layers',
    (stage) => {
      const first = { ...layer('first', [property('opacity', '1')]), timing: tween }
      const failure = new Error('mapping failed')
      const visited: string[] = []

      function* selection() {
        yield { layer: first }
        visited.push('next layer')
        yield { layer: layer('last', []) }
      }

      expect(() =>
        resolveLayerCascade(
          selection(),
          () => {
            visited.push('value')
            throw failure
          },
          () => {
            visited.push('timing')
            if (stage === 'timing') throw failure
            return tween
          },
        ),
      ).toThrow(failure)
      expect(visited).toEqual(stage === 'timing' ? ['timing'] : ['timing', 'value'])
    },
  )
})

describe('timingProvider', () => {
  it.each([{ candidates: [] }, { candidates: [undefined, {}] }])(
    'returns no provider for absent timing (%j)',
    ({ candidates }) => {
      expect(timingProvider(...candidates)).toBeUndefined()
    },
  )

  it.each([
    [{ timing: tween }, { timingExpression: dynamic }],
    [{ timingExpression: dynamic }, { timing: tween }],
  ])('uses candidate priority regardless of timing representation (%j)', (first, second) => {
    expect(timingProvider<TimingDeclaration>(undefined, {}, first, second)).toBe(first)
  })
})

describe('transitionPropertySources', () => {
  describe.each(['value', 'expression'] as const)('%s timing precedence', (kind) => {
    it.each(timingCases(['property', 'target', 'shared']))(
      'selects the highest provider among $label',
      ({ enabled }) => {
        const declarations: TimingDeclaration[] = enabled.map((active) =>
          !active ? {} : kind === 'value' ? { timing: tween } : { timingExpression: dynamic },
        )
        const instruction = { name: 'opacity', ...declarations[0] }
        const target = { name: 'body', properties: [instruction], ...declarations[1] }
        const transition = { targets: [target], ...declarations[2] }

        const result = transitionPropertySources(transition, 'body', 'opacity')

        expect(result.property).toBe(instruction)
        expect(result.target).toBe(target)
        expect(result.timing).toBe([instruction, target, transition][enabled.indexOf(true)])
      },
    )
  })

  it('returns no sources without a transition', () => {
    expect(transitionPropertySources(undefined, 'body', 'opacity')).toEqual({
      target: undefined,
      property: undefined,
      timing: undefined,
    })
  })

  it('falls back to target timing when the requested property is absent', () => {
    const target = {
      name: 'body',
      timing: tween,
      properties: [{ name: 'scale', timingExpression: dynamic }],
    }

    const result = transitionPropertySources({ targets: [target] }, 'body', 'opacity')

    expect(result.property).toBeUndefined()
    expect(result.timing).toBe(target)
  })

  it('falls back to shared timing when the requested target is absent', () => {
    const transition = {
      timing: tween,
      targets: [{ name: 'badge', timingExpression: dynamic, properties: [] }],
    }

    const result = transitionPropertySources(transition, 'body', 'opacity')

    expect(result.target).toBeUndefined()
    expect(result.timing).toBe(transition)
  })
})
