import { ROOT_TARGET } from './targets.ts'
import type {
  Definition,
  Expression,
  MotionParameter,
  LetBinding,
  CallExpression,
} from './definition.ts'
import { ReactiveCallStore } from './reactive-call-store.ts'
import type { RuntimeValue } from './reactive-value.ts'
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

type LetBindingNode = {
  readonly definition: LetBinding
  readonly callIds: ReadonlyMap<CallExpression, number>
}

export class LetBindingGraph {
  private readonly nodes: LetBindingNode[] = []
  private readonly calls: ReactiveCallStore

  constructor(
    letBindings: readonly LetBinding[],
    values: VariableValues,
    previous?: LetBindingGraph,
  ) {
    const pending = new Map(letBindings.map((binding) => [binding.name, binding]))
    const visiting = new Set<string>()
    const retainedBindings: string[] = []

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
      if (retained) retainedBindings.push(name)

      this.nodes.push({
        definition,
        callIds: new Map(collectCalls(definition.initializer).map((call, index) => [call, index])),
      })
    }

    for (const binding of letBindings) visit(binding.name)

    this.calls = new ReactiveCallStore(previous?.calls, retainedBindings)
    this.evaluate(values)
  }

  evaluate(
    variables: VariableValues,
    validate: (values: VariableValues) => void = () => {},
  ): VariableValues {
    return this.calls.evaluate((transaction) => {
      const values = { ...variables }

      for (const node of this.nodes) {
        const invoke = (call: CallExpression, scope: VariableValues): RuntimeValue => {
          const args = Object.fromEntries(
            call.arguments.map((argument) => [
              argument.name,
              evaluate(argument.value, scope, invoke),
            ]),
          )
          // Every initializer call is indexed by collectCalls, including inactive branches.
          const id = node.callIds.get(call)!

          return transaction.invoke(node.definition.name, id, call.function, args)
        }

        const value = evaluate(node.definition.initializer, values, invoke)
        Object.defineProperty(values, node.definition.name, {
          value,
          enumerable: true,
          writable: true,
          configurable: true,
        })
      }

      validate(values)

      return values
    })
  }

  /** Release call ownership, preserving compatible instances transferred to a replacement. */
  dispose(retained?: LetBindingGraph) {
    this.calls.dispose(retained?.calls)
  }

  bind(targets: ReadonlyMap<string, HTMLElement>, update: () => void): (() => void)[] {
    return this.calls.bind(targets, update)
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
