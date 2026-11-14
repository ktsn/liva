import { describe, expect, it } from 'vite-plus/test'
import cardFixture from '../../../../fixtures/card.json'
import toggleFixture from '../../../../fixtures/reactive-toggle.json'
import {
  decodeBundle,
  type Definition,
  type Expression,
  type MotionParameter,
} from '../model/definition.ts'
import { evaluate, renderProperty, renderValue } from '../evaluation/expression.ts'
import { resolveLayers } from '../composition/layers.ts'
import { parameterValues } from '../evaluation/let-bindings.ts'

const toggle = decodeBundle(JSON.stringify(toggleFixture)).definitions[0]
const card = decodeBundle(JSON.stringify(cardFixture)).definitions[0]

describe('reactive selection and CSS templates', () => {
  it('uses the last matching transition in declaration order', () => {
    const layer = toggle.layers[0]
    // The compiled toggle fixture declares its two states and guarded transitions.
    const definition: Definition = {
      ...toggle,
      layers: [
        {
          ...layer,
          states: [...layer.states!, { name: 'last', targets: [] }],
          transitions: [...layer.transitions!, { ...layer.transitions![0], to: 'last' }],
        },
      ],
    }

    expect(resolveLayers(definition, { checked: false }).composition.states.toggle).toBe('off')
    expect(resolveLayers(definition, { checked: true }).composition.states.toggle).toBe('last')
  })

  it('accepts boolean parameter updates without coercion', () => {
    const values = parameterValues(toggle.parameters!, {}, { checked: false })
    expect(resolveLayers(toggle, values).composition.states.toggle).toBe('off')
    const next = parameterValues(toggle.parameters!, values, { checked: true })
    expect(resolveLayers(toggle, next).composition.states.toggle).toBe('on')
    expect(values.checked).toBe(false)
    expect(() => parameterValues(toggle.parameters!, next, { checked: 'false' })).toThrow('boolean')
  })

  it('renders explicit CSS units and never appends units to expressions', () => {
    const values = { movement: { active: true, offset: { x: 32, y: -14 } } }
    // The card fixture declares a dragging state with an interpolated translate value.
    const property = card.layers[0].states![1].targets[0].properties[0]
    expect(renderProperty(property, values).value).toBe('32px -14px')

    if (property.value.kind !== 'template') throw new Error('Expected a CSS template')

    expect(renderValue({ kind: 'template', parts: [property.value.parts[0]] }, values)).toBe('32')
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

describe('typed motion parameters', () => {
  const parameters = [
    { name: 'progress', type: 'number' },
    { name: 'enabled', type: 'boolean' },
    { name: 'label', type: 'string' },
  ] as const

  it('accepts explicit zero, false and empty string and keeps drag values independent', () => {
    const movement = { active: true, offset: { x: 12, y: 4 } }
    const initial = parameterValues(
      parameters,
      { movement },
      { progress: 0, enabled: false, label: '' },
    )
    const next = parameterValues(parameters, initial, {
      progress: 24,
      enabled: true,
      label: 'Ready',
    })

    expect(initial).toEqual({ movement, progress: 0, enabled: false, label: '' })
    expect(next).toEqual({ movement, progress: 24, enabled: true, label: 'Ready' })

    for (const name of ['progress', 'enabled', 'label']) {
      expect(evaluate({ kind: 'reference', path: [name] }, next)).toBe(next[name])
    }
  })

  it('rejects unknown names, wrong types and non-finite numbers without changing values', () => {
    const values = parameterValues(parameters, {}, { progress: 2, enabled: true, label: 'Saved' })

    for (const inputs of [
      { missing: true },
      { progress: '2' },
      { enabled: 1 },
      { label: false },
      { progress: NaN },
      { progress: Infinity },
      { progress: undefined },
    ]) {
      expect(() =>
        parameterValues(parameters, values, {
          progress: 2,
          enabled: true,
          label: 'Saved',
          ...inputs,
        }),
      ).toThrow(/parameter/)
      expect(values).toEqual({ progress: 2, enabled: true, label: 'Saved' })
    }
  })

  it('requires every parameter on creation and on full snapshot updates', () => {
    const complete = { progress: 2, enabled: true, label: 'Saved' }
    const values = parameterValues(parameters, {}, complete)

    for (const parameter of parameters) {
      const inputs = Object.fromEntries(
        Object.entries(complete).filter(([name]) => name !== parameter.name),
      )

      for (const previous of [{}, values]) {
        expect(() => parameterValues(parameters, previous, inputs)).toThrow(
          `Missing motion parameter: ${parameter.name}`,
        )
      }
    }

    expect(values).toEqual(complete)
    expect(parameterValues([], {}, {})).toEqual({})
  })

  it('rejects invalid parameter types', () => {
    for (const fields of [
      { parameters: [{ name: 'checked', type: 'unknown' }] },
      { parameters: [{ name: 'checked' }] },
    ]) {
      expect(() =>
        decodeBundle(JSON.stringify({ schemaVersion: 2, definitions: [{ ...toggle, ...fields }] })),
      ).toThrow('schema')
    }
  })

  it.each(['', '日本語😀', 'a"b', 'a\\b', ' x '])(
    'preserves exact constrained parameter strings: %j',
    (value) => {
      const constrainedParameters: MotionParameter[] = [
        { name: 'choice', type: { kind: 'stringUnion', values: ['other', value, value] } },
      ]
      const previous = { retained: 7 }

      const values = parameterValues(constrainedParameters, previous, { choice: value })

      expect(values).toEqual({ retained: 7, choice: value })
      expect(previous).toEqual({ retained: 7 })
      expect(typeof values.choice).toBe('string')
    },
  )

  it.each(['middle', 'START', ' start ', 1, false, null, undefined])(
    'rejects invalid constrained parameter values without coercion: %j',
    (value) => {
      const constrainedParameters: MotionParameter[] = [
        { name: 'choice', type: { kind: 'stringUnion', values: ['start', 'end'] } },
      ]

      expect(() => parameterValues(constrainedParameters, {}, { choice: value })).toThrow(
        'Motion parameter choice requires "start" | "end"',
      )
    },
  )

  it('requires full constrained snapshots and leaves earlier values unchanged on failure', () => {
    const constrainedParameters: MotionParameter[] = [
      { name: 'position', type: { kind: 'stringUnion', values: ['start', 'end'] } },
      { name: 'axis', type: { kind: 'stringUnion', values: ['x'] } },
    ]

    const previous = parameterValues(constrainedParameters, {}, { position: 'end', axis: 'x' })

    for (const { inputs, message } of [
      { inputs: { position: 'start' }, message: 'Missing motion parameter: axis' },
      {
        inputs: { position: 'start', axis: 'x', other: true },
        message: 'Unknown motion parameter: other',
      },
      {
        inputs: { position: 'start', axis: 'y' },
        message: 'Motion parameter axis requires "x"',
      },
    ]) {
      expect(() => parameterValues(constrainedParameters, previous, inputs)).toThrow(message)
      expect(previous).toEqual({ position: 'end', axis: 'x' })
    }
  })
})
