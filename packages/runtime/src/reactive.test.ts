import { describe, expect, it } from 'vite-plus/test'
import cardFixture from '../../../fixtures/card.json'
import toggleFixture from '../../../fixtures/reactive-toggle.json'
import { decodeBundle, type Definition, type Expression } from './definition.ts'
import { evaluate, renderValue, selectState } from './expression.ts'
import { externalValues, initialSources } from './sources.ts'

const toggle = decodeBundle(JSON.stringify(toggleFixture)).definitions[0]
const card = decodeBundle(JSON.stringify(cardFixture)).definitions[0]

describe('reactive selection and CSS templates', () => {
  it('selects fallback and last matching state in declaration order', () => {
    const definition: Definition = {
      ...toggle,
      states: [...toggle.states, { ...toggle.states[1], name: 'last' }],
    }
    expect(selectState(definition, { checked: false })).toBe('off')
    expect(selectState(definition, { checked: true })).toBe('last')
  })

  it('accepts Boolean external updates without coercion', () => {
    const values = initialSources(toggle.sources!)
    expect(selectState(toggle, values)).toBe('off')
    const next = externalValues(toggle.sources!, values, { checked: true })
    expect(selectState(toggle, next)).toBe('on')
    expect(values.checked).toBe(false)
    expect(() => externalValues(toggle.sources!, next, { checked: 'false' })).toThrow('Boolean')
  })

  it('renders explicit CSS units and never appends units to expressions', () => {
    const values = { movement: { active: true, offset: { x: 32, y: -14 } } }
    const property = card.states[1].targets[0].properties[0]
    expect(renderValue(property, values)).toBe('32px -14px')
    expect(renderValue({ ...property, template: [property.template![0]] }, values)).toBe('32')
  })

  it('short circuits logical expressions and rejects non-finite arithmetic', () => {
    const quotient: Expression = {
      kind: 'binary',
      operator: '/',
      left: { kind: 'number', value: 1 },
      right: { kind: 'number', value: 0 },
    }
    expect(() => evaluate(quotient, {})).toThrow('finite')
    expect(
      evaluate(
        {
          kind: 'binary',
          operator: '&&',
          left: { kind: 'boolean', value: false },
          right: quotient,
        },
        {},
      ),
    ).toBe(false)
  })
})
