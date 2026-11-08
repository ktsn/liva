import { ROOT_TARGET } from './targets.ts'
import type {
  Definition,
  Expression,
  MotionParameter,
  LetBinding,
  CallExpression,
} from './definition.ts'
import { callBuiltin } from './builtins/index.ts'
import {
  isReactiveSubscription,
  isReactiveCall,
  type PreparedUpdate,
  type ReactiveCall,
  type FunctionResult,
  type ReactiveSubscription,
  type RuntimeValue,
} from './reactive-value.ts'
import { evaluate, type VariableValues } from './expression.ts'

export function targetValues(
  definition: Definition,
  previous: VariableValues = {},
): VariableValues {
  const names = new Set([
    ROOT_TARGET,
    ...definition.layers
      .flatMap((layer) => [layer, ...(layer.states ?? [])])
      .flatMap((state) => state.targets.map((target) => target.name)),
  ])

  return Object.fromEntries(
    [...names].map((name) => {
      const retained = Object.hasOwn(previous, name) ? previous[name] : undefined
      const value =
        typeof retained === 'object' && retained.name === name ? retained : Object.freeze({ name })

      return [name, value]
    }),
  )
}

type CallSite = {
  readonly name: string
  readonly args: Readonly<Record<string, RuntimeValue>>
  readonly result: FunctionResult
}

type LetBindingNode = {
  readonly definition: LetBinding
  readonly callIds: ReadonlyMap<CallExpression, number>
  calls: Map<number, CallSite>
}

export class LetBindingGraph {
  private readonly nodes: LetBindingNode[] = []
  private initializing = true
  private evaluating = false
  private disposed = false
  private notificationPending = false
  private notificationQueued = false

  private notify = () => {
    if (!this.binding) return

    if (!this.evaluating) {
      this.binding.update()
      return
    }

    this.notificationPending = true
  }

  private flushNotifications() {
    if (!this.notificationPending) return

    this.notificationPending = false
    if (this.notificationQueued) return
    this.notificationQueued = true

    queueMicrotask(() => {
      this.notificationQueued = false
      this.notify()
    })
  }
  private binding?: {
    targets: ReadonlyMap<string, HTMLElement>
    update: () => void
    cleanups: Map<ReactiveSubscription, () => void>
  }

  constructor(
    letBindings: readonly LetBinding[],
    values: VariableValues,
    previous?: LetBindingGraph,
  ) {
    const pending = new Map(letBindings.map((binding) => [binding.name, binding]))
    const visiting = new Set<string>()

    const visit = (name: string) => {
      const definition = pending.get(name)
      if (!definition) return
      if (visiting.has(name)) throw new Error(`Cyclic let binding dependency: ${name}`)
      visiting.add(name)

      for (const dependency of dependencies(definition.initializer)) visit(dependency)

      visiting.delete(name)
      pending.delete(name)
      const retained = previous?.nodes.find(
        (node) =>
          node.definition.name === name &&
          JSON.stringify(node.definition.initializer) === JSON.stringify(definition.initializer),
      )
      this.nodes.push({
        definition,
        callIds: new Map(collectCalls(definition.initializer).map((call, index) => [call, index])),
        calls: new Map(retained?.calls),
      })
    }

    for (const binding of letBindings) visit(binding.name)

    this.evaluate(values)
    this.initializing = false
  }

  evaluate(
    variables: VariableValues,
    validate: (values: VariableValues) => void = () => {},
  ): VariableValues {
    if (this.disposed) throw new Error('Cannot evaluate a disposed let graph')
    if (this.evaluating) throw new Error('Cannot reenter a let evaluation')

    this.evaluating = true
    const values = { ...variables }
    const evaluatedCalls = new Map<LetBindingNode, Map<number, CallSite>>()
    const prepared: PreparedUpdate[] = []
    const created = new Set<ReactiveCall>()
    const snapshots = new Map<FunctionResult, RuntimeValue>()
    let committed = false

    try {
      for (const node of this.nodes) {
        const calls = new Map<number, CallSite>()

        const invoke = (call: CallExpression, scope: VariableValues): RuntimeValue => {
          const args = Object.fromEntries(
            call.arguments.map((argument) => [
              argument.name,
              evaluate(argument.value, scope, invoke),
            ]),
          )
          // Every initializer call is indexed by collectCalls, including inactive branches.
          const id = node.callIds.get(call)!
          const retained = node.calls.get(id)
          const sameFunction = retained?.name === call.function
          const matches =
            sameFunction &&
            Object.keys(args).length === Object.keys(retained.args).length &&
            Object.entries(args).every(([name, argument]) => retained.args[name] === argument)
          let site: CallSite

          if (matches) {
            site = retained
          } else if (sameFunction && !this.initializing && isReactiveCall(retained.result)) {
            const update = retained.result.prepareUpdate(args)
            prepared.push(update)
            snapshots.set(retained.result, update.value)
            site = { name: call.function, args, result: retained.result }
          } else {
            const result = callBuiltin(call.function, args)
            if (isReactiveCall(result)) created.add(result)
            site = { name: call.function, args, result }
          }

          calls.set(id, site)

          if (!isReactiveSubscription(site.result)) return site.result
          if (!snapshots.has(site.result)) snapshots.set(site.result, site.result.value)

          return snapshots.get(site.result)!
        }

        const value = evaluate(node.definition.initializer, values, invoke)
        evaluatedCalls.set(node, calls)
        Object.defineProperty(values, node.definition.name, {
          value,
          enumerable: true,
          writable: true,
          configurable: true,
        })
      }

      validate(values)
      this.updateSubscriptions([...evaluatedCalls.values()])

      for (const update of prepared) update.commit()

      const active = new Set(
        [...evaluatedCalls.values()].flatMap((calls) =>
          [...calls.values()].map((call) => call.result),
        ),
      )
      const removed = new Set(
        this.nodes.flatMap((node) => [...node.calls.values()].map((call) => call.result)),
      )

      for (const [node, calls] of evaluatedCalls) node.calls = calls
      committed = true

      for (const result of removed) {
        // Initial caches are borrowed from a live graph, not owned by this candidate.
        // Only dispose them when the caller accepts a replacement via old.dispose(new).
        if (!this.initializing && !active.has(result) && isReactiveCall(result)) result.dispose()
      }

      return values
    } finally {
      if (!committed) {
        for (const update of prepared) update.discard()
        for (const result of created) result.dispose()
        this.notificationPending = false
      }

      this.evaluating = false
      this.flushNotifications()
    }
  }

