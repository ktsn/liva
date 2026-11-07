import { resolveComposition, resolveLayerTracks } from '@liva/runtime'
import { describe, expect, it } from 'vite-plus/test'
import { compile } from '../compiler.ts'
import {
  trackProvenance,
  lifecycleProvenance,
  typedEasingText,
  typedTimingText,
} from './provenance.ts'
import type { Inspection } from './communication/protocol.ts'

function inspection(source: string): Inspection {
  const result = compile(source, true)

  expect(result.diagnostics).toEqual([])

  const bytes = Buffer.from(source)

  return {
    hash: 'source',
    definition: result.definitions[0],
    fields: Object.entries(result.mappings ?? {}).map(([path, field]) => ({
      path,
      kind: field.kind,
      range: field.range,
      value: bytes.subarray(field.range.start, field.range.end).toString().trim(),
    })),
  }
}

const layeredSource = `motion sample {
 @tween(duration: 200) layer base { body { opacity: 1 } }
 layer hover when false { body { opacity: 0.5 } }
 layer machine { body { scale: 1 }
  state idle initial {}
  @spring(duration: 300) state active { body { opacity: 0.8 } }
  @tween(duration: 100) transition idle -> active when false
  @tween(duration: 150) transition idle -> active when false
 }
}`
const from = { layers: { base: true, hover: false }, states: { machine: 'idle' } }
const to = { layers: { base: true, hover: true }, states: { machine: 'active' } }

