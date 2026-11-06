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
  type FunctionResult,
  type ReactiveSubscription,
  type RuntimeValue,
} from './reactive-value.ts'
import { evaluate, type VariableValues } from './expression.ts'

export function targetValues(
  definition: Definition,
  previous: VariableValues = {},
): VariableValues {
  const names = new Set(
    definition.layers
      .flatMap((layer) => [layer, ...(layer.states ?? [])])
      .flatMap((state) => state.targets.map((target) => target.name)),
  )

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
  }

  evaluate(variables: VariableValues): VariableValues {
    const values = { ...variables }

    const evaluatedCalls = new Map<LetBindingNode, Map<number, CallSite>>()

    for (const node of this.nodes) {
      const calls = new Map<number, CallSite>()
      const invoke = (call: CallExpression, scope: VariableValues): RuntimeValue => {
        const args = Object.fromEntries(
          call.arguments.map((argument) => [
            argument.name,
            evaluate(argument.value, scope, invoke),
          ]),
        )
        const id = node.callIds.get(call)!
        const retained = node.calls.get(id)
        const matches =
          retained?.name === call.function &&
          Object.keys(args).length === Object.keys(retained.args).length &&
          Object.entries(args).every(([name, argument]) => retained.args[name] === argument)
        const site = matches
          ? retained
          : { name: call.function, args, result: callBuiltin(call.function, args) }
        calls.set(id, site)

        return isReactiveSubscription(site.result) ? site.result.value : site.result
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

    this.updateSubscriptions([...evaluatedCalls.values()])

    for (const [node, calls] of evaluatedCalls) node.calls = calls

    return values
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
          added.set(subscription, subscription.bind(binding.targets, binding.update))
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
    this.updateSubscriptions(this.nodes.map((node) => node.calls))

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
      return expression.arguments.flatMap((argument) => dependencies(argument.value))
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
    throw new Error('Motion inputs must be a parameter object; string-state bindings were removed')
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
