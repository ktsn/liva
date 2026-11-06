import { describe, expect, it } from 'vite-plus/test'
import { evaluate } from './expression.ts'
import { sampleSpring } from './spring.ts'
import { LetBindingGraph } from './let-bindings.ts'
import { callTiming, easingConstant, easingCss, timingValue } from './timing-values.ts'
import type { Expression } from './definition.ts'

const reference = (name: string): Expression => ({ kind: 'reference', path: [name] })
const number = (value: number): Expression => ({ kind: 'number', value })
const call = (functionName: string, args: Record<string, Expression> = {}): Expression => ({
  kind: 'call',
  function: functionName,
  arguments: Object.entries(args).map(([name, value]) => ({ name, value })),
})

describe('typed timing values', () => {
  it('evaluates nested easing expressions without a subscription context', () => {
    const expression = call('tween', {
      duration: number(150),
      easing: call('cubicBezier', { x1: number(0.2), y1: number(0), x2: number(0), y2: number(1) }),
    })

    const value = evaluate(expression, {})

    expect(timingValue(value)).toEqual({
      kind: 'tween',
      durationMs: 150,
      easing: 'cubic-bezier(0.2, 0, 0, 1)',
    })
    expect(Object.isFrozen(value)).toBe(true)
  })

  it('replaces parameterized descriptions as whole immutable values', () => {
    const graph = new LetBindingGraph(
      [
        { name: 'curve', initializer: reference('easeOut') },
        {
          name: 'quick',
          initializer: call('tween', {
            duration: reference('duration'),
            easing: reference('curve'),
          }),
        },
      ],
      { duration: 150 },
    )
    const before = graph.evaluate({ duration: 150 })

    const after = graph.evaluate({ duration: 250 })

    expect(timingValue(before.quick)).toMatchObject({ durationMs: 150 })
    expect(timingValue(after.quick)).toEqual({ kind: 'tween', durationMs: 250, easing: 'ease-out' })
    expect(after.quick).not.toBe(before.quick)
  })

  it('uses omitted spring parameters to produce a consumable physical timing', () => {
    const value = evaluate(call('spring', { stiffness: number(400) }), {})
    const timing = timingValue(value)

    if (timing.kind !== 'spring-physics') throw new Error('Expected physical spring')

    const sampled = sampleSpring(timing)

    expect(sampled.durationMs).toBeGreaterThan(0)
    expect(sampled.easing).toContain('linear(')
    expect(Object.isFrozen(value)).toBe(true)
  })

  it('supports a tween with all arguments omitted', () => {
    const timing = timingValue(evaluate(call('tween'), {}))

    expect(timing.kind).toBe('tween')
    expect(
      () => new LetBindingGraph([{ name: 'quick', initializer: call('tween') }], {}),
    ).not.toThrow()
  })

  it.each([
    1,
    { kind: 'spring-physics', stiffness: 'bad', damping: 10, mass: 1 },
    { kind: 'spring-physics', stiffness: 100, damping: 'bad', mass: 1 },
    { kind: 'spring-physics', stiffness: 100, damping: 10, mass: 'bad' },
  ])('rejects a malformed timing description', (value) => {
    expect(() => timingValue(value)).toThrow('Expected timing value')
  })

  it('rejects unknown timing constructors', () => {
    expect(() => callTiming('missing', {})).toThrow('Unknown timing function: missing')
  })

  it.each([
    ['tween', { duration: -1 }],
    ['tween', { duration: Infinity }],
    ['tween', { easing: 'ease' }],
    ['spring', { mass: 0 }],
    ['spring', { damping: -1 }],
    ['cubicBezier', { x1: 2, y1: 0, x2: 1, y2: 1 }],
  ])('rejects invalid %s values', (name, args) => {
    expect(() => callTiming(name, args)).toThrow(/Expected|must be/)
  })

  it('keeps easing descriptions distinct from scalar CSS strings', () => {
    const value = evaluate(reference('easeIn'), {})

    expect(easingCss(value)).toBe('ease-in')
    expect(() => timingValue(value)).toThrow('Expected timing value')
    expect(easingConstant('missing')).toBeUndefined()
  })
})
