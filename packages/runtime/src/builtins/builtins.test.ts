import { expect, it } from 'vite-plus/test'
import cardFixture from '../../../../fixtures/card.json'
import { decodeBundle } from '../definition.ts'
import { evaluate, evaluateScalar } from '../expression.ts'
import { createSources, sourceValues, targetValues } from '../sources.ts'
import { invokeSource } from './index.ts'

it('dispatches call IR to independently initialized built-in sources', () => {
  const definition = decodeBundle(JSON.stringify(cardFixture)).definitions[0]
  const first = createSources(definition.sources!, targetValues(definition))
  const second = createSources(definition.sources!, targetValues(definition))

  expect(first.get('movement')).not.toBe(second.get('movement'))
  expect(sourceValues(first)).toEqual({ movement: { active: false, offset: { x: 0, y: 0 } } })
  expect(() => invokeSource({ kind: 'call', function: 'missing', arguments: [] }, {})).toThrow(
    'Unknown function: missing',
  )
})

it('resolves scalar members without source-specific field names', () => {
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
  expect(() => invokeSource(definition.sources![0].initializer, {})).toThrow(
    'Unknown variable reference: body',
  )

  const source = invokeSource(
    {
      kind: 'call',
      function: 'drag',
      arguments: [{ name: 'target', value: { kind: 'reference', path: ['selected'] } }],
    },
    { selected: variables.body },
  )

  expect(source.value).toEqual({ active: false, offset: { x: 0, y: 0 } })
})
