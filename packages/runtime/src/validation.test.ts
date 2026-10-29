import { describe, expect, it } from 'vite-plus/test'
import fixture from '../../../fixtures/toggle.json'
import { decodeBundle } from './definition.ts'
import { isDefinition } from './validation.ts'

const valid = fixture.definitions[0]

describe('serialized definition validation', () => {
  it('accepts compiler output and freezes the decoded definitions', () => {
    expect(isDefinition(valid)).toBe(true)

    const bundle = decodeBundle(JSON.stringify(fixture))
    expect(bundle.definitions).toEqual(fixture.definitions)
    expect(Object.isFrozen(bundle.definitions[0].states)).toBe(true)
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
    {
      ...valid,
      generalTransition: {
        timing: { kind: 'tween', durationMs: '100ms', easing: 'linear' },
        targets: [],
      },
    },
    {
      ...valid,
      generalTransition: {
        targets: [{ name: 'thumb', properties: [{ name: 'scale', keyframes: [{ offset: 0.5 }] }] }],
      },
    },
    { ...valid, directionalTransitions: [{ from: 'off', to: 'on' }] },
  ])('rejects malformed nested definition data: %j', (definition) => {
    expect(isDefinition(definition)).toBe(false)
    expect(() =>
      decodeBundle(JSON.stringify({ schemaVersion: 1, definitions: [definition] })),
    ).toThrow('schema')
  })
})
