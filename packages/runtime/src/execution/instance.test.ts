import { assembleRuntime, type RuntimeAssembly } from '../__test__/helpers/assembly.ts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import type { Definition } from '../model/definition.ts'

const definition: Definition = {
  name: 'event',
  parameters: [{ name: 'ready', type: 'boolean' }],
  layers: [{ name: 'idle', targets: [] }],
  events: [{ name: 'dismiss', when: { kind: 'reference', path: ['ready'] } }],
}
const instances: RuntimeAssembly[] = []

function createInstance(ready: boolean, source = definition) {
  const instance = assembleRuntime(source, { ready })
  instances.push(instance)
  return instance
}

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ addEventListener() {}, removeEventListener() {} }))
})

afterEach(() => {
  for (const instance of instances) instance.runtime.dispose()
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
      instance.runtime.onEvent = (name) => emitted.push(name)

      const observed = values.map((ready) => {
        instance.runtime.updateParameters({ ready })
        return emitted.length
      })

      expect(observed).toEqual(counts)
      expect(emitted).toEqual(['dismiss', 'dismiss'])
      expect(instance.runtime.composition).toEqual({ layers: { idle: true }, states: {} })
    },
  )

  it('tracks sibling Motion instances independently', () => {
    const first = createInstance(false)
    const second = createInstance(false)
    const emitted: string[] = []
    first.runtime.onEvent = (name) => emitted.push('first:' + name)
    second.runtime.onEvent = (name) => emitted.push('second:' + name)

    first.runtime.updateParameters({ ready: true })
    second.runtime.updateParameters({ ready: true })
    first.runtime.updateParameters({ ready: true })
    second.runtime.updateParameters({ ready: true })

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
    instance.runtime.onEvent = (name) => emitted.push(name)

    instance.runtime.updateParameters({ ready: false })
    instance.runtime.updateParameters({ ready: false })
    instance.runtime.updateParameters({ ready: true })

    expect(emitted).toEqual(['reset', 'dismiss'])
    expect(instance.runtime.composition).toEqual({ layers: { idle: true }, states: {} })
  })
})

describe('event lifecycle', () => {
  it('does not emit after disposal', () => {
    const instance = createInstance(false)
    const emitted: string[] = []
    instance.runtime.onEvent = (name) => emitted.push(name)

    instance.runtime.dispose()
    instance.runtime.updateParameters({ ready: true })

    expect(emitted).toEqual([])
    expect(instance.runtime.onEvent).toBeUndefined()
  })

  it('initializes replacement definitions without emitting an already-true condition', () => {
    const instance = createInstance(true)
    const emitted: string[] = []
    instance.runtime.onEvent = (name) => emitted.push(name)
    const replacement: Definition = {
      ...definition,
      events: [{ name: 'replacement', when: { kind: 'reference', path: ['ready'] } }],
    }

    instance.runtime.replaceDefinition(replacement)
    instance.runtime.updateParameters({ ready: true })
    expect(emitted).toEqual([])

    instance.runtime.updateParameters({ ready: false })
    instance.runtime.updateParameters({ ready: true })
    expect(emitted).toEqual(['replacement'])
  })
})

describe('composition snapshots', () => {
  it('exposes the active ordinary layer composition', () => {
    const instance = createInstance(false)

    expect(instance.runtime.composition).toEqual({ layers: { idle: true }, states: {} })
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

    expect(instance.runtime.composition).toEqual({
      layers: { visible: false },
      states: { history: 'idle' },
    })

    instance.runtime.updateParameters({ ready: true })
    instance.runtime.updateParameters({ ready: false })

    expect(instance.runtime.composition).toEqual({
      layers: { visible: false },
      states: { history: 'done' },
    })
  })

  it('isolates returned snapshots and instances', () => {
    const first = createInstance(true, layered)
    const second = createInstance(false, layered)
    const snapshot = first.runtime.composition

    expect(snapshot).toBeDefined()

    Object.assign(snapshot.layers, { visible: false })
    Object.assign(snapshot.states, { history: 'idle' })

    expect(first.runtime.composition).toEqual({
      layers: { visible: true },
      states: { history: 'done' },
    })
    expect(second.runtime.composition).toEqual({
      layers: { visible: false },
      states: { history: 'idle' },
    })
  })
})
