import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { LetBindingGraph } from './let-bindings.ts'
import * as functions from './builtins/index.ts'
import type { LetBinding } from './definition.ts'
import type { ReactiveCall, RuntimeValue } from './reactive-value.ts'

const bindings: LetBinding[] = [
  {
    name: 'counter',
    initializer: {
      kind: 'call',
      function: 'createCounter',
      arguments: [{ name: 'input', value: { kind: 'reference', path: ['input'] } }],
    },
  },
  { name: 'alias', initializer: { kind: 'reference', path: ['counter'] } },
]

function installCounter() {
  const instances: ReactiveCall[] = []
  const commits: RuntimeValue[] = []
  const discarded: RuntimeValue[] = []
  const disposed: ReactiveCall[] = []
  const publishers: (() => void)[] = []

  const factory = vi.spyOn(functions, 'callBuiltin').mockImplementation((_name, args) => {
    let value: RuntimeValue = Object.freeze({ input: args.input })
    let publish: (() => void) | undefined
    const instance: ReactiveCall = {
      get value() {
        return value
      },
      prepareUpdate(next) {
        const snapshot = Object.freeze({ input: next.input })

        return {
          value: snapshot,
          commit() {
            value = snapshot
            commits.push(next.input)
            publish?.()
          },
          discard() {
            discarded.push(next.input)
          },
        }
      },
      bind(_targets, update) {
        publish = () => update(value)
        publishers.push(() => publish?.())

        return () => {
          publish = undefined
        }
      },
      dispose() {
        disposed.push(instance)
      },
    }

    instances.push(instance)

    return instance
  })

  return { instances, commits, discarded, disposed, publishers, factory }
}

afterEach(() => vi.restoreAllMocks())

