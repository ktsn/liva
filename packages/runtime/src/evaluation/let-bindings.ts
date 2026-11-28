import { definitionTargetNames } from '../model/targets.ts'
import type {
  Definition,
  Expression,
  MotionParameter,
  LetBinding,
  CallExpression,
} from '../model/definition.ts'
import type { ReactiveCallEvaluation } from './reactive-call-store.ts'
import type { RuntimeValue } from './reactive-value.ts'
import { evaluate, withBuiltins, type VariableValues } from './expression.ts'
import type { EvaluationBuiltins } from './evaluation-builtins.ts'

export function targetValues(
  definition: Definition,
  previous: VariableValues = {},
): VariableValues {
  const names = definitionTargetNames(definition)

  return Object.fromEntries(
    [...names].map((name) => {
      const retained = Object.hasOwn(previous, name) ? previous[name] : undefined
      const value =
        typeof retained === 'object' && retained.name === name ? retained : Object.freeze({ name })

      return [name, value]
    }),
  )
}

export type LetBindingNode = {
  readonly definition: LetBinding
  readonly callIds: ReadonlyMap<CallExpression, number>
}

/**
 * Evaluates motion-local let bindings and validates their candidate environment.
 * Owns expression dependencies and call-site identities; ReactiveCallStore owns
 * cached call results, subscriptions, and their resource lifetime.
 *
 * Construction only analyzes dependencies and throws on cycles. Evaluation uses
 * operations supplied for that synchronous evaluation; the graph owns no call
 * resources. Runtime uses compatibleBindings to select safe store borrowing.
 */
export class LetBindingGraph {
  private readonly nodes: LetBindingNode[] = []
  /** Sorted authored [target, property] receiving addresses by binding, including aliases and inactive states. */
  readonly addresses: ReadonlyMap<string, string>

  private readonly builtins: EvaluationBuiltins

  /**
   * The optional address resolver runs after dependency ordering and describes
   * controller call ownership, including attachments in inactive states.
   */
  constructor(
    letBindings: readonly LetBinding[],
    addresses?: (nodes: readonly LetBindingNode[]) => ReadonlyMap<string, string>,
    builtins: EvaluationBuiltins = {},
  ) {
    this.builtins = builtins

    const pending = new Map(letBindings.map((binding) => [binding.name, binding]))
    const visiting = new Set<string>()

    // Resolve forward references before their consumers. The visiting set detects
    // cycles before any call instances are created or borrowed.
    const visit = (name: string) => {
      const definition = pending.get(name)
      if (!definition) return
      if (visiting.has(name)) throw new Error(`Cyclic let binding dependency: ${name}`)
      visiting.add(name)

      for (const dependency of dependencies(definition.initializer)) visit(dependency)

      visiting.delete(name)
      pending.delete(name)

      this.nodes.push({
        definition,
        callIds: new Map(collectCalls(definition.initializer).map((call, index) => [call, index])),
      })
    }

    for (const binding of letBindings) visit(binding.name)

    // Resolve property references only after dependency sorting has rejected cycles.
    // Address changes must replace the call even when its authored arguments match.
    this.addresses = addresses?.(this.nodes) ?? new Map()
  }

  /** Names whose initializer and complete receiving-address set match a previous graph. */
  compatibleBindings(previous: LetBindingGraph): readonly string[] {
    return this.nodes
      .filter((node) =>
        previous.nodes.some(
          (candidate) =>
            candidate.definition.name === node.definition.name &&
            JSON.stringify(candidate.definition.initializer) ===
              JSON.stringify(node.definition.initializer) &&
            previous.addresses.get(node.definition.name) ===
              this.addresses.get(node.definition.name),
        ),
      )
      .map((node) => node.definition.name)
  }

  /**
   * Returns a new environment containing the inputs and evaluated let values.
   * afterEvaluate runs synchronously and must not publish candidate state; it may
   * reject values needed by presentation or other consumers by throwing.
   * The caller must run this method inside Store.evaluate, including afterEvaluate,
   * before subscriptions and prepared calls are accepted. Errors propagate.
   */
  evaluate(variables: VariableValues, operations: ReactiveCallEvaluation): VariableValues
  evaluate<T>(
    variables: VariableValues,
    operations: ReactiveCallEvaluation | undefined,
    afterEvaluate: (values: VariableValues) => T,
  ): T
  evaluate<T>(
    variables: VariableValues,
    operations: ReactiveCallEvaluation | undefined,
    afterEvaluate?: (values: VariableValues) => T,
  ): T | VariableValues {
    // Keep candidate variables local so a later failure cannot publish a partial
    // environment. Dependency order makes each completed value available below.
    const values = withBuiltins({ ...variables }, this.builtins)

    for (const node of this.nodes) {
      // The graph resolves argument expressions, including nested calls; the store
      // decides whether to reuse a result, prepare an update, or create an instance.
      const invoke = operations
        ? (call: CallExpression, scope: VariableValues): RuntimeValue => {
            const args = Object.fromEntries(
              call.arguments.map((argument) => [
                argument.name,
                evaluate(argument.value, scope, invoke),
              ]),
            )
            // Every initializer call is indexed by collectCalls, including inactive branches.
            const id = node.callIds.get(call)!

            return operations.invoke(node.definition.name, id, call.function, args)
          }
        : undefined

      const value = evaluate(node.definition.initializer, values, invoke)
      Object.defineProperty(values, node.definition.name, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      })
    }

    // Presentation and other consumers must accept the complete environment before
    // returning control to the store, which then activates and commits call state.
    return afterEvaluate ? afterEvaluate(values) : values
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

function validateParameterValue(parameter: MotionParameter, value: unknown): void {
  const type = parameter.type

  if (typeof type === 'object') {
    if (typeof value !== 'string' || !type.values.includes(value)) {
      const expected = type.values.map((member) => JSON.stringify(member)).join(' | ')

      throw new Error(`Motion parameter ${parameter.name} requires ${expected}`)
    }

    return
  }

  if (type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`Motion parameter ${parameter.name} requires ${type}`)
    }

    return
  }

  if (typeof value !== type) {
    throw new Error(`Motion parameter ${parameter.name} requires ${type}`)
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

    validateParameterValue(parameter, value)

    Object.defineProperty(next, parameter.name, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    })
  }

  return next
}