describe('composition source provenance', () => {
  const timingScopes = [
    ['transitionProperty', 'transition/0/target/body/property/opacity'],
    ['transitionTarget', 'transition/0/target/body'],
    ['transition', 'transition/0'],
    ['stateProperty', 'state/active/target/body/property/opacity'],
    ['stateTarget', 'state/active/target/body'],
    ['state', 'state/active'],
    ['commonProperty', 'target/body/property/opacity'],
    ['commonTarget', 'target/body'],
    ['layer', ''],
  ] as const

  it.each([timingScopes[0], timingScopes[1], timingScopes[4], timingScopes[8]])(
    'uses the same %s timing source for playback and editing',
    (winningScope, expectedScope) => {
      const first = timingScopes.findIndex(([scope]) => scope === winningScope)
      const decorators = Object.fromEntries(
        timingScopes.map(([scope], index) => [
          scope,
          index >= first ? `@tween(duration: ${100 + index})` : '',
        ]),
      )
      const info = inspection(`motion sample {
        ${decorators.layer} layer machine {
          ${decorators.commonTarget} body { opacity: 1 ${decorators.commonProperty} }
          state idle initial {}
          ${decorators.state} state active {
            ${decorators.stateTarget} body { opacity: 0.5 ${decorators.stateProperty} }
          }
          ${decorators.transition} transition idle -> active when false {
            ${decorators.transitionTarget} body { ${decorators.transitionProperty} opacity {} }
          }
        }
      }`)
      const beforeSelection = { layers: {}, states: { machine: 'idle' } }
      const afterSelection = { layers: {}, states: { machine: 'active' } }
      const selected = { layer: 'machine', index: 0 }
      const before = resolveComposition(info.definition, {}, beforeSelection)
      const after = resolveComposition(info.definition, {}, afterSelection, beforeSelection, [
        selected,
      ])

      const tracks = resolveLayerTracks(
        before,
        after,
        {},
        () => '1',
        () => {},
      )
      const provenance = trackProvenance(
        info,
        beforeSelection,
        afterSelection,
        selected,
        'body',
        'opacity',
      )

      expect(tracks[0].timing).toEqual({ kind: 'tween', durationMs: 100 + first, easing: 'ease' })
      expect(provenance.timingSource?.path).toBe(
        `sample/layer/machine${expectedScope ? `/${expectedScope}` : ''}/timing`,
      )
    },
  )

  it('rejects an unknown state instead of choosing a misleading source destination', () => {
    const selection = { ...from, states: { machine: 'missing' } }

    expect(() =>
      trackProvenance(inspection(layeredSource), from, selection, undefined, 'body', 'opacity'),
    ).toThrow('Unknown current state in layer machine: missing')
  })

  it('resolves source locations without evaluating dynamic timing expressions', () => {
    const info = inspection(`motion sample(duration: number) {
      @tween(duration: duration) layer base { body { opacity: 1 } }
    }`)
    const composition = { layers: { base: true }, states: {} }

    const result = trackProvenance(info, composition, composition, undefined, 'body', 'opacity')

    expect(result.timingSource?.text).toBe('tween(duration: duration)')
  })

  it('has no source destinations when the property comes entirely from external CSS', () => {
    const info = inspection('motion empty { layer base {} }')
    const composition = { layers: { base: true }, states: {} }
    const result = trackProvenance(info, composition, composition, undefined, 'body', 'opacity')

    expect(result.owner).toBe('External CSS')
    expect(result.from).toBeUndefined()
    expect(result.to).toBeUndefined()
    expect(result.timingDestination).toBeUndefined()
    expect(result.frameDestination).toBeUndefined()
  })

  it('separates value providers, overridden declarations, and independent timing sources', () => {
    const result = trackProvenance(
      inspection(layeredSource),
      from,
      { ...from, layers: { base: true, hover: true } },
      undefined,
      'body',
      'opacity',
    )

    expect(result.from?.text).toBe('1')
    expect(result.to?.text).toBe('0.5')
    expect(result.timingSource?.path).toBe('sample/layer/base/timing')
    expect(result.timingDestination).toBe('sample/layer/hover/target/body/property/opacity')
    expect(result.overridden.map((item) => item.text)).toEqual(['1'])
  })

  it('uses the explicitly selected duplicate transition for local overrides', () => {
    const result = trackProvenance(
      inspection(layeredSource),
      from,
      to,
      { layer: 'machine', index: 1 },
      'body',
      'opacity',
    )

    expect(result.timingSource?.text).toBe('tween(duration: 150)')
    expect(result.timingDestination).toBe(
      'sample/layer/machine/transition/1/target/body/property/opacity',
    )
    expect(result.frameDestination).toBe(result.timingDestination)
    expect(result.to?.text).toBe('0.8')
  })

  it('does not choose a state style track when no transition is selected', () => {
    const result = trackProvenance(
      inspection(layeredSource),
      from,
      to,
      undefined,
      'body',
      'opacity',
    )

    expect(result.frameDestination).toBeUndefined()
    expect(result.framesUnavailable).toContain('Select an existing transition')
    expect(result.timingDestination).toContain('/state/active/')
  })

  it('explains when state-shared timing masks a common-property override', () => {
    const result = trackProvenance(inspection(layeredSource), from, to, undefined, 'body', 'scale')

    expect(result.sharedValue).toBe(true)
    expect(result.timingSource?.path).toBe('sample/layer/machine/state/active/timing')
    expect(result.timingDestination).toBeUndefined()
    expect(result.timingUnavailable).toContain('Destination-state timing overrides')
  })

  it('allows an explicit transition override for inherited common properties', () => {
    const result = trackProvenance(
      inspection(layeredSource),
      from,
      to,
      { layer: 'machine', index: 0 },
      'body',
      'scale',
    )

    expect(result.timingDestination).toBe(
      'sample/layer/machine/transition/0/target/body/property/scale',
    )
  })

  it('keeps external CSS uneditable', () => {
    const info = inspection(layeredSource)
    const external = trackProvenance(
      info,
      { ...from, layers: { base: false, hover: false } },
      from,
      undefined,
      'body',
      'opacity',
    )

    expect(external.from).toBeUndefined()
    expect(external.to?.text).toBe('1')
  })

  it('identifies values shared by both compositions', () => {
    const shared = trackProvenance(
      inspection(layeredSource),
      from,
      from,
      undefined,
      'body',
      'opacity',
    )

    expect(shared.sharedValue).toBe(true)
  })

  it('maps a style track destination to its original 100% expression', () => {
    const info = inspection(
      'motion sample(amount: number) { @tween() layer base { body { opacity { 0%: 0; 100%: ${amount} } } } }',
    )
    const selection = { layers: { base: true }, states: {} }
    const result = trackProvenance(info, selection, selection, undefined, 'body', 'opacity')

    expect(result.to?.path).toBe('sample/layer/base/target/body/property/opacity/frame/1/value')
    expect(result.to?.text).toBe('${amount}')
  })
})

