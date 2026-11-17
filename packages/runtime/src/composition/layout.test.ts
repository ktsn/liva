import { describe, expect, it } from 'vite-plus/test'
import { resolveLayoutConfigurations } from './layout.ts'
import { layerTargets, resolveComposition, resolveLayers, resolveLayerTracks } from './layers.ts'
import { decodeBundle, type Definition, type Layer, type Timing } from '../model/definition.ts'
import type { LayoutAxes, LayoutDeclaration } from '../model/layout.ts'
import fixture from '../../../../fixtures/layout-config.json'

const full: LayoutAxes = { x: true, y: true, width: true, height: true }
const position: LayoutAxes = { x: true, y: true, width: false, height: false }
const none: LayoutAxes = { x: false, y: false, width: false, height: false }
const spring: Timing = { kind: 'spring-physics', stiffness: 300, damping: 25, mass: 1 }
const instant: Timing = { kind: 'tween', durationMs: 0, easing: 'linear' }
const declaration = (axes = full, timing?: Timing): LayoutDeclaration => ({
  kind: 'layout',
  name: '$layout',
  axes,
  timing,
})

const layer = (name: string, axes = full, timing?: Timing): Layer => ({
  name,
  targets: [{ name: 'self', properties: [declaration(axes, timing)] }],
})

const definition = (...layers: Layer[]): Definition => ({ name: 'item', layers })

function configuration(source: Definition, values = {}) {
  return resolveLayers(source, values).layout ?? []
}

