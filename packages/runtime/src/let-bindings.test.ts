import { createEventValue, type ReactiveNotification } from './events.ts'
import { afterEach, expect, it, vi } from 'vite-plus/test'
import { LetBindingGraph } from './let-bindings.ts'
import { propertyController } from './controllers.ts'
import * as functions from './builtins/index.ts'
import type { ReactiveCall, ReactiveSubscription, RuntimeValue } from './reactive-value.ts'
import type { LetBinding, Target, Property } from './definition.ts'

it('evaluates forward dependencies and keeps failed evaluations out of committed snapshots', () => {
  const definitions: LetBinding[] = [
    {
      name: 'result',
      initializer: {
        kind: 'binary',
        operator: '/',
        left: { kind: 'reference', path: ['doubled'] },
        right: { kind: 'reference', path: ['divisor'] },
      },
    },
    {
      name: 'doubled',
      initializer: {
        kind: 'binary',
        operator: '*',
        left: { kind: 'reference', path: ['progress'] },
        right: { kind: 'number', value: 2 },
      },
    },
    { name: 'label', initializer: { kind: 'string', value: 'ready' } },
    {
      name: 'enabled',
      initializer: { kind: 'unary', operator: '!', operand: { kind: 'boolean', value: false } },
    },
  ]
  const graph = new LetBindingGraph(definitions, { progress: 3, divisor: 2 })
  const values = graph.evaluate({ progress: 3, divisor: 2 })

  expect(values).toEqual({
    progress: 3,
    divisor: 2,
    doubled: 6,
    result: 3,
    label: 'ready',
    enabled: true,
  })
  expect(() => graph.evaluate({ ...values, progress: 4, divisor: 0 })).toThrow('finite')
  expect(values.result).toBe(3)
  expect(graph.evaluate({ ...values, progress: 5 }).result).toBe(5)
})

it('detects dependency cycles in externally supplied definitions', () => {
  const definitions: LetBinding[] = [
    { name: 'first', initializer: { kind: 'reference', path: ['second'] } },
    { name: 'second', initializer: { kind: 'reference', path: ['first'] } },
  ]

  expect(() => new LetBindingGraph(definitions, {})).toThrow('Cyclic let binding dependency')
})

it('retains call handles for matching arguments and resolves changed target aliases on replacement', () => {
  const definitions: LetBinding[] = [
    {
      name: 'movement',
      initializer: {
        kind: 'call',
        function: 'drag',
        arguments: [{ name: 'target', value: { kind: 'reference', path: ['selected'] } }],
      },
    },
    { name: 'selected', initializer: { kind: 'reference', path: ['body'] } },
    { name: 'alias', initializer: { kind: 'reference', path: ['movement'] } },
  ]
  const variables = { body: { name: 'body' }, other: { name: 'other' } }
  const graph = new LetBindingGraph(definitions, variables)
  const first = graph.evaluate(variables)
  const retained = new LetBindingGraph(definitions, variables, graph).evaluate(variables)
  const changed = new LetBindingGraph(
    [
      definitions[0],
      { name: 'selected', initializer: { kind: 'reference', path: ['other'] } },
      definitions[2],
    ],
    variables,
    graph,
  ).evaluate(variables)

  expect(first.alias).toBe(first.movement)
  expect(retained.selected).toBe(variables.body)
  expect(changed.selected).toBe(variables.other)
  expect(typeof first.movement).toBe('object')

  if (
    typeof first.movement !== 'object' ||
    typeof retained.movement !== 'object' ||
    typeof changed.movement !== 'object'
  )
    throw new Error('Expected drag records')

  expect(retained.movement.offset).toBe(first.movement.offset)
  expect(changed.movement.offset).not.toBe(first.movement.offset)
})

function controllerTargets(
  name = 'self',
  property = 'width',
  alias = 'movement',
): Target<Property>[] {
  return [
    {
      name,
      properties: [
        {
          name: property,
          value: { kind: 'binding', expression: { kind: 'reference', path: [alias] } },
        },
      ],
    },
  ]
}

const controllerDefinitions: LetBinding[] = [
  { name: 'alias', initializer: { kind: 'reference', path: ['middle'] } },
  { name: 'middle', initializer: { kind: 'reference', path: ['movement'] } },
  { name: 'unused', initializer: { kind: 'reference', path: ['movement'] } },
  {
    name: 'movement',
    initializer: {
      kind: 'call',
      function: 'link',
      arguments: [{ name: 'input', value: { kind: 'number', value: 0 } }],
    },
  },
]

