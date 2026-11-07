import { timingProvider, type TimingDeclaration } from './layer-cascade.ts'
import {
  easingConstant,
  isTimingFunction,
  callTiming,
  timingValue,
  easingCss,
} from './timing-values.ts'
import type { CallExpression, Expression, Property, Frame, Transition } from './definition.ts'

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
      let value: RuntimeValue | undefined = Object.hasOwn(values, name)
        ? values[name]
        : easingConstant(name)

      for (const member of members) {
        value =
          typeof value === 'object' && Object.hasOwn(value, member) ? value[member] : undefined
      }

      if (value !== undefined) return value

      throw new Error(`Unknown variable reference: ${expression.path.join('.')}`)
    }
    case 'call':
      if (Object.hasOwn(values, expression.function)) {
        throw new Error(`Value is not callable: ${expression.function}`)
      }

      if (isTimingFunction(expression.function)) {
        const args = Object.fromEntries(
          expression.arguments.map((argument) => [
            argument.name,
            evaluate(argument.value, values, invoke),
          ]),
        )

        return callTiming(expression.function, args)
      }

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
    /* v8 ignore next -- @preserve: Expression is a closed union validated at the IR boundary. */
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

export function renderFrame(frame: Frame, values: VariableValues): Frame {
  return {
    ...frame,
    value: renderValue(frame, values),
    easing: frame.easingExpression
      ? easingCss(evaluate(frame.easingExpression, values))
      : frame.easing,
  }
}

export function renderTransition(transition: Transition, values: VariableValues): Transition {
  return {
    ...transition,
    timing: transition.timingExpression
      ? timingValue(evaluate(transition.timingExpression, values))
      : transition.timing,
    targets: transition.targets.map((target) => ({
      ...target,
      timing: target.timingExpression
        ? timingValue(evaluate(target.timingExpression, values))
        : target.timing,
      properties: target.properties.map((property) => {
        const provider = timingProvider<TimingDeclaration>(property, target)

        return {
          ...property,
          timing: provider?.timingExpression
            ? timingValue(evaluate(provider.timingExpression, values))
            : provider?.timing,
          keyframes: property.keyframes?.map((frame) => renderFrame(frame, values)),
        }
      }),
    })),
  }
}