describe('layout declaration cascade', () => {
  it('disables layout by default and retains an explicit none declaration', () => {
    expect(configuration(definition({ name: 'base', targets: [] }))).toEqual([])
    expect(configuration(definition(layer('base', none)))[0]).toMatchObject({ axes: none })
  })

  it('replaces the whole selection while inheriting timing independently', () => {
    const base = layer('base', full, spring)
    const override = layer('override', position)
    const source = definition(base, override)
    const [resolved] = configuration(source)

    expect(resolved.axes).toEqual(position)
    expect(resolved.timing).toEqual(spring)
    expect(resolved.source.layer).toBe('override')
    expect(resolved.timingSource).toMatchObject({
      layer: 'base',
      target: 'self',
      property: '$layout',
    })
    expect(resolved.declarations.map((entry) => entry.layer)).toEqual(['base', 'override'])
  })

  it('removes conditional overrides and restores the previous axes and timing', () => {
    const source = definition(layer('base', full, spring), {
      ...layer('disabled', none, instant),
      when: { kind: 'reference', path: ['active'] },
    })

    expect(configuration(source, { active: true })[0]).toMatchObject({
      axes: none,
      timing: instant,
    })
    expect(configuration(source, { active: false })[0]).toMatchObject({
      axes: full,
      timing: spring,
    })
  })

  it.each(['state property', 'state target', 'state', 'common property', 'common target', 'layer'])(
    'uses ordinary %s timing precedence',
    (scope) => {
      const timing: Timing = { kind: 'tween', durationMs: 71, easing: 'ease-in' }
      const common = declaration(full, scope === 'common property' ? timing : undefined)
      const local = declaration(position, scope === 'state property' ? timing : undefined)
      const source = definition({
        name: 'phase',
        timing: scope === 'layer' ? timing : undefined,
        targets: [
          {
            name: 'self',
            timing: scope === 'common target' ? timing : undefined,
            properties: [common],
          },
        ],
        initialState: 'on',
        states: [
          {
            name: 'on',
            timing: scope === 'state' ? timing : undefined,
            targets: [
              {
                name: 'self',
                timing: scope === 'state target' ? timing : undefined,
                properties: [local],
              },
            ],
          },
        ],
      })
      const [resolved] = configuration(source)

      expect(resolved.axes).toEqual(position)
      expect(resolved.timing).toEqual(timing)
      expect(resolved.timingSource?.state).toBe(scope.startsWith('state') ? 'on' : undefined)
    },
  )

  it('limits explicit self timing to its authored declarations', () => {
    const source = definition({
      name: 'base',
      timing: spring,
      targets: [
        {
          name: 'self',
          timing: instant,
          timingProperties: ['opacity'],
          properties: [declaration(), { name: 'opacity', value: { kind: 'literal', value: '1' } }],
        },
      ],
    })

    expect(configuration(source)[0].timing).toEqual(spring)
  })

  it('keeps named targets independent from the root', () => {
    const source = decodeBundle(JSON.stringify(fixture)).definitions[0]
    const resolved = configuration(source, { active: false, duration: 110, timing: instant })

    expect(resolved.find((entry) => entry.target === 'self')?.axes).toEqual(full)
    expect(resolved.find((entry) => entry.target === 'content')).toMatchObject({
      axes: { x: false, y: true, width: false, height: true },
      timing: spring,
    })
  })

  it.each(['none', 'rotate(20deg)'])(
    'carries explicit transform ownership for %s without suppressing the configuration',
    (value) => {
      const source = definition({
        ...layer('base'),
        targets: [
          {
            name: 'self',
            properties: [declaration(), { name: 'transform', value: { kind: 'literal', value } }],
          },
        ],
      })

      expect(configuration(source)[0]).toMatchObject({ axes: full, explicitTransform: true })
    },
  )

  it('does not treat independent dimensions or translate/scale as transform ownership', () => {
    const source = definition({
      ...layer('base'),
      targets: [
        {
          name: 'self',
          properties: [
            declaration(),
            ...['width', 'height', 'translate', 'scale'].map((name) => ({
              name,
              value: { kind: 'literal' as const, value: '1' },
            })),
          ],
        },
      ],
    })

    expect(configuration(source)[0].explicitTransform).toBe(false)
  })

  it('releases explicit transform ownership when its conditional declaration disappears', () => {
    const source = definition(layer('base'), {
      name: 'owner',
      when: { kind: 'reference', path: ['active'] },
      targets: [
        {
          name: 'self',
          properties: [{ name: 'transform', value: { kind: 'literal', value: 'none' } }],
        },
      ],
    })

    expect(configuration(source, { active: true })[0].explicitTransform).toBe(true)
    expect(configuration(source, { active: false })[0].explicitTransform).toBe(false)
  })

  it('resolves fresh timing for unchanged axes without advancing selection', () => {
    const source = definition({
      name: 'base',
      targets: [
        {
          name: 'self',
          properties: [
            {
              ...declaration(),
              timingExpression: {
                kind: 'call',
                function: 'tween',
                arguments: [{ name: 'duration', value: { kind: 'reference', path: ['duration'] } }],
              },
            },
          ],
        },
      ],
    })
    const composition = { layers: { base: true }, states: {} }
    const first = resolveLayoutConfigurations(source, { duration: 100 }, composition)[0]
    const second = resolveLayoutConfigurations(source, { duration: 250 }, composition)[0]

    expect(first.source.declaration).toBe(second.source.declaration)
    expect(first.axes).toBe(second.axes)
    expect(first.timing).toMatchObject({ durationMs: 100 })
    expect(second.timing).toMatchObject({ durationMs: 250 })
    expect(composition).toEqual({ layers: { base: true }, states: {} })
  })

  it.each([false, true])(
    'evaluates declaration timing once for an explicit composition (directional: %s)',
    (directional) => {
      const source = definition({
        ...layer('phase'),
        initialState: 'off',
        targets: [
          {
            name: 'self',
            properties: [
              { ...declaration(), timingExpression: { kind: 'reference', path: ['layoutTiming'] } },
            ],
          },
        ],
        states: [
          { name: 'off', targets: [] },
          { name: 'on', targets: [] },
        ],
        transitions: [
          {
            from: 'off',
            to: 'on',
            when: { kind: 'boolean', value: true },
            transition: { timing: instant, targets: [] },
          },
        ],
      })
      const from = { layers: {}, states: { phase: 'off' } }
      const to = { layers: {}, states: { phase: 'on' } }
      let timingReads = 0
      const values = {
        get layoutTiming() {
          timingReads++

          return spring
        },
      }

      const result = resolveComposition(
        source,
        values,
        to,
        from,
        directional ? [{ layer: 'phase', index: 0 }] : [],
      )

      expect(timingReads).toBe(1)
      expect(result.layout?.[0].timing).toEqual(directional ? instant : spring)
      expect(result.composition).toEqual(to)
    },
  )

  it('validates explicit transition identities before evaluating declarations', () => {
    const source = definition({
      ...layer('phase'),
      initialState: 'off',
      targets: [
        {
          name: 'self',
          properties: [
            { ...declaration(), timingExpression: { kind: 'reference', path: ['layoutTiming'] } },
          ],
        },
      ],
      states: [{ name: 'off', targets: [] }],
    })
    const composition = { layers: {}, states: { phase: 'off' } }
    let timingReads = 0
    const values = {
      get layoutTiming() {
        timingReads++

        return spring
      },
    }

    expect(() =>
      resolveComposition(source, values, composition, composition, [{ layer: 'phase', index: 0 }]),
    ).toThrow('Invalid composition transition')
    expect(timingReads).toBe(0)
  })

  it('applies directional timing for this transition and returns declaration timing for a later geometry transaction', () => {
    const source = definition({
      ...layer('phase', full, spring),
      initialState: 'off',
      states: [
        { name: 'off', targets: [] },
        { name: 'on', targets: [] },
      ],
      transitions: [
        {
          from: 'off',
          to: 'on',
          when: { kind: 'boolean', value: true },
          transition: { timing: instant, targets: [] },
        },
      ],
    })
    const from = { layers: {}, states: { phase: 'off' } }
    const to = { layers: {}, states: { phase: 'on' } }
    const update = resolveComposition(source, {}, to, from, [{ layer: 'phase', index: 0 }])
    const later = resolveLayoutConfigurations(source, {}, to)

    expect(update.layout?.[0].timing).toEqual(instant)
    expect(update.layout?.[0].timingSource).toMatchObject({
      layer: 'phase',
      transition: 0,
      target: undefined,
      property: undefined,
    })
    expect(later[0].timing).toEqual(spring)
    expect(later[0].timingSource?.transition).toBeUndefined()
  })

  it.each([
    { scope: 'property', property: spring, target: instant, expected: spring },
    { scope: 'target', property: undefined, target: instant, expected: instant },
    {
      scope: 'transition',
      property: undefined,
      target: undefined,
      expected: { kind: 'tween', durationMs: 20, easing: 'linear' },
    },
  ] as const)(
    'uses directional $scope timing before declaration timing',
    ({ scope, property, target, expected }) => {
      const source = definition({
        ...layer('phase', full, spring),
        initialState: 'off',
        states: [
          { name: 'off', targets: [] },
          { name: 'on', targets: [] },
        ],
        transitions: [
          {
            from: 'off',
            to: 'on',
            when: { kind: 'boolean', value: true },
            transition: {
              timing: { kind: 'tween', durationMs: 20, easing: 'linear' },
              targets: [
                {
                  name: 'self',
                  timing: target,
                  properties: [{ name: '$layout', timing: property }],
                },
              ],
            },
          },
        ],
      })
      const from = { layers: {}, states: { phase: 'off' } }
      const to = { layers: {}, states: { phase: 'on' } }
      const update = resolveComposition(source, {}, to, from, [{ layer: 'phase', index: 0 }])

      expect(update.layout?.[0].timing).toEqual(expected)
      expect(update.layout?.[0].timingSource).toMatchObject({
        layer: 'phase',
        transition: 0,
        target: scope === 'transition' ? undefined : 'self',
        property: scope === 'property' ? '$layout' : undefined,
      })
    },
  )

  it('ignores directional overrides from an obscured selection owner', () => {
    const source = definition(
      {
        ...layer('phase', full, spring),
        initialState: 'off',
        states: [
          { name: 'off', targets: [] },
          { name: 'on', targets: [] },
        ],
        transitions: [
          {
            from: 'off',
            to: 'on',
            when: { kind: 'boolean', value: true },
            transition: { timing: instant, targets: [] },
          },
        ],
      },
      layer('override', position, spring),
    )
    const from = { layers: { override: true }, states: { phase: 'off' } }
    const to = { layers: { override: true }, states: { phase: 'on' } }
    const update = resolveComposition(source, {}, to, from, [{ layer: 'phase', index: 0 }])

    expect(update.layout?.[0].timing).toEqual(spring)
    expect(update.layout?.[0].timingSource?.transition).toBeUndefined()
  })

  it('selects forward and reverse timing expressions independently for unchanged axes', () => {
    const source = definition({
      ...layer('phase', full, spring),
      initialState: 'off',
      states: [
        { name: 'off', targets: [] },
        { name: 'on', targets: [] },
      ],
      transitions: [
        {
          from: 'off',
          to: 'on',
          when: { kind: 'boolean', value: true },
          transition: { timing: instant, targets: [] },
        },
        {
          from: 'on',
          to: 'off',
          when: { kind: 'boolean', value: true },
          transition: {
            timingExpression: { kind: 'reference', path: ['reverseTiming'] },
            targets: [],
          },
        },
      ],
    })
    const off = { layers: {}, states: { phase: 'off' } }
    const on = { layers: {}, states: { phase: 'on' } }
    const reverseTiming = { kind: 'tween', durationMs: 80, easing: 'ease-in' }
    const forward = resolveComposition(source, { reverseTiming }, on, off, [
      { layer: 'phase', index: 0 },
    ])
    const reverse = resolveComposition(source, { reverseTiming }, off, on, [
      { layer: 'phase', index: 1 },
    ])

    expect(forward.layout?.[0].axes).toBe(reverse.layout?.[0].axes)
    expect(forward.layout?.[0].timing).toEqual(instant)
    expect(reverse.layout?.[0].timing).toEqual(reverseTiming)
    expect(reverse.layout?.[0].timingSource?.transition).toBe(1)
  })

  it('keeps layout out of CSS presentation, controller declarations and ordinary tracks', () => {
    const source = definition(layer('base', full, spring))
    const before = resolveLayers(source, {})
    const after = resolveLayers(source, {})

    expect(after.layout?.[0].axes).toEqual(full)
    expect(after.presentation.targets.flatMap((target) => target.properties)).toEqual([])
    expect(layerTargets(source).flatMap((target) => target.properties)).toEqual([])
    expect(
      resolveLayerTracks(
        before,
        after,
        {},
        () => {
          throw new Error('No CSS observation expected')
        },
        () => {},
      ),
    ).toEqual([])
  })
})
