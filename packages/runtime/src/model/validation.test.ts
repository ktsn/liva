import { describe, expect, it } from 'vite-plus/test'
import fixture from '../../../../fixtures/toggle.json'
import lifecycleFixture from '../../../../fixtures/lifecycle.json'
import presenceFixture from '../../../../fixtures/presence.json'
import { decodeBundle, isCssProperty } from './definition.ts'
import { isDefinition } from './validation.ts'

const valid = fixture.definitions[0]

function expectInvalidDefinition(definition: unknown) {
  expect(isDefinition(definition)).toBe(false)
  expect(() =>
    decodeBundle(JSON.stringify({ schemaVersion: 3, definitions: [definition] })),
  ).toThrow('schema')
}

describe('serialized definition validation', () => {
  const reference = { kind: 'reference', path: ['distance'] }
  const endpoint = { offset: 1, value: { kind: 'literal', value: '1' } }

  const withPropertyValue = (value: unknown) => ({
    ...valid,
    layers: [{ name: 'base', targets: [{ name: 'self', properties: [{ name: 'scale', value }] }] }],
  })

  const withDeclaration = (declaration: unknown) => ({
    ...valid,
    layers: [{ name: 'base', targets: [{ name: 'self', properties: [declaration] }] }],
  })
  const layout = {
    kind: 'layout',
    name: '$layout',
    axes: { x: true, y: false, width: false, height: true },
  }

  it('decodes and freezes dedicated layout declarations with timing expressions', () => {
    const bundle = decodeBundle(
      JSON.stringify({
        schemaVersion: 3,
        definitions: [withDeclaration({ ...layout, timingExpression: reference })],
      }),
    )
    const declaration = bundle.definitions[0].layers[0].targets[0].properties[0]

    expect(declaration).toEqual({ ...layout, timingExpression: reference })
    expect(Object.isFrozen(declaration)).toBe(true)
    expect('axes' in declaration && Object.isFrozen(declaration.axes)).toBe(true)
  })

  it.each([
    null,
    [],
    { ...layout, kind: 'unknown' },
    { ...layout, name: 'transform' },
    { ...layout, axes: { x: true, y: false, width: false } },
    { ...layout, axes: { ...layout.axes, x: 'yes' } },
    { ...layout, axes: { ...layout.axes, anchor: 'center' } },
    { ...layout, value: { kind: 'literal', value: 'position' } },
    { ...layout, keyframes: [] },
    { ...layout, timingExpression: {} },
    { ...layout, timing: { kind: 'unknown' } },
    { name: '$layout', value: { kind: 'literal', value: 'position' } },
    { name: 'opacity', value: { kind: 'layout', axes: layout.axes } },
  ])('rejects malformed or overlapping layout/CSS variants: %j', (declaration) => {
    expect(isDefinition(withDeclaration(declaration))).toBe(false)
    expectInvalidDefinition(withDeclaration(declaration))
  })

  it.each(['enter', 'leave'])('rejects layout as an ordinary %s track', (phase) => {
    expect(
      isDefinition({
        ...withDeclaration(layout),
        [phase]: { targets: [{ name: 'self', properties: [{ name: '$layout' }] }] },
      }),
    ).toBe(false)
    expectInvalidDefinition({
      ...withDeclaration(layout),
      [phase]: {
        timing: { kind: 'tween', durationMs: 0, easing: 'linear' },
        targets: [{ name: 'self', properties: [{ name: '$layout' }] }],
      },
    })
  })

  it.each([
    { name: '$layout', keyframes: [] },
    { name: '$layout', keyframes: [endpoint] },
    { name: '$layout', axes: layout.axes },
    { name: '$layout', value: { kind: 'literal', value: 'position' } },
  ])('rejects selection payloads in directional layout timing overrides: %j', (instruction) => {
    const definition = {
      ...withDeclaration(layout),
      layers: [
        {
          name: 'phase',
          targets: [],
          states: [{ name: 'off', targets: [] }],
          initialState: 'off',
          transitions: [
            {
              from: 'off',
              to: 'off',
              when: { kind: 'boolean', value: true },
              transition: { targets: [{ name: 'self', properties: [instruction] }] },
            },
          ],
        },
      ],
    }

    expect(isDefinition(definition)).toBe(false)
    expectInvalidDefinition(definition)
  })

  it('rejects the preceding schema instead of interpreting layout as CSS', () => {
    expect(() =>
      decodeBundle(JSON.stringify({ schemaVersion: 2, definitions: [withDeclaration(layout)] })),
    ).toThrow('schema')
  })

  it.each([
    { kind: 'literal', value: '1' },
    { kind: 'template', parts: [reference, 'px'] },
    { kind: 'binding', expression: reference },
    {
      kind: 'keyframes',
      frames: [
        { offset: 0.5, value: { kind: 'template', parts: [reference] }, easing: 'linear' },
        endpoint,
      ],
    },
  ])('accepts and freezes the exclusive $kind declaration source', (value) => {
    const bundle = decodeBundle(
      JSON.stringify({ schemaVersion: 3, definitions: [withPropertyValue(value)] }),
    )
    const declaration = bundle.definitions[0].layers[0].targets[0].properties[0]

    if (!isCssProperty(declaration)) throw new Error('Expected a CSS property')

    const decoded = declaration.value

    expect(decoded).toEqual(value)
    expect(Object.isFrozen(decoded)).toBe(true)
  })

  it.each([
    '1',
    null,
    {},
    { kind: 'unknown' },
    { kind: 'literal' },
    { kind: 'literal', value: 1 },
    { kind: 'literal', value: '1', expression: reference },
    { kind: 'template', parts: 'invalid' },
    { kind: 'template', parts: [null] },
    { kind: 'template', parts: [reference], value: '${distance}' },
    { kind: 'binding', expression: {} },
    { kind: 'binding', expression: reference, frames: [endpoint] },
    { kind: 'keyframes', frames: [] },
    { kind: 'keyframes', frames: [null] },
    { kind: 'keyframes', frames: [{ ...endpoint, easing: 1 }] },
    { kind: 'keyframes', frames: [{ ...endpoint, offset: 0.5 }] },
    { kind: 'keyframes', frames: [endpoint], value: '1' },
    {
      kind: 'keyframes',
      frames: [{ ...endpoint, value: { kind: 'binding', expression: reference } }],
    },
    {
      kind: 'keyframes',
      frames: [{ ...endpoint, value: { kind: 'keyframes', frames: [endpoint] } }],
    },
    { kind: 'keyframes', frames: [{ ...endpoint, template: [reference] }] },
  ])('rejects malformed, overlapping or nested declaration sources: %j', (value) => {
    expect.assertions(2)
    expectInvalidDefinition(withPropertyValue(value))
  })

  it.each(['template', 'binding', 'keyframes'])(
    'rejects a legacy sibling %s field beside the source variant',
    (field) => {
      expect.assertions(2)

      const definition = withPropertyValue({ kind: 'literal', value: '1' })

      Object.assign(definition.layers[0].targets[0].properties[0], { [field]: [] })

      expectInvalidDefinition(definition)
    },
  )

  it.each([['x'], ['', '日本語😀', 'a"b', 'a\\b', ',)|{}'], ['y', 'x', 'y']])(
    'accepts exact nonempty string-set descriptors: %j',
    (...values) => {
      const parameter = { name: 'choice', type: { kind: 'stringUnion', values } }

      const decoded = decodeBundle(
        JSON.stringify({ schemaVersion: 3, definitions: [{ ...valid, parameters: [parameter] }] }),
      ).definitions[0]

      expect(decoded.parameters).toEqual([parameter])
      expect(Object.isFrozen(decoded.parameters?.[0].type)).toBe(true)
    },
  )

  it.each([
    null,
    {},
    { kind: 'unknown', values: ['x'] },
    { kind: 'stringUnion' },
    { kind: 'stringUnion', values: [] },
    { kind: 'stringUnion', values: 'x' },
    { kind: 'stringUnion', values: [1] },
    { kind: 'stringUnion', values: ['x'], extra: true },
  ])('rejects malformed string-set descriptors: %j', (type) => {
    expect.assertions(2)

    expectInvalidDefinition({ ...valid, parameters: [{ name: 'choice', type }] })
  })

  it('rejects the previous schema even if its definitions are otherwise valid', () => {
    expect(() => decodeBundle(JSON.stringify({ schemaVersion: 1, definitions: [valid] }))).toThrow(
      'schema',
    )
  })

  it('rejects malformed controller expressions and event selectors', () => {
    expect.assertions(4)
    expectInvalidDefinition({
      ...valid,
      layers: [
        {
          name: 'base',
          targets: [
            {
              name: 'self',
              properties: [
                {
                  name: 'width',
                  value: {
                    kind: 'binding',
                    expression: { kind: 'unknown' },
                  },
                },
              ],
            },
          ],
        },
      ],
    })
    const layer = valid.layers[0]
    expectInvalidDefinition({
      ...valid,
      layers: [
        {
          ...layer,
          transitions: layer.transitions.map((transition) => ({
            ...transition,
            event: { kind: 'unknown' },
          })),
        },
      ],
    })
  })

  it.each(['invalid', [1]])(
    'rejects malformed target timing property sets: %j',
    (timingProperties) => {
      const target = { name: 'self', timingProperties, properties: [] }

      expect(isDefinition({ ...valid, layers: [{ name: 'base', targets: [target] }] })).toBe(false)
      expect(isDefinition({ ...valid, enter: { targets: [target] } })).toBe(false)
    },
  )

  it.each([
    ['layer transitions', fixture],
    ['motion lifecycle animations', lifecycleFixture],
    ['lifecycle animations and events', presenceFixture],
  ])('accepts and freezes compiler output for %s', (_name, serialized) => {
    expect(isDefinition(serialized.definitions[0])).toBe(true)

    const bundle = decodeBundle(JSON.stringify(serialized))
    expect(bundle.definitions).toEqual(serialized.definitions)
    expect(Object.isFrozen(bundle.definitions[0].layers)).toBe(true)
  })

  it.each([
    { kind: 'spring-duration', durationMs: 300, bounce: 0.2 },
    { kind: 'spring-physics', stiffness: 300, damping: 20, mass: 1 },
  ])('accepts evaluated spring timing at a lifecycle property: $kind', (timing) => {
    const definition = {
      ...valid,
      enter: { targets: [{ name: 'thumb', properties: [{ name: 'scale', timing }] }] },
    }

    expect(
      decodeBundle(JSON.stringify({ schemaVersion: 3, definitions: [definition] })).definitions[0]
        .enter,
    ).toEqual(definition.enter)
  })

  it.each([
    { kind: 'spring-duration', durationMs: '300ms', bounce: 0.2 },
    { kind: 'spring-duration', durationMs: 300, bounce: '0.2' },
    { kind: 'spring-physics', stiffness: '300', damping: 20, mass: 1 },
    { kind: 'spring-physics', stiffness: 300, damping: '20', mass: 1 },
    { kind: 'spring-physics', stiffness: 300, damping: 20, mass: '1' },
  ])('rejects malformed evaluated spring parameters: %j', (timing) => {
    expect(
      isDefinition({
        ...valid,
        enter: { targets: [{ name: 'thumb', properties: [{ name: 'scale', timing }] }] },
      }),
    ).toBe(false)
  })

  it('decodes typed decorators and rejects malformed expression payloads', () => {
    const timingExpression = { kind: 'call', function: 'tween', arguments: [] }
    const frame = {
      offset: 1,
      value: { kind: 'literal', value: '1' },
      easingExpression: { kind: 'reference', path: ['easeOut'] },
    }
    const property = {
      name: 'opacity',
      value: { kind: 'keyframes', frames: [frame] },
      timingExpression,
    }
    const transitionProperty = { name: 'opacity', keyframes: [frame], timingExpression }
    const definition = {
      ...valid,
      layers: [{ name: 'idle', targets: [{ name: 'body', properties: [property] }] }],
      enter: { targets: [{ name: 'body', properties: [transitionProperty] }] },
    }

    expect(
      decodeBundle(JSON.stringify({ schemaVersion: 3, definitions: [definition] })).definitions[0],
    ).toEqual(definition)

    for (const [changed, changedTransition] of [
      [
        { ...property, timingExpression: {} },
        { ...transitionProperty, timingExpression: {} },
      ],
      [
        { ...property, value: { kind: 'keyframes', frames: 'invalid' } },
        { ...transitionProperty, keyframes: 'invalid' },
      ],
      [
        { ...property, value: { kind: 'keyframes', frames: [{ ...frame, easingExpression: {} }] } },
        { ...transitionProperty, keyframes: [{ ...frame, easingExpression: {} }] },
      ],
    ]) {
      expectInvalidDefinition({
        ...definition,
        layers: [{ name: 'idle', targets: [{ name: 'body', properties: [changed] }] }],
      })
      expectInvalidDefinition({
        ...definition,
        enter: { targets: [{ name: 'body', properties: [changedTransition] }] },
      })
    }
  })

  it.each(
    [
      { layers: [{ name: 'base', timingExpression: {}, targets: [] }] },
      {
        layers: [
          { name: 'base', targets: [{ name: 'body', timingExpression: {}, properties: [] }] },
        ],
      },
      { enter: { targets: [{ name: 'body', timingExpression: {}, properties: [] }] } },
      { enter: { timingExpression: {}, targets: [] } },
    ].map((patch) => ({ ...valid, ...patch })),
  )('rejects malformed shared timing expressions: %j', expectInvalidDefinition)

  it('freezes lifecycle keyframes and event expression trees', () => {
    const definition = decodeBundle(JSON.stringify(presenceFixture)).definitions[0]

    expect(Object.isFrozen(definition.enter?.targets[0].properties[0].keyframes)).toBe(true)
    expect(Object.isFrozen(definition.leave?.targets[0].properties[0])).toBe(true)
    expect(Object.isFrozen(definition.events)).toBe(true)
    expect(Object.isFrozen(definition.events?.[0].when)).toBe(true)
  })

  it.each([
    null,
    { ...valid, layers: [{}] },
    {
      ...valid,
      layers: [
        { name: 'off', targets: [{ name: 'thumb', properties: [{ name: 'scale', value: 1 }] }] },
      ],
    },
  ])('rejects malformed state and transition references: %j', expectInvalidDefinition)

  it.each([undefined, null, {}])('rejects missing or malformed layers: %j', (layers) => {
    expect(isDefinition({ ...valid, layers })).toBe(false)
  })

  describe.each(['enter', 'leave'])('%s animation validation', (field) => {
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

it('validates string expressions, unknown timing kinds and expression depth limits', () => {
  expect(
    isDefinition({
      ...valid,
      events: [{ name: 'label', when: { kind: 'string', value: 'ready' } }],
    }),
  ).toBe(true)

  expectInvalidDefinition({
    ...valid,
    enter: { timing: { kind: 'unknown' }, targets: [] },
  })
  expectInvalidDefinition({ ...valid, enter: { timing: null, targets: [] } })

  let expression: unknown = { kind: 'boolean', value: true }

  for (let depth = 0; depth < 258; depth++)
    expression = { kind: 'unary', operator: '!', operand: expression }

  expectInvalidDefinition({ ...valid, events: [{ name: 'deep', when: expression }] })
})