describe('typed timing serialization', () => {
  it.each([
    ['ease-out', 'easeOut'],
    ['step-start', 'stepStart'],
    ['step-end', 'stepEnd'],
    ['steps(4, jump-none)', 'steps(count: 4, position: "jump-none")'],
    ['cubic-bezier(0.2, 0, 0.4, 1)', 'cubicBezier(x1: 0.2, y1: 0, x2: 0.4, y2: 1)'],
  ])('preserves supported easing %s as a typed expression', (css, expected) => {
    expect(typedEasingText(css)).toBe(expected)
  })

  it('serializes both spring signatures without legacy shorthand', () => {
    expect(typedTimingText({ kind: 'spring-duration', durationMs: 400, bounce: 0.25 })).toBe(
      'spring(duration: 400, bounce: 0.25)',
    )
    expect(typedTimingText({ kind: 'spring-physics', stiffness: 300, damping: 20, mass: 1 })).toBe(
      'spring(stiffness: 300, damping: 20, mass: 1)',
    )
  })

  it('rejects easing without a typed representation', () => {
    expect(() => typedEasingText('linear(0, 1)')).toThrow('no typed representation')
  })
})

describe('lifecycle source provenance', () => {
  it.each([
    ['@tween(duration: 100)', '', '', 'sample/enter/timing'],
    ['@tween(duration: 100)', '@tween(duration: 200)', '', 'sample/enter/target/body/timing'],
    [
      '@tween(duration: 100)',
      '@tween(duration: 200)',
      '@tween(duration: 300)',
      'sample/enter/target/body/property/opacity/timing',
    ],
  ])(
    'separates inherited timing from the lifecycle write destination: %s %s %s',
    (shared, target, property, origin) => {
      const info = inspection(
        `motion sample { layer base { body { opacity: 1 } } ${shared} enter { ${target} body { ${property} opacity { 0%: 0 } } } }`,
      )
      const result = lifecycleProvenance(
        info,
        'enter',
        { layers: { base: true }, states: {} },
        'body',
        'opacity',
      )

      expect(result.timingSource?.path).toBe(origin)
      expect(result.timingDestination).toBe('sample/enter/target/body/property/opacity')
      expect(result.from?.text).toBe('0')
      expect(result.to?.text).toBe('1')
    },
  )

  it.each(['enter', 'leave'] as const)('resolves the selected state baseline for %s', (phase) => {
    const info = inspection(
      'motion sample { layer machine { state idle initial { body { opacity: 0.2 } } state active { body { opacity: 0.8 } } } }',
    )
    const result = lifecycleProvenance(
      info,
      phase,
      { layers: {}, states: { machine: 'active' } },
      'body',
      'opacity',
    )

    expect(result.from?.text).toBe('0.8')
    expect(result.to?.path).toBe(
      'sample/layer/machine/state/active/target/body/property/opacity/value',
    )
    expect(result.toDeclarationPath).toBe(result.to?.path)
  })

  it('resolves implicit lifecycle endpoints to the baseline declaration', () => {
    const info = inspection('motion sample { layer base { body { opacity: 1 } } }')
    const result = lifecycleProvenance(
      info,
      'leave',
      { layers: { base: true }, states: {} },
      'body',
      'opacity',
    )

    expect(result.timingSource).toBeUndefined()
    expect(result.frameDestination).toBe('sample/leave/target/body/property/opacity')
    expect(result.from?.path).toBe('sample/layer/base/target/body/property/opacity/value')
    expect(result.to?.text).toBe('1')
  })
})
