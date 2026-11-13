import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { LivaInstance } from './instance.ts'
import type { Definition } from '../model/definition.ts'

const definition: Definition = {
  name: 'event',
  parameters: [{ name: 'ready', type: 'boolean' }],
  layers: [{ name: 'idle', targets: [] }],
  events: [{ name: 'dismiss', when: { kind: 'reference', path: ['ready'] } }],
}
const instances: LivaInstance[] = []

function createInstance(ready: boolean, source = definition) {
  const instance = new LivaInstance(source, { ready })
  instances.push(instance)
  return instance
}

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ addEventListener() {}, removeEventListener() {} }))
})

afterEach(() => {
  for (const instance of instances) instance.dispose()
  instances.length = 0
  vi.unstubAllGlobals()
})

describe('conditional event edges', () => {
  it.each([
    { initial: false, values: [false, true, true, false, true], counts: [0, 1, 1, 1, 2] },
    { initial: true, values: [true, false, true, true, false, true], counts: [0, 0, 1, 1, 1, 2] },
  ])(
    'emits only rising edges when the initial condition is $initial',
    ({ initial, values, counts }) => {
      const instance = createInstance(initial)
      const emitted: string[] = []
      instance.onEvent = (name) => emitted.push(name)

      const observed = values.map((ready) => {
        instance.updateParameters({ ready })
        return emitted.length
      })

      expect(observed).toEqual(counts)
      expect(emitted).toEqual(['dismiss', 'dismiss'])
      expect(instance.composition).toEqual({ layers: { idle: true }, states: {} })
    },
  )

  it('tracks sibling Motion instances independently', () => {
    const first = createInstance(false)
    const second = createInstance(false)
    const emitted: string[] = []
    first.onEvent = (name) => emitted.push('first:' + name)
    second.onEvent = (name) => emitted.push('second:' + name)

    first.updateParameters({ ready: true })
    second.updateParameters({ ready: true })
    first.updateParameters({ ready: true })
    second.updateParameters({ ready: true })

    expect(emitted).toEqual(['first:dismiss', 'second:dismiss'])
  })

  it('tracks multiple conditions independently without changing visual state', () => {
    const instance = createInstance(true, {
      ...definition,
      events: [
        ...definition.events!,
        {
          name: 'reset',
          when: { kind: 'unary', operator: '!', operand: { kind: 'reference', path: ['ready'] } },
        },
      ],
    })
    const emitted: string[] = []
    instance.onEvent = (name) => emitted.push(name)

    instance.updateParameters({ ready: false })
    instance.updateParameters({ ready: false })
    instance.updateParameters({ ready: true })

    expect(emitted).toEqual(['reset', 'dismiss'])
    expect(instance.composition).toEqual({ layers: { idle: true }, states: {} })
  })
})

describe('event lifecycle', () => {
  it('does not emit after disposal', () => {
    const instance = createInstance(false)
    const emitted: string[] = []
    instance.onEvent = (name) => emitted.push(name)

    instance.dispose()
    instance.updateParameters({ ready: true })

    expect(emitted).toEqual([])
    expect(instance.onEvent).toBeUndefined()
  })

  it('initializes replacement definitions without emitting an already-true condition', () => {
    const instance = createInstance(true)
    const emitted: string[] = []
    instance.onEvent = (name) => emitted.push(name)
    const replacement: Definition = {
      ...definition,
      events: [{ name: 'replacement', when: { kind: 'reference', path: ['ready'] } }],
    }

    instance.replaceDefinition(replacement)
    instance.updateParameters({ ready: true })
    expect(emitted).toEqual([])

    instance.updateParameters({ ready: false })
    instance.updateParameters({ ready: true })
    expect(emitted).toEqual(['replacement'])
  })
})

describe('composition snapshots', () => {
  it('exposes the active ordinary layer composition', () => {
    const instance = createInstance(false)

    expect(instance.composition).toEqual({ layers: { idle: true }, states: {} })
  })

  const layered: Definition = {
    ...definition,

    layers: [
      { name: 'visible', when: { kind: 'reference', path: ['ready'] }, targets: [] },
      {
        name: 'history',
        targets: [],
        initialState: 'idle',
        states: [
          { name: 'idle', targets: [] },
          { name: 'done', targets: [] },
        ],
        transitions: [
          {
            from: 'idle',
            to: 'done',
            when: { kind: 'reference', path: ['ready'] },
            transition: { targets: [] },
          },
        ],
      },
    ],
  }

  it('reads retained machine history and current ordinary layer activation', () => {
    const instance = createInstance(false, layered)

    expect(instance.composition).toEqual({
      layers: { visible: false },
      states: { history: 'idle' },
    })

    instance.updateParameters({ ready: true })
    instance.updateParameters({ ready: false })

    expect(instance.composition).toEqual({
      layers: { visible: false },
      states: { history: 'done' },
    })
  })

  it('isolates returned snapshots and instances', () => {
    const first = createInstance(true, layered)
    const second = createInstance(false, layered)
    const snapshot = first.composition

    expect(snapshot).toBeDefined()

    Object.assign(snapshot.layers, { visible: false })
    Object.assign(snapshot.states, { history: 'idle' })

    expect(first.composition).toEqual({ layers: { visible: true }, states: { history: 'done' } })
    expect(second.composition).toEqual({ layers: { visible: false }, states: { history: 'idle' } })
  })
})
