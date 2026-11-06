import { describe, expect, it } from 'vite-plus/test'
import fixture from '../../../fixtures/toggle.json'
import lifecycleFixture from '../../../fixtures/lifecycle.json'
import presenceFixture from '../../../fixtures/presence.json'
import { decodeBundle } from './definition.ts'
import { isDefinition } from './validation.ts'

const valid = fixture.definitions[0]

function expectInvalidDefinition(definition: unknown) {
  expect(isDefinition(definition)).toBe(false)
  expect(() =>
    decodeBundle(JSON.stringify({ schemaVersion: 1, definitions: [definition] })),
  ).toThrow('schema')
}

describe('serialized definition validation', () => {
  it.each([
    ['state transitions', fixture],
    ['state-specific lifecycle animations', lifecycleFixture],
    ['lifecycle animations and events', presenceFixture],
  ])('accepts and freezes compiler output for %s', (_name, serialized) => {
    expect(isDefinition(serialized.definitions[0])).toBe(true)

    const bundle = decodeBundle(JSON.stringify(serialized))
    expect(bundle.definitions).toEqual(serialized.definitions)
    expect(Object.isFrozen(bundle.definitions[0].states)).toBe(true)
  })

  it('decodes typed decorators and rejects malformed expression payloads', () => {
    const timingExpression = { kind: 'call', function: 'tween', arguments: [] }
    const frame = {
      offset: 1,
      value: '1',
      easingExpression: { kind: 'reference', path: ['easeOut'] },
    }
    const property = { name: 'opacity', value: '1', timingExpression, keyframes: [frame] }
    const definition = {
      ...valid,
      states: [{ name: 'idle', targets: [{ name: 'body', properties: [property] }] }],
      enter: { targets: [{ name: 'body', properties: [property] }] },
    }

    expect(
      decodeBundle(JSON.stringify({ schemaVersion: 1, definitions: [definition] })).definitions[0],
    ).toEqual(definition)

    for (const changed of [
      { ...property, timingExpression: {} },
      { ...property, keyframes: 'invalid' },
      { ...property, keyframes: [{ ...frame, easingExpression: {} }] },
    ]) {
      expectInvalidDefinition({
        ...definition,
        states: [{ name: 'idle', targets: [{ name: 'body', properties: [changed] }] }],
      })
      expectInvalidDefinition({
        ...definition,
        enter: { targets: [{ name: 'body', properties: [changed] }] },
      })
    }
  })

  it('freezes lifecycle keyframes and event expression trees', () => {
    const definition = decodeBundle(JSON.stringify(presenceFixture)).definitions[0]

    expect(Object.isFrozen(definition.enter?.targets[0].properties[0].keyframes)).toBe(true)
    expect(Object.isFrozen(definition.leave?.targets[0].properties[0])).toBe(true)
    expect(Object.isFrozen(definition.events)).toBe(true)
    expect(Object.isFrozen(definition.events?.[0].when)).toBe(true)
  })

  it.each([
    null,
    { ...valid, states: [{}] },
    {
      ...valid,
      states: [
        { name: 'off', targets: [{ name: 'thumb', properties: [{ name: 'scale', value: 1 }] }] },
      ],
    },
    { ...valid, directionalTransitions: [{ from: 'off', to: 'on' }] },
  ])('rejects malformed state and transition references: %j', expectInvalidDefinition)

  describe.each(['generalTransition', 'enter', 'leave'])('%s animation validation', (field) => {
    it.each(
      [
        null,
        { timing: { kind: 'tween', durationMs: '100ms', easing: 'linear' }, targets: [] },
        {
          targets: [
            { name: 'thumb', properties: [{ name: 'scale', keyframes: [{ offset: 0.5 }] }] },
          ],
        },
        {
          targets: [
            {
              name: 'thumb',
              properties: [{ name: 'scale', keyframes: [{ offset: '0', value: '1' }] }],
            },
          ],
        },
        { targets: [{ properties: [] }] },
        { targets: 'body' },
      ].map((animation) => ({ ...valid, [field]: animation })),
    )('rejects malformed animation data: %j', expectInvalidDefinition)
  })

  describe('event validation', () => {
    it.each(
      [
        null,
        {},
        [null],
        [{ name: 'dismiss' }],
        [{ name: 1, when: { kind: 'boolean', value: true } }],
        [{ name: 'dismiss', when: { kind: 'unknown' } }],
        [{ name: 'dismiss', when: { kind: 'reference', path: [] } }],
        [
          {
            name: 'dismiss',
            when: { kind: 'binary', operator: '&&', left: { kind: 'boolean', value: true } },
          },
        ],
      ].map((events) => ({ ...valid, events })),
    )('rejects malformed event data: %j', expectInvalidDefinition)
  })
})

it.each(['stateEnters', 'stateLeaves'])('validates %s entries and frame templates', (field) => {
  for (const value of [
    null,
    {},
    [null],
    [{ state: 1, transition: { targets: [] } }],
    [{ state: 'idle' }],
    [
      {
        state: 'idle',
        transition: {
          targets: [
            {
              name: 'body',
              properties: [
                { name: 'opacity', keyframes: [{ offset: 0, value: '0', template: [null] }] },
              ],
            },
          ],
        },
      },
    ],
  ]) {
    expectInvalidDefinition({ ...valid, [field]: value })
  }
  const definition = decodeBundle(JSON.stringify(lifecycleFixture)).definitions[0]
  expect(Object.isFrozen(definition.stateEnters?.[0].transition)).toBe(true)
  expect(
    Object.isFrozen(
      definition.stateEnters?.[0].transition.targets[0].properties[1].keyframes?.[0].template,
    ),
  ).toBe(true)
})

it('validates string expressions, unknown timing kinds and expression depth limits', () => {
  expect(
    isDefinition({
      ...valid,
      events: [{ name: 'label', when: { kind: 'string', value: 'ready' } }],
    }),
  ).toBe(true)

  expectInvalidDefinition({
    ...valid,
    generalTransition: { timing: { kind: 'unknown' }, targets: [] },
  })
  expectInvalidDefinition({ ...valid, generalTransition: { timing: null, targets: [] } })

  let expression: unknown = { kind: 'boolean', value: true }

  for (let depth = 0; depth < 258; depth++)
    expression = { kind: 'unary', operator: '!', operand: expression }

  expectInvalidDefinition({ ...valid, events: [{ name: 'deep', when: expression }] })
})