  /** Release call ownership, preserving compatible instances transferred to a replacement. */
  dispose(retained?: LetBindingGraph) {
    if (this.disposed) return

    this.disposed = true
    const keep = new Set(
      retained?.nodes.flatMap((node) => [...node.calls.values()].map((call) => call.result)),
    )
    const results = new Set(
      this.nodes.flatMap((node) => [...node.calls.values()].map((call) => call.result)),
    )

    for (const cleanup of this.binding?.cleanups.values() ?? []) cleanup()
    this.binding = undefined

    for (const result of results) {
      if (!keep.has(result) && isReactiveCall(result)) result.dispose()
    }
  }

  private updateSubscriptions(callMaps: readonly ReadonlyMap<number, CallSite>[]) {
    const binding = this.binding
    if (!binding) return

    const active = new Set(
      callMaps.flatMap((calls) =>
        [...calls.values()].map((call) => call.result).filter(isReactiveSubscription),
      ),
    )
    const added = new Map<ReactiveSubscription, () => void>()

    try {
      for (const subscription of active) {
        if (!binding.cleanups.has(subscription)) {
          let subscribed = true
          const cleanup = subscription.bind(binding.targets, () => {
            if (subscribed && this.binding === binding) this.notify()
          })
          added.set(subscription, () => {
            subscribed = false
            cleanup()
          })
        }
      }
    } catch (error) {
      for (const cleanup of added.values()) cleanup()
      throw error
    }

    for (const [subscription, cleanup] of binding.cleanups) {
      if (!active.has(subscription)) {
        cleanup()
        binding.cleanups.delete(subscription)
      }
    }

    for (const [subscription, cleanup] of added) binding.cleanups.set(subscription, cleanup)
  }

  bind(targets: ReadonlyMap<string, HTMLElement>, update: () => void): (() => void)[] {
    const binding = { targets, update, cleanups: new Map<ReactiveSubscription, () => void>() }
    this.binding = binding
    this.evaluating = true

    try {
      this.updateSubscriptions(this.nodes.map((node) => node.calls))
    } finally {
      this.evaluating = false
      this.flushNotifications()
    }

    return [
      () => {
        for (const cleanup of binding.cleanups.values()) cleanup()
        binding.cleanups.clear()
        if (this.binding === binding) this.binding = undefined
      },
    ]
  }
}

function collectCalls(expression: Expression): CallExpression[] {
  switch (expression.kind) {
    case 'call':
      return [
        expression,
        ...expression.arguments.flatMap((argument) => collectCalls(argument.value)),
      ]
    case 'unary':
      return collectCalls(expression.operand)
    case 'binary':
      return [...collectCalls(expression.left), ...collectCalls(expression.right)]
    default:
      return []
  }
}

function dependencies(expression: Expression): string[] {
  switch (expression.kind) {
    case 'reference':
      return [expression.path[0]]
    case 'unary':
      return dependencies(expression.operand)
    case 'binary':
      return [...dependencies(expression.left), ...dependencies(expression.right)]
    case 'call':
      return [
        expression.function,
        ...expression.arguments.flatMap((argument) => dependencies(argument.value)),
      ]
    default:
      return []
  }
}

export function parameterValues(
  parameters: readonly MotionParameter[],
  values: VariableValues,
  inputs: Readonly<Record<string, unknown>>,
): VariableValues {
  if (typeof inputs !== 'object' || inputs === null || Array.isArray(inputs)) {
    throw new Error('Motion inputs must be a parameter object')
  }

  const next = { ...values }

  for (const name of Object.keys(inputs)) {
    if (!parameters.some((parameter) => parameter.name === name)) {
      throw new Error(`Unknown motion parameter: ${name}`)
    }
  }

  for (const parameter of parameters) {
    if (!Object.hasOwn(inputs, parameter.name)) {
      throw new Error(`Missing motion parameter: ${parameter.name}`)
    }

    const value = inputs[parameter.name]

    if (typeof value !== parameter.type || (typeof value === 'number' && !Number.isFinite(value))) {
      throw new Error(`Motion parameter ${parameter.name} requires ${parameter.type}`)
    }

    Object.defineProperty(next, parameter.name, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    })
  }

  return next
}