it.each([
  ['target', controllerTargets('other')],
  ['property', controllerTargets('self', 'height')],
  ['removed binding', []],
])('replaces a controller when its %s changes through forward aliases', (_name, targets) => {
  const graph = new LetBindingGraph(
    controllerDefinitions,
    {},
    undefined,
    controllerTargets('self', 'width', 'alias'),
  )
  const initial = propertyController(graph.evaluate({}).movement)

  const replacement = new LetBindingGraph(controllerDefinitions, {}, graph, targets)
  graph.dispose(replacement)

  expect(propertyController(replacement.evaluate({}).movement)).not.toBe(initial)

  replacement.dispose()
})

it('replaces an unbound call when it acquires a receiving address', () => {
  const graph = new LetBindingGraph(controllerDefinitions, {})
  const initial = propertyController(graph.evaluate({}).movement)

  const replacement = new LetBindingGraph(controllerDefinitions, {}, graph, controllerTargets())
  graph.dispose(replacement)

  expect(propertyController(replacement.evaluate({}).movement)).not.toBe(initial)

  replacement.dispose()
})

it('retains a controller when aliases and duplicate bindings still select the same address', () => {
  const graph = new LetBindingGraph(
    controllerDefinitions,
    {},
    undefined,
    controllerTargets('self', 'width', 'alias'),
  )
  const initial = propertyController(graph.evaluate({}).movement)
  const targets = [...controllerTargets(), ...controllerTargets('self', 'width', 'middle')]

  const replacement = new LetBindingGraph(controllerDefinitions, {}, graph, targets)
  graph.dispose(replacement)

  expect(propertyController(replacement.evaluate({}).movement)).toBe(initial)

  replacement.dispose()
})

afterEach(() => vi.restoreAllMocks())

it('recomputes ordinary function results only when their argument values change', () => {
  const invoke = vi
    .spyOn(functions, 'callBuiltin')
    .mockImplementation((_name, args) => Number(args.value) * 2)
  const definitions: LetBinding[] = [
    {
      name: 'result',
      initializer: {
        kind: 'call',
        function: 'double',
        arguments: [
          {
            name: 'value',
            value: {
              kind: 'call',
              function: 'double',
              arguments: [{ name: 'value', value: { kind: 'reference', path: ['progress'] } }],
            },
          },
        ],
      },
    },
  ]
  const graph = new LetBindingGraph(definitions, { progress: 3 })

  expect(graph.evaluate({ progress: 3 }).result).toBe(12)
  expect(graph.evaluate({ progress: 3, unrelated: 9 }).result).toBe(12)
  expect(invoke).toHaveBeenCalledTimes(2)

  expect(graph.evaluate({ progress: 4 }).result).toBe(16)
  expect(invoke).toHaveBeenCalledTimes(4)
})

it('reads retained subscriptions and recomputes dependent ordinary calls', () => {
  let current = 3
  let notify: ((value: RuntimeValue) => void) | undefined
  const cleanup = vi.fn<() => void>()
  const bind = vi.fn<ReactiveSubscription['bind']>((_targets, update) => {
    notify = update
    return cleanup
  })
  const subscription: ReactiveSubscription = {
    get value() {
      return current
    },
    bind,
  }
  const invoke = vi
    .spyOn(functions, 'callBuiltin')
    .mockImplementation((name, args) =>
      name === 'observe' ? subscription : { value: Number(args.value) * 2 },
    )
  const graph = new LetBindingGraph(
    [
      {
        name: 'result',
        initializer: {
          kind: 'call',
          function: 'record',
          arguments: [
            {
              name: 'value',
              value: {
                kind: 'call',
                function: 'observe',
                arguments: [],
              },
            },
          ],
        },
      },
    ],
    {},
  )
  let values = graph.evaluate({})
  const cleanups = graph.bind(new Map(), () => {
    values = graph.evaluate({})
  })

  expect(values.result).toEqual({ value: 6 })
  expect(invoke).toHaveBeenCalledTimes(2)
  expect(bind).toHaveBeenCalledTimes(1)

  current = 5
  notify?.(current)
  expect(values.result).toEqual({ value: 10 })
  expect(invoke.mock.calls.map(([name]) => name)).toEqual(['observe', 'record', 'record'])
  expect(bind).toHaveBeenCalledTimes(1)

  for (const dispose of cleanups) dispose()
  expect(cleanup).toHaveBeenCalledTimes(1)
})

