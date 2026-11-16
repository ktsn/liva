import { createEventValue } from './events.ts'
import { ReactiveCallStore } from './reactive-call-store.ts'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { EvaluationFixture } from '../__test__/helpers/evaluation.ts'
import * as functions from '../builtins/index.ts'
import type { LetBinding } from '../model/definition.ts'
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
  it.each([false, true])(
    'preserves rejection/cleanup causes, releases every new call, suppresses failed publications and permits reuse when second cleanup fails=%s',
    async (secondFails) => {
      const failure = new Error('Rejected candidate')
      const cleanup = new Error('Candidate cleanup failed')
      const secondCleanup = new Error('Second cleanup failed')
      const secondDispose = vi.fn<() => void>(() => {
        if (secondFails) throw secondCleanup
      })
      let publish: (() => void) | undefined
      const source: ReactiveCall = {
        value: 1,
        bind: () => () => {},
        prepareUpdate: () => ({ value: 1, commit() {}, discard() {} }),
        dispose() {},
      }
      const candidate: ReactiveCall = {
        ...source,
        value: 2,
        dispose() {
          publish?.()
          throw cleanup
        },
      }
      const factory = vi
        .spyOn(functions, 'callBuiltin')
        .mockImplementation((name) =>
          name === 'bad'
            ? candidate
            : name === 'second'
              ? { ...source, value: 3, dispose: secondDispose }
              : source,
        )
      const calls = new ReactiveCallStore()
      const update = vi.fn<() => void>()
      calls.evaluate((evaluation) => evaluation.invoke('live', 0, 'live', {}))
      calls.bind((_source, notify) => {
        publish = () => notify(1)
        return () => {
          publish = undefined
        }
      }, update)
      let caught: unknown

      try {
        calls.evaluate((evaluation) => {
          evaluation.invoke('bad', 0, 'bad', {})
          evaluation.invoke('second', 0, 'second', {})
          throw failure
        })
      } catch (error) {
        caught = error
      }

      await Promise.resolve()

      expect(caught).toEqual(
        new AggregateError(
          [
            failure,
            secondFails
              ? new AggregateError([cleanup, secondCleanup], 'Could not release resources', {
                  cause: cleanup,
                })
              : cleanup,
          ],
          'Could not discard failed call evaluation',
          {
            cause: failure,
          },
        ),
      )
      expect(secondDispose).toHaveBeenCalledTimes(1)
      expect(update).not.toHaveBeenCalled()
      expect(calls.evaluate((evaluation) => evaluation.invoke('live', 0, 'live', {}))).toBe(1)
      expect(factory).toHaveBeenCalledTimes(3)

      publish?.()
      expect(update).toHaveBeenCalledTimes(1)

      calls.dispose()
    },
  )

  it('retains already accepted ownership when retiring an obsolete call throws', () => {
    const cleanup = new Error('Retiring call failed')
    const dispose = vi.fn<() => void>()
    const source: ReactiveCall = {
      value: 2,
      bind: () => () => {},
      prepareUpdate: () => ({ value: 2, commit() {}, discard() {} }),
      dispose,
    }
    const factory = vi.spyOn(functions, 'callBuiltin').mockImplementation((name) =>
      name === 'old'
        ? {
            ...source,
            value: 1,
            dispose() {
              throw cleanup
            },
          }
        : source,
    )
    const calls = new ReactiveCallStore()
    calls.evaluate((evaluation) => evaluation.invoke('old', 0, 'old', {}))

    expect(() =>
      calls.evaluate((evaluation) => evaluation.invoke('current', 0, 'current', {})),
    ).toThrow(cleanup)
    expect(dispose).not.toHaveBeenCalled()
    expect(calls.evaluate((evaluation) => evaluation.invoke('current', 0, 'current', {}))).toBe(2)
    expect(factory).toHaveBeenCalledTimes(2)

    calls.dispose()
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it.each(['binding', 'store'] as const)(
    'invalidates queued notifications and releases all binding resources when %s cleanup fails',
    async (scope) => {
      const failure = new Error('First connection cleanup failed')
      const closed: number[] = []
      const disposed: number[] = []
      const factory = vi.spyOn(functions, 'callBuiltin').mockImplementation((_name, args) => ({
        value: args.index,
        bind: () => () => {},
        prepareUpdate: () => ({ value: args.index, commit() {}, discard() {} }),
        dispose() {
          disposed.push(Number(args.index))
        },
      }))
      const calls = new ReactiveCallStore()
      calls.evaluate((evaluation) =>
        [1, 2].map((index) => evaluation.invoke(String(index), 0, 'source', { index })),
      )
      const update = vi.fn<() => void>()
      const event = createEventValue()
      const cleanups = calls.bind((source, publish) => {
        publish(source.value, { time: 1, event, snapshots: new Map([[source, source.value]]) })

        return () => {
          closed.push(Number(source.value))
          if (source.value === 1) throw failure
        }
      }, update)

      expect(() => (scope === 'store' ? calls.dispose() : cleanups[0]())).toThrow(failure)

      await Promise.resolve()
      await Promise.resolve()

      expect(closed).toEqual([1, 2])
      expect(update).not.toHaveBeenCalled()
      expect(disposed).toEqual(scope === 'store' ? [1, 2] : [])

      calls.dispose()

      expect(disposed).toEqual([1, 2])
      expect(factory).toHaveBeenCalledTimes(2)
    },
  )

  it('releases every candidate-only call after a disposer fails while preserving borrowed live calls', () => {
    const failure = new Error('Candidate disposer failed')
    const disposed: number[] = []
    vi.spyOn(functions, 'callBuiltin').mockImplementation((_name, args) => ({
      value: args.index,
      bind: () => () => {},
      prepareUpdate: () => ({ value: args.index, commit() {}, discard() {} }),
      dispose() {
        disposed.push(Number(args.index))
        if (args.index === 2) throw failure
      },
    }))
    const live = new ReactiveCallStore()
    live.evaluate((evaluation) => evaluation.invoke('borrowed', 0, 'source', { index: 1 }))
    const candidate = new ReactiveCallStore(live, ['borrowed'])
    candidate.evaluate((evaluation) =>
      ['borrowed', 'candidate', 'other'].map((name, index) =>
        evaluation.invoke(name, 0, 'source', { index: index + 1 }),
      ),
    )

    expect(() => candidate.dispose(live)).toThrow(failure)
    expect(disposed).toEqual([2, 3])

    candidate.dispose(live)
    expect(disposed).toEqual([2, 3])

    live.dispose()
    expect(disposed).toEqual([2, 3, 1])
  })

  it('updates one instance while aliases share the transaction snapshot', () => {
    const counter = installCounter()
    const graph = new EvaluationFixture(bindings, { input: 1 })

    const values = graph.evaluate({ input: 2 })

    expect(values.counter).toEqual({ input: 2 })
    expect(values.alias).toBe(values.counter)
    expect(counter.factory).toHaveBeenCalledTimes(1)
    expect(counter.commits).toEqual([2])
  })

  it('captures an on-demand call once at the notifying source timestamp', () => {
    const counter = installCounter()
    const graph = new EvaluationFixture([...bindings, { ...bindings[0], name: 'observer' }], {
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
    const graph = new EvaluationFixture(
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
    const graph = new EvaluationFixture(bindings, { input: 1 })

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
    const graph = new EvaluationFixture(
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
        new EvaluationFixture(
          [...bindings, { name: 'invalid', initializer: { kind: 'reference', path: ['missing'] } }],
          { input: 1 },
        ),
    ).toThrow('Unknown variable')

    expect(counter.disposed).toEqual(counter.instances)

    const graph = new EvaluationFixture([bindings[0], { ...bindings[0], name: 'second' }], {
      input: 1,
    })

    expect(counter.instances).toHaveLength(3)

    graph.dispose()
    graph.dispose()

    expect(counter.disposed).toHaveLength(3)
  })

  it('defers synchronous commit notifications until the entire graph commits', async () => {
    installCounter()
    const graph = new EvaluationFixture(bindings, { input: 1 })
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
    const graph = new EvaluationFixture(bindings, { input: 1 })
    const replacement = new EvaluationFixture(bindings, { input: 1 }, graph)

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
    const graph = new EvaluationFixture(
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
    const graph = new EvaluationFixture(bindings, { input: 1 })
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
    const graph = new EvaluationFixture(bindings, { input: 1 })
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
    const graph = new EvaluationFixture(bindings, { input: 1 })

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
    const graph = new EvaluationFixture(bindings, { input: 1 })
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
    const graph = new EvaluationFixture(bindings, { input: 1 })
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
    const live = new EvaluationFixture(definitions, {})
    const candidate = new EvaluationFixture(
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
    const live = new EvaluationFixture(definitions, {})

    expect(
      () =>
        new EvaluationFixture(
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
    const live = new EvaluationFixture(definitions, {})
    const candidate = new EvaluationFixture(
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
