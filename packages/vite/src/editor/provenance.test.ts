import { describe, expect, it } from 'vite-plus/test'
import { compile } from '../compiler.ts'
import { trackProvenance, typedEasingText, typedTimingText } from './provenance.ts'
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
 layer base @tween(duration: 200) { body { opacity: 1 } }
 layer hover when false { body { opacity: 0.5 } }
 layer machine { body { scale: 1 }
  state idle initial {}
  state active @spring(duration: 300) { body { opacity: 0.8 } }
  transition idle -> active @tween(duration: 100) when false
  transition idle -> active @tween(duration: 150) when false
 }
}`
const from = { layers: { base: true, hover: false }, states: { machine: 'idle' } }
const to = { layers: { base: true, hover: true }, states: { machine: 'active' } }

describe('composition source provenance', () => {
  it('has no source destinations when the property comes entirely from external CSS', () => {
    const info = inspection('motion empty { state idle {} }')
    const composition = { layers: {}, states: {} }
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
      'motion sample(amount: number) { layer base @tween() { body { opacity { 0%: 0; 100%: ${amount} } } } }',
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