it('switches between ordinary values and subscriptions based on each returned result', () => {
  const cleanup = vi.fn<() => void>()
  const bind = vi.fn<ReactiveSubscription['bind']>(() => cleanup)
  const invoke = vi
    .spyOn(functions, 'callBuiltin')
    .mockImplementation((_name, args) => (args.enabled ? { value: 7, bind } : 2))
  const graph = new LetBindingGraph(
    [
      {
        name: 'result',
        initializer: {
          kind: 'call',
          function: 'choose',
          arguments: [{ name: 'enabled', value: { kind: 'reference', path: ['enabled'] } }],
        },
      },
    ],
    { enabled: false },
  )
  const cleanups = graph.bind(new Map(), () => {})

  expect(graph.evaluate({ enabled: false }).result).toBe(2)
  expect(bind).not.toHaveBeenCalled()
  expect(graph.evaluate({ enabled: true }).result).toBe(7)
  expect(bind).toHaveBeenCalledTimes(1)
  expect(graph.evaluate({ enabled: true }).result).toBe(7)
  expect(invoke).toHaveBeenCalledTimes(2)

  expect(graph.evaluate({ enabled: false }).result).toBe(2)
  expect(cleanup).toHaveBeenCalledTimes(1)

  for (const dispose of cleanups) dispose()
  expect(cleanup).toHaveBeenCalledTimes(1)
})

it('keeps subscription call sites distinct as logical branches become inactive', () => {
  let firstValue = false
  const firstCleanup = vi.fn<() => void>()
  const secondCleanup = vi.fn<() => void>()
  const firstBind = vi.fn<ReactiveSubscription['bind']>(() => firstCleanup)
  const secondBind = vi.fn<ReactiveSubscription['bind']>(() => secondCleanup)
  const invoke = vi.spyOn(functions, 'callBuiltin').mockImplementation((name) =>
    name === 'first'
      ? {
          get value() {
            return firstValue
          },
          bind: firstBind,
        }
      : { value: true, bind: secondBind },
  )
  const graph = new LetBindingGraph(
    [
      {
        name: 'result',
        initializer: {
          kind: 'binary',
          operator: '||',
          left: {
            kind: 'binary',
            operator: '&&',
            left: { kind: 'reference', path: ['enabled'] },
            right: { kind: 'call', function: 'first', arguments: [] },
          },
          right: { kind: 'call', function: 'second', arguments: [] },
        },
      },
    ],
    { enabled: true },
  )
  const cleanups = graph.bind(new Map(), () => {})

  firstValue = true
  expect(graph.evaluate({ enabled: true }).result).toBe(true)
  expect(secondCleanup).toHaveBeenCalledTimes(1)
  expect(firstCleanup).not.toHaveBeenCalled()

  expect(graph.evaluate({ enabled: false }).result).toBe(true)
  expect(firstCleanup).toHaveBeenCalledTimes(1)
  expect(invoke.mock.calls.map(([name]) => name)).toEqual(['first', 'second', 'second'])
  expect(secondBind).toHaveBeenCalledTimes(2)

  for (const dispose of cleanups) dispose()
  expect(secondCleanup).toHaveBeenCalledTimes(2)
})

it('does not commit ordinary call caches when a later initializer fails', () => {
  const invoke = vi.spyOn(functions, 'callBuiltin').mockImplementation((_name, args) => args.value)
  const graph = new LetBindingGraph(
    [
      {
        name: 'value',
        initializer: {
          kind: 'call',
          function: 'identity',
          arguments: [{ name: 'value', value: { kind: 'reference', path: ['input'] } }],
        },
      },
      {
        name: 'ratio',
        initializer: {
          kind: 'binary',
          operator: '/',
          left: { kind: 'reference', path: ['value'] },
          right: { kind: 'reference', path: ['divisor'] },
        },
      },
    ],
    { input: 2, divisor: 1 },
  )

  expect(() => graph.evaluate({ input: 3, divisor: 0 })).toThrow('finite')
  expect(graph.evaluate({ input: 2, divisor: 1 }).ratio).toBe(2)
  expect(invoke).toHaveBeenCalledTimes(2)
  expect(graph.evaluate({ input: 3, divisor: 1 }).ratio).toBe(3)
  expect(invoke).toHaveBeenCalledTimes(3)
})

it('rolls back newly bound subscriptions when a later subscription cannot bind', () => {
  const active = new Set<string>()

  vi.spyOn(functions, 'callBuiltin').mockImplementation((name) => ({
    value: true,
    bind() {
      if (name === 'failing') throw new Error('Binding failed')

      active.add(name)
      return () => active.delete(name)
    },
  }))

  const definitions: LetBinding[] = ['first', 'failing'].map((name) => ({
    name: `${name}Value`,
    initializer: {
      kind: 'binary',
      operator: '&&',
      left: { kind: 'reference', path: ['enabled'] },
      right: { kind: 'call', function: name, arguments: [] },
    },
  }))
  const graph = new LetBindingGraph(definitions, { enabled: false })
  const cleanups = graph.bind(new Map(), () => {})

  expect(() => graph.evaluate({ enabled: true })).toThrow('Binding failed')
  expect(active.size).toBe(0)
  expect(graph.evaluate({ enabled: false })).toMatchObject({
    firstValue: false,
    failingValue: false,
  })

  for (const cleanup of cleanups) cleanup()
})

