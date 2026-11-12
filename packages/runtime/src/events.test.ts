import { describe, expect, it } from 'vite-plus/test'
import { createEventValue, isEventValue } from './events.ts'
import { resolveLayers } from './layers.ts'
import type { Definition } from './definition.ts'

const signal = { kind: 'reference', path: ['signal'] } as const
const yes = { kind: 'boolean', value: true } as const

function definition(): Definition {
  return {
    name: 'events',
    layers: ['first', 'second'].map((name) => ({
      name,
      targets: [],
      initialState: 'idle',
      states: [
        { name: 'idle', targets: [] },
        { name: 'open', targets: [] },
        { name: 'closed', targets: [] },
      ],
      transitions: [
        { from: 'idle', to: 'open', when: yes, event: signal, transition: { targets: [] } },
        { from: 'open', to: 'closed', when: yes, event: signal, transition: { targets: [] } },
      ],
    })),
  }
}

describe('typed event capabilities', () => {
  it('keeps event values distinct from ordinary records', () => {
    expect(isEventValue(createEventValue())).toBe(true)
    expect(isEventValue({})).toBe(false)
    expect(isEventValue(false)).toBe(false)
  })

  it('broadcasts one occurrence without chaining through newly entered states', () => {
    const event = createEventValue()
    const model = definition()

    const result = resolveLayers(model, { signal: event }, new Map(), true, event)

    expect([...result.states]).toEqual([
      ['first', 'open'],
      ['second', 'open'],
    ])
    expect(resolveLayers(model, { signal: event }, result.states).states).toEqual(result.states)
  })

  it('combines event and ordinary candidates in source order with last-match priority', () => {
    const event = createEventValue()
    const model = definition()
    const ordinary = { from: 'idle', to: 'closed', when: yes, transition: { targets: [] } }
    const layers = model.layers.map((layer) => ({
      ...layer,
      transitions: [...(layer.transitions ?? []), ordinary],
    }))

    const result = resolveLayers({ ...model, layers }, { signal: event }, new Map(), true, event)

    expect([...result.states.values()]).toEqual(['closed', 'closed'])
  })
})
