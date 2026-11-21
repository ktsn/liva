import { describe, expect, it } from 'vite-plus/test'
import { evaluate as evaluateScoped, type VariableValues } from './expression.ts'
import { sampleSpring } from '../motion/spring.ts'
import { EvaluationFixture, builtinValues } from '../__test__/helpers/evaluation.ts'
import { easingCss, timingValue } from './timing-values.ts'
import { spring, steps } from './timing-builtins.ts'
import type { FunctionArguments } from './reactive-value.ts'
import type { Expression } from '../model/definition.ts'

const reference = (name: string): Expression => ({ kind: 'reference', path: [name] })
const number = (value: number): Expression => ({ kind: 'number', value })
const call = (functionName: string, args: Record<string, Expression> = {}): Expression => ({
  kind: 'call',
  function: functionName,
  arguments: Object.entries(args).map(([name, value]) => ({ name, value })),
})

function evaluate(expression: Expression, values: VariableValues) {
  return evaluateScoped(expression, builtinValues(values))
}

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
    const graph = new EvaluationFixture(
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
      () => new EvaluationFixture([{ name: 'quick', initializer: call('tween') }], {}),
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
    expect(() => evaluate(call('missing'), {})).toThrow(
      'Function call requires a let initializer context',
    )
  })

  it.each([
    ['tween', { duration: -1 }],
    ['tween', { duration: Infinity }],
    ['tween', { easing: 'ease' }],
    ['spring', { mass: 0 }],
    ['spring', { damping: -1 }],
    ['cubicBezier', { x1: 2, y1: 0, x2: 1, y2: 1 }],
  ])('rejects invalid %s values', (name, args) => {
    expect(() =>
      evaluate(
        call(
          name,
          Object.fromEntries(
            Object.entries(args).map(([key, value]) => [
              key,
              typeof value === 'number' ? number(value) : { kind: 'string', value },
            ]),
          ),
        ),
        {},
      ),
    ).toThrow(/Expected|must be/)
  })

  it('resolves Instant as an explicit timing and honors motion shadowing', () => {
    const immediate = evaluate(reference('instant'), {})

    expect(timingValue(immediate)).toEqual({ kind: 'tween', durationMs: 0, easing: 'linear' })
    expect(() => easingCss(immediate)).toThrow('Expected easing value')
    expect(evaluate(reference('instant'), { instant: 20 })).toBe(20)
  })

  it('keeps easing descriptions distinct from scalar CSS strings', () => {
    const value = evaluate(reference('easeIn'), {})

    expect(easingCss(value)).toBe('ease-in')
    expect(() => timingValue(value)).toThrow('Expected timing value')
    expect(() => evaluate(reference('missing'), {})).toThrow('Unknown variable reference: missing')
  })

  it('evaluates dynamic duration springs and preserves requested duration', () => {
    const graph = new EvaluationFixture(
      [
        {
          name: 'motion',
          initializer: call('spring', {
            duration: reference('duration'),
            bounce: reference('bounce'),
          }),
        },
      ],
      { duration: 400, bounce: 0.25 },
    )
    const before = timingValue(graph.evaluate({ duration: 400, bounce: 0.25 }).motion)
    const after = timingValue(graph.evaluate({ duration: 700, bounce: 0 }).motion)

    expect(before).toEqual({ kind: 'spring-duration', durationMs: 400, bounce: 0.25 })
    if (before.kind !== 'spring-duration' || after.kind !== 'spring-duration') {
      throw new Error('Expected duration springs')
    }

    expect(sampleSpring(before).durationMs).toBe(400)
    expect(sampleSpring(after).durationMs).toBe(700)
    expect(() => graph.evaluate({ duration: 0, bounce: 0 })).toThrow('duration')
  })

  it('defaults duration spring bounce to zero', () => {
    const value = evaluate(call('spring', { duration: number(400) }), {})

    expect(timingValue(value)).toEqual({ kind: 'spring-duration', durationMs: 400, bounce: 0 })
    expect(Object.isFrozen(value)).toBe(true)
  })

  it.each<FunctionArguments>([
    { duration: 0 },
    { duration: -1 },
    { duration: Infinity },
    { duration: NaN },
    { duration: 400, bounce: -0.1 },
    { duration: 400, bounce: 1 },
    { duration: 400, bounce: Infinity },
    { bounce: 0.25 },
    { duration: 400, damping: 20 },
  ])('rejects invalid duration spring arguments: %j', (args) => {
    expect(() => spring(args)).toThrow(/Spring|Expected/)
  })

  it.each([
    { kind: 'spring-duration', durationMs: '400', bounce: 0 },
    { kind: 'spring-duration', durationMs: 400, bounce: '0' },
    { kind: 'spring-duration', durationMs: Infinity, bounce: 0 },
    { kind: 'spring-duration', durationMs: 400, bounce: Infinity },
  ])('rejects malformed duration spring values: %j', (value) => {
    expect(() => timingValue(value)).toThrow(/Spring|Expected/)
  })

  it.each(['start', 'end', 'jump-start', 'jump-end', 'jump-none', 'jump-both'])(
    'serializes step position %s for the browser',
    (position) => {
      const value = evaluate(
        call('steps', { count: number(4), position: { kind: 'string', value: position } }),
        {},
      )

      expect(easingCss(value)).toBe(`steps(4, ${position})`)
    },
  )

  it('evaluates dynamic step count and position and validates subsequent updates', () => {
    const graph = new EvaluationFixture(
      [
        {
          name: 'curve',
          initializer: call('steps', {
            count: reference('count'),
            position: reference('position'),
          }),
        },
      ],
      { count: 4, position: 'jump-end' },
    )

    expect(easingCss(graph.evaluate({ count: 4, position: 'jump-end' }).curve)).toBe(
      'steps(4, jump-end)',
    )
    expect(easingCss(graph.evaluate({ count: 2, position: 'start' }).curve)).toBe('steps(2, start)')
    expect(() => graph.evaluate({ count: 1, position: 'jump-none' })).toThrow('at least 2')
  })

  it('defaults steps to end', () => {
    expect(easingCss(evaluate(call('steps', { count: number(3) }), {}))).toBe('steps(3, end)')
  })

  it.each([
    ['stepStart', 'step-start'],
    ['stepEnd', 'step-end'],
  ])('resolves the %s easing constant', (name, css) => {
    expect(easingCss(evaluate(reference(name), {}))).toBe(css)
  })

  it.each<FunctionArguments>([
    { count: 0 },
    { count: -1 },
    { count: 1.5 },
    { count: Infinity },
    { count: NaN },
    { count: '4' },
    { count: 4, position: 'middle' },
    { count: 4, position: 1 },
    { count: 1, position: 'jump-none' },
  ])('rejects invalid step easing arguments: %j', (args) => {
    expect(() => steps(args)).toThrow(/Step count|step position|Expected/)
  })
})
