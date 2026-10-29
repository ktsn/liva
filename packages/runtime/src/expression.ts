import type { Definition, Expression, Property } from './definition.ts'

export type SourceValues = Readonly<Record<string, boolean | DragValue>>
export interface DragValue {
  readonly active: boolean
  readonly offset: { readonly x: number; readonly y: number }
}

type Scalar = number | boolean | string

export function evaluate(expression: Expression, values: SourceValues): Scalar {
  switch (expression.kind) {
    case 'number':
    case 'boolean':
    case 'string':
      return expression.value
    case 'reference': {
      const [source, member, axis] = expression.path
      const value = values[source]
      if (typeof value === 'boolean' && !member) return value
      if (typeof value === 'object') {
        if (member === 'active' && !axis) return value.active
        if (member === 'offset' && (axis === 'x' || axis === 'y')) return value.offset[axis]
      }
      throw new Error(`Unknown source reference: ${expression.path.join('.')}`)
    }
    case 'unary': {
      const value = evaluate(expression.operand, values)
      if (expression.operator === '!') return !value
      return finite(expression.operator === '-' ? -Number(value) : Number(value))
    }
    case 'binary': {
      const left = evaluate(expression.left, values)
      if (expression.operator === '&&') return Boolean(left && evaluate(expression.right, values))
      if (expression.operator === '||') return Boolean(left || evaluate(expression.right, values))
      const right = evaluate(expression.right, values)
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

function finite(value: number): number {
  if (!Number.isFinite(value)) throw new Error('Expression result must be finite')
  return value
}

export function selectState(definition: Definition, values: SourceValues): string {
  let selected = definition.states.find((state) => !state.when)?.name

  for (const state of definition.states) {
    if (state.when && evaluate(state.when, values) === true) selected = state.name
  }

  if (!selected) throw new Error('Definition requires a fallback state')
  return selected
}

export function renderValue(property: Property, values: SourceValues): string {
  return property.template
    ? property.template
        .map((part) => (typeof part === 'string' ? part : String(evaluate(part, values))))
        .join('')
    : property.value
}

export function renderDefinition(
  definition: Definition,
  values: SourceValues,
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