it('keeps the current binding active when an older binding is disposed twice', () => {
  const graph = new LetBindingGraph([], {})
  const [oldCleanup] = graph.bind(new Map(), () => {})
  const [currentCleanup] = graph.bind(new Map(), () => {})

  oldCleanup()
  oldCleanup()

  expect(graph.evaluate({ value: 1 })).toEqual({ value: 1 })

  currentCleanup()
  currentCleanup()
})

it('resolves later declarations before invoking a shadowed function name', () => {
  const invoke = vi.spyOn(functions, 'callBuiltin')
  const definitions: LetBinding[] = [
    { name: 'value', initializer: { kind: 'call', function: 'drag', arguments: [] } },
    { name: 'drag', initializer: { kind: 'number', value: 1 } },
  ]

  expect(() => new LetBindingGraph(definitions, {})).toThrow('Value is not callable: drag')
  expect(invoke).not.toHaveBeenCalled()
})

function eventGraphWithCommitNotifications() {
  const event = createEventValue()
  let value: RuntimeValue = { event, offset: 0 }
  let publish: Parameters<ReactiveSubscription['bind']>[1] | undefined
  const source: ReactiveCall = {
    get value() {
      return value
    },
    bind(_targets, update) {
      publish = update

      return () => {
        publish = undefined
      }
    },
    prepareUpdate(args) {
      return {
        value: { event, offset: args.offset },
        discard() {},
        commit() {
          for (const offset of [1, 2]) {
            value = { event, offset }
            publish?.(value, { time: offset * 10, event, snapshots: new Map([[source, value]]) })
          }
        },
      }
    },
    dispose() {},
  }
  vi.spyOn(functions, 'callBuiltin').mockReturnValue(source)
  const graph = new LetBindingGraph(
    [
      {
        name: 'source',
        initializer: {
          kind: 'call',
          function: 'eventSource',
          arguments: [{ name: 'offset', value: { kind: 'reference', path: ['offset'] } }],
        },
      },
    ],
    { offset: 0 },
  )
  const notifications: ReactiveNotification[] = []
  const observe = (notification?: ReactiveNotification) => {
    if (notification) notifications.push(notification)
  }
  let cleanups = graph.bind(new Map(), observe)

  function unbind() {
    for (const cleanup of cleanups) cleanup()

    cleanups = []
  }

  return {
    graph,
    event,
    source,
    notifications,
    unbind,
    rebind() {
      unbind()
      cleanups = graph.bind(new Map(), observe)
    },
    publish(offset: number) {
      value = { event, offset }
      publish?.(value, { time: offset * 10, event, snapshots: new Map([[source, value]]) })
    },
    dispose() {
      unbind()
      graph.dispose()
    },
  }
}

function eventSnapshots(binding: ReturnType<typeof eventGraphWithCommitNotifications>) {
  return binding.notifications.map((notification) => notification.snapshots.get(binding.source))
}

it.each(['deliver', 'unbind'] as const)(
  'serializes distinct occurrences published during commit and suppresses obsolete delivery: %s',
  async (mode) => {
    const binding = eventGraphWithCommitNotifications()

    binding.graph.evaluate({ offset: 1 })

    expect(binding.notifications).toEqual([])

    if (mode === 'unbind') binding.unbind()

    await Promise.resolve()

    const offsets = mode === 'deliver' ? [1, 2] : []

    expect(eventSnapshots(binding)).toEqual(
      offsets.map((offset) => ({ event: binding.event, offset })),
    )

    binding.dispose()
  },
)

it.each(['deliver', 'rebind', 'dispose'] as const)(
  'keeps later occurrences behind commit-time events with binding lifecycle=%s',
  async (mode) => {
    const binding = eventGraphWithCommitNotifications()
    binding.graph.evaluate({ offset: 1 })

    if (mode === 'rebind') binding.rebind()
    if (mode === 'dispose') binding.dispose()

    binding.publish(3)

    await Promise.resolve()
    await Promise.resolve()

    const offsets = mode === 'deliver' ? [1, 2, 3] : mode === 'rebind' ? [3] : []

    expect(eventSnapshots(binding)).toEqual(
      offsets.map((offset) => ({ event: binding.event, offset })),
    )

    binding.dispose()
  },
)
