import { expect, it } from 'vite-plus/test'
import cardFixture from '../../../../fixtures/card.json'
import { decodeBundle } from '../definition.ts'
import { evaluate, evaluateScalar } from '../expression.ts'
import { LetBindingGraph, targetValues } from '../let-bindings.ts'
import { isReactiveSubscription } from '../reactive-value.ts'
import { callBuiltin } from './index.ts'

it('dispatches call IR to independently initialized built-in subscriptions', () => {
  const definition = decodeBundle(JSON.stringify(cardFixture)).definitions[0]
  const firstVariables = targetValues(definition)
  const secondVariables = targetValues(definition)
  const first = new LetBindingGraph(definition.letBindings!, firstVariables)
  const second = new LetBindingGraph(definition.letBindings!, secondVariables)

  expect(first.evaluate(firstVariables).movement).not.toBe(
    second.evaluate(secondVariables).movement,
  )
  expect(first.evaluate(firstVariables).movement).toEqual({
    active: false,
    offset: { x: 0, y: 0 },
  })
  expect(() => callBuiltin('missing', {})).toThrow('Unknown function: missing')
})

it('resolves scalar members without built-in-specific field names', () => {
  const values = { custom: { nested: { value: 7 }, label: 'ready' } }

  expect(evaluate({ kind: 'reference', path: ['custom', 'nested', 'value'] }, values)).toBe(7)
  expect(evaluate({ kind: 'reference', path: ['custom', 'label'] }, values)).toBe('ready')
  expect(evaluate({ kind: 'reference', path: ['custom', 'nested'] }, values)).toBe(
    values.custom.nested,
  )
  expect(() => evaluateScalar({ kind: 'reference', path: ['custom', 'nested'] }, values)).toThrow(
    'scalar',
  )

  for (const path of [
    ['custom', 'missing'],
    ['custom', 'toString'],
  ]) {
    expect(() => evaluate({ kind: 'reference', path }, values)).toThrow(
      'Unknown variable reference',
    )
  }
})

it('evaluates target variables using the same environment as other argument values', () => {
  const definition = decodeBundle(JSON.stringify(cardFixture)).definitions[0]
  const variables = targetValues(definition)
  const reference = { kind: 'reference', path: ['body'] } as const

  expect(evaluate(reference, variables)).toBe(variables.body)
  expect(targetValues(definition).body).not.toBe(variables.body)
  expect(targetValues(definition, variables).body).toBe(variables.body)
  expect(() => new LetBindingGraph(definition.letBindings!, {})).toThrow(
    'Unknown variable reference: body',
  )

  const subscription = callBuiltin('drag', {
    target: evaluate({ kind: 'reference', path: ['selected'] }, { selected: variables.body }),
  })

  if (!isReactiveSubscription(subscription)) throw new Error('Expected a reactive subscription')

  expect(subscription.value).toEqual({ active: false, offset: { x: 0, y: 0 } })
})