describe('stable reactive calls', () => {
  it('updates one instance while aliases share the transaction snapshot', () => {
    const counter = installCounter()
    const graph = new LetBindingGraph(bindings, { input: 1 })

    const values = graph.evaluate({ input: 2 })

    expect(values.counter).toEqual({ input: 2 })
    expect(values.alias).toBe(values.counter)
    expect(counter.factory).toHaveBeenCalledTimes(1)
    expect(counter.commits).toEqual([2])
  })

  it('captures an on-demand call once at the notifying source timestamp', () => {
    const counter = installCounter()
    const graph = new LetBindingGraph([...bindings, { ...bindings[0], name: 'observer' }], {
      input: 1,
    })
    const observer = counter.instances[1]
    if (!observer) throw new Error('Expected a second call')
    const read = vi.fn<(context: { readonly time: number }) => RuntimeValue>(({ time }) =>
      Object.freeze({ input: time }),
    )
    observer.readSnapshot = read
    let observed: RuntimeValue | undefined
    graph.bind(new Map(), (notification) => {
      observed = graph.evaluate({ input: 1 }, undefined, notification).observer
    })
    vi.spyOn(performance, 'now').mockReturnValue(130)

    counter.publishers[0]?.()

    expect(observed).toEqual({ input: 130 })
    expect(read).toHaveBeenCalledExactlyOnceWith({ time: 130 })

    graph.dispose()
  })

  it('discards prepared updates when a later expression fails', () => {
    const counter = installCounter()
    const graph = new LetBindingGraph(
      [
        ...bindings,
        {
          name: 'ratio',
          initializer: {
            kind: 'binary',
            operator: '/',
            left: { kind: 'number', value: 1 },
            right: { kind: 'reference', path: ['divisor'] },
          },
        },
      ],
      { input: 1, divisor: 1 },
    )

    expect(() => graph.evaluate({ input: 2, divisor: 0 })).toThrow('finite')

    expect(counter.instances[0]?.value).toEqual({ input: 1 })
    expect(counter.commits).toEqual([])
    expect(counter.discarded).toEqual([2])
    expect(graph.evaluate({ input: 1, divisor: 1 }).alias).toEqual({ input: 1 })
  })

  it('discards updates when presentation validation fails', () => {
    const counter = installCounter()
    const graph = new LetBindingGraph(bindings, { input: 1 })

    expect(() =>
      graph.evaluate({ input: 2 }, () => {
        throw new Error('Invalid presentation')
      }),
    ).toThrow('Invalid presentation')

    expect(counter.instances[0]?.value).toEqual({ input: 1 })
    expect(counter.discarded).toEqual([2])
  })

  it('retains committed calls and subscriptions when a new subscription cannot bind', () => {
    const counter = installCounter()
    const disposedNewCall = vi.fn<() => void>()
    const bindingError = new Error('Binding failed')
    const graph = new LetBindingGraph(
      [
        ...bindings,
        {
          name: 'optional',
          initializer: {
            kind: 'binary',
            operator: '&&',
            left: { kind: 'reference', path: ['enabled'] },
            right: { kind: 'call', function: 'failing', arguments: [] },
          },
        },
      ],
      { input: 1, enabled: false },
    )
    counter.factory.mockReturnValue({
      value: true,
      bind() {
        throw bindingError
      },
      prepareUpdate() {
        throw new Error('No argument updates in this scenario')
      },
      dispose: disposedNewCall,
    })
    const notified = vi.fn<() => void>()
    graph.bind(new Map(), notified)

    expect(() => graph.evaluate({ input: 2, enabled: true })).toThrow(bindingError)

    expect(counter.instances[0]?.value).toEqual({ input: 1 })
    expect(counter.commits).toEqual([])
    expect(counter.discarded).toEqual([2])
    expect(counter.disposed).toEqual([])
    expect(disposedNewCall).toHaveBeenCalledTimes(1)

    counter.publishers[0]?.()

    expect(notified).toHaveBeenCalledTimes(1)
    expect(graph.evaluate({ input: 1, enabled: false }).alias).toEqual({ input: 1 })
    expect(counter.instances).toHaveLength(1)

    graph.dispose()
  })

  it('releases aborted creation and keeps separate call sites independent', () => {
    const counter = installCounter()

    expect(
      () =>
        new LetBindingGraph(
          [...bindings, { name: 'invalid', initializer: { kind: 'reference', path: ['missing'] } }],
          { input: 1 },
        ),
    ).toThrow('Unknown variable')

    expect(counter.disposed).toEqual(counter.instances)

    const graph = new LetBindingGraph([bindings[0], { ...bindings[0], name: 'second' }], {
      input: 1,
    })

    expect(counter.instances).toHaveLength(3)

    graph.dispose()
    graph.dispose()

    expect(counter.disposed).toHaveLength(3)
  })

  it('defers synchronous commit notifications until the entire graph commits', async () => {
    installCounter()
    const graph = new LetBindingGraph(bindings, { input: 1 })
    const snapshots: RuntimeValue[] = []
    graph.bind(new Map(), () => {
      snapshots.push(graph.evaluate({ input: 2 }).counter)
    })

    graph.evaluate({ input: 2 })

    expect(snapshots).toEqual([])

    await Promise.resolve()

    expect(snapshots).toEqual([{ input: 2 }])

    graph.dispose()
  })

  it('transfers only structurally compatible call sites during source replacement', () => {
    const counter = installCounter()
    const graph = new LetBindingGraph(bindings, { input: 1 })
    const replacement = new LetBindingGraph(bindings, { input: 1 }, graph)

    graph.dispose(replacement)

    expect(counter.factory).toHaveBeenCalledTimes(1)
    expect(counter.disposed).toEqual([])

    replacement.dispose()

    expect(counter.disposed).toEqual(counter.instances)
  })
  it('disposes a call when its conditional branch is removed', () => {
    const dispose = vi.fn<() => void>()
    const instance: ReactiveCall = {
      value: true,
      bind: () => () => {},
      prepareUpdate: () => {
        throw new Error('No arguments change in this scenario')
      },
      dispose,
    }
    vi.spyOn(functions, 'callBuiltin').mockReturnValue(instance)
    const graph = new LetBindingGraph(
      [
        {
          name: 'active',
          initializer: {
            kind: 'binary',
            operator: '&&',
            left: { kind: 'reference', path: ['enabled'] },
            right: { kind: 'call', function: 'createCounter', arguments: [] },
          },
        },
      ],
      { enabled: true },
    )

    graph.evaluate({ enabled: false })

    expect(dispose).toHaveBeenCalledTimes(1)

    graph.dispose()

    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('ignores scheduled notifications after teardown and rejects later evaluation', async () => {
    installCounter()
    const graph = new LetBindingGraph(bindings, { input: 1 })
    const notified = vi.fn<() => void>()
    graph.bind(new Map(), notified)

    graph.evaluate({ input: 2 })
    graph.dispose()

    await Promise.resolve()

    expect(notified).not.toHaveBeenCalled()
    expect(() => graph.evaluate({ input: 2 })).toThrow('disposed')
  })

  it('coalesces notifications from several committed updates without reentry', async () => {
    installCounter()
    const graph = new LetBindingGraph(bindings, { input: 1 })
    const notified = vi.fn<() => void>(() => {
      graph.evaluate({ input: 3 })
    })
    graph.bind(new Map(), notified)

    graph.evaluate({ input: 2 })
    graph.evaluate({ input: 3 })

    await Promise.resolve()

    expect(notified).toHaveBeenCalledTimes(1)
    expect(graph.evaluate({ input: 3 }).counter).toEqual({ input: 3 })

    graph.dispose()
  })

  it('rejects recursive evaluation from validation and retains committed state', () => {
    const counter = installCounter()
    const graph = new LetBindingGraph(bindings, { input: 1 })

    expect(() =>
      graph.evaluate({ input: 2 }, () => {
        graph.evaluate({ input: 3 })
      }),
    ).toThrow('reenter')

    expect(counter.instances[0]?.value).toEqual({ input: 1 })
    expect(counter.discarded).toEqual([2])

    graph.dispose()
  })

  it('defers notifications emitted during initial binding', async () => {
    vi.spyOn(functions, 'callBuiltin').mockImplementation(() => ({
      value: true,
      bind(_targets, update) {
        update(true)

        return () => {}
      },
    }))
    const graph = new LetBindingGraph(bindings, { input: 1 })
    const notified = vi.fn<() => void>()
    const [unbind] = graph.bind(new Map(), notified)

    expect(notified).not.toHaveBeenCalled()

    await Promise.resolve()

    expect(notified).toHaveBeenCalledTimes(1)

    unbind?.()
    graph.dispose()
  })
  it('ignores callbacks from bindings that have been replaced or removed', () => {
    const callbacks: (() => void)[] = []
    vi.spyOn(functions, 'callBuiltin').mockImplementation(() => ({
      value: true,
      bind(_targets, update) {
        callbacks.push(() => update(true))

        return () => {}
      },
    }))
    const graph = new LetBindingGraph(bindings, { input: 1 })
    const notified = vi.fn<() => void>()
    const first = graph.bind(new Map(), notified)
    const second = graph.bind(new Map(), notified)

    callbacks[0]?.()
    expect(notified).not.toHaveBeenCalled()

    callbacks[1]?.()
    expect(notified).toHaveBeenCalledTimes(1)

    for (const cleanup of [...first, ...second]) cleanup()

    callbacks[1]?.()
    expect(notified).toHaveBeenCalledTimes(1)

    graph.dispose()
  })
  it('does not dispose borrowed calls when a candidate changes an indirect argument', () => {
    const counter = installCounter()
    const definitions: LetBinding[] = [
      { name: 'selected', initializer: { kind: 'number', value: 1 } },
      {
        ...bindings[0],
        initializer: {
          kind: 'call',
          function: 'createCounter',
          arguments: [{ name: 'input', value: { kind: 'reference', path: ['selected'] } }],
        },
      },
    ]
    const live = new LetBindingGraph(definitions, {})
    const candidate = new LetBindingGraph(
      [{ name: 'selected', initializer: { kind: 'number', value: 2 } }, definitions[1]],
      {},
      live,
    )

    candidate.dispose(live)

    expect(counter.disposed).toEqual([counter.instances[1]])
    expect(live.evaluate({}).counter).toEqual({ input: 1 })

    live.dispose()

    expect(counter.disposed).toEqual([counter.instances[1], counter.instances[0]])
  })

  it('preserves borrowed calls when replacement construction fails', () => {
    const counter = installCounter()
    const definitions: LetBinding[] = [
      { name: 'selected', initializer: { kind: 'number', value: 1 } },
      {
        ...bindings[0],
        initializer: {
          kind: 'call',
          function: 'createCounter',
          arguments: [{ name: 'input', value: { kind: 'reference', path: ['selected'] } }],
        },
      },
    ]
    const live = new LetBindingGraph(definitions, {})

    expect(
      () =>
        new LetBindingGraph(
          [
            { name: 'selected', initializer: { kind: 'number', value: 2 } },
            definitions[1],
            { name: 'invalid', initializer: { kind: 'reference', path: ['missing'] } },
          ],
          {},
          live,
        ),
    ).toThrow('Unknown variable')

    expect(counter.commits).toEqual([])
    expect(counter.disposed).toEqual([counter.instances[1]])
    expect(live.evaluate({}).counter).toEqual({ input: 1 })

    live.dispose()

    expect(counter.disposed).toEqual([counter.instances[1], counter.instances[0]])
  })

  it('leaves borrowed subscriptions active when a candidate deactivates their branch', () => {
    const dispose = vi.fn<() => void>()
    const call: ReactiveCall = {
      value: true,
      bind: () => () => {},
      prepareUpdate: () => {
        throw new Error('No argument updates in this scenario')
      },
      dispose,
    }
    vi.spyOn(functions, 'callBuiltin').mockReturnValue(call)
    const definitions: LetBinding[] = [
      { name: 'enabled', initializer: { kind: 'boolean', value: true } },
      {
        name: 'selected',
        initializer: {
          kind: 'binary',
          operator: '&&',
          left: { kind: 'reference', path: ['enabled'] },
          right: { kind: 'call', function: 'createCounter', arguments: [] },
        },
      },
    ]
    const live = new LetBindingGraph(definitions, {})
    const candidate = new LetBindingGraph(
      [{ name: 'enabled', initializer: { kind: 'boolean', value: false } }, definitions[1]],
      {},
      live,
    )

    candidate.dispose(live)

    expect(dispose).not.toHaveBeenCalled()
    expect(live.evaluate({}).selected).toBe(true)

    live.dispose()

    expect(dispose).toHaveBeenCalledTimes(1)
  })
})
