import type { CallExpression, Definition, Expression, Property } from './definition.ts'

import type { RuntimeValue, Scalar } from './reactive-value.ts'

export type VariableValues = Readonly<Record<string, RuntimeValue>>

type InvokeCall = (call: CallExpression, values: VariableValues) => RuntimeValue

export function evaluate(
  expression: Expression,
  values: VariableValues,
  invoke?: InvokeCall,
): RuntimeValue {
  switch (expression.kind) {
    case 'number':
    case 'boolean':
    case 'string':
      return expression.value
    case 'reference': {
      const [name, ...members] = expression.path
      let value: RuntimeValue | undefined = Object.hasOwn(values, name) ? values[name] : undefined

      for (const member of members) {
        value =
          typeof value === 'object' && Object.hasOwn(value, member) ? value[member] : undefined
      }

      if (value !== undefined) return value

      throw new Error(`Unknown variable reference: ${expression.path.join('.')}`)
    }
    case 'call':
      if (!invoke) throw new Error('Function call requires a let initializer context')
      return invoke(expression, values)
    case 'unary': {
      const value = evaluateScalar(expression.operand, values, invoke)
      if (expression.operator === '!') return !value
      return finite(expression.operator === '-' ? -Number(value) : Number(value))
    }
    case 'binary': {
      const left = evaluateScalar(expression.left, values, invoke)
      if (expression.operator === '&&')
        return Boolean(left && evaluateScalar(expression.right, values, invoke))
      if (expression.operator === '||')
        return Boolean(left || evaluateScalar(expression.right, values, invoke))
      const right = evaluateScalar(expression.right, values, invoke)
      switch (expression.operator) {
        case '==':
        case '===':
          return left === right
        case '!=':
        case '!==':
          return left !== right
        case '<':
          return left < right
        case '<=':
          return left <= right
        case '>':
          return left > right
        case '>=':
          return left >= right
        case '+':
          return finite(Number(left) + Number(right))
        case '-':
          return finite(Number(left) - Number(right))
        case '*':
          return finite(Number(left) * Number(right))
        case '/':
          return finite(Number(left) / Number(right))
        case '%':
          return finite(Number(left) % Number(right))
        default:
          throw new Error(`Unsupported expression operator: ${expression.operator}`)
      }
    }
    default:
      throw new Error('Unsupported expression kind')
  }
}

export function evaluateScalar(
  expression: Expression,
  values: VariableValues,
  invoke?: InvokeCall,
): Scalar {
  const value = evaluate(expression, values, invoke)

  if (typeof value === 'object') throw new Error('Expression requires a scalar value')

  return value
}

function finite(value: number): number {
  if (!Number.isFinite(value)) throw new Error('Expression result must be finite')
  return value
}

export function selectState(definition: Definition, values: VariableValues): string {
  let selected = definition.states.find((state) => !state.when)?.name

  for (const state of definition.states) {
    if (state.when && evaluate(state.when, values) === true) selected = state.name
  }

  if (!selected) throw new Error('Definition requires a fallback state')
  return selected
}

export function renderValue(
  property: Pick<Property, 'value' | 'template'>,
  values: VariableValues,
): string {
  return property.template
    ? property.template
        .map((part) => (typeof part === 'string' ? part : String(evaluateScalar(part, values))))
        .join('')
    : property.value
}

export function renderDefinition(
  definition: Definition,
  values: VariableValues,
  states: readonly string[],
): Definition {
  return {
    ...definition,
    states: definition.states.map((state) =>
      states.includes(state.name)
        ? {
            ...state,
            targets: state.targets.map((target) => ({
              ...target,
              properties: target.properties.map((property) => ({
                ...property,
                value: renderValue(property, values),
              })),
            })),
          }
        : state,
    ),
  }
}
