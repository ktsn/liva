import type {
  Definition,
  MotionParameter,
  Expression,
  Source,
  Frame,
  PropertyTransition,
  State,
  Target,
  Timing,
  Transition,
} from './definition.ts'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isArrayOf<T>(value: unknown, check: (item: unknown) => item is T): value is T[] {
  return Array.isArray(value) && value.every(check)
}

function isTiming(value: unknown): value is Timing {
  if (!isRecord(value)) return false

  switch (value.kind) {
    case 'tween':
      return typeof value.durationMs === 'number' && typeof value.easing === 'string'
    case 'spring-duration':
      return typeof value.durationMs === 'number' && typeof value.bounce === 'number'
    case 'spring-physics':
      return (
        typeof value.stiffness === 'number' &&
        typeof value.damping === 'number' &&
        typeof value.mass === 'number'
      )
    default:
      return false
  }
}

export function isFrame(value: unknown): value is Frame {
  return (
    isRecord(value) &&
    typeof value.offset === 'number' &&
    typeof value.value === 'string' &&
    (value.easing === undefined || typeof value.easing === 'string')
  )
}

function isPropertyTransition(value: unknown): value is PropertyTransition {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    (value.timing === undefined || isTiming(value.timing)) &&
    (value.keyframes === undefined || isArrayOf(value.keyframes, isFrame))
  )
}

function isTransitionTarget(value: unknown): value is Target<PropertyTransition> {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    isArrayOf(value.properties, isPropertyTransition)
  )
}

function isTransition(value: unknown): value is Transition {
  return (
    isRecord(value) &&
    (value.timing === undefined || isTiming(value.timing)) &&
    isArrayOf(value.targets, isTransitionTarget)
  )
}

function isExpression(value: unknown, depth = 0): value is Expression {
  if (!isRecord(value) || depth > 256) return false

  switch (value.kind) {
    case 'number':
      return typeof value.value === 'number' && Number.isFinite(value.value)
    case 'boolean':
      return typeof value.value === 'boolean'
    case 'string':
      return typeof value.value === 'string'
    case 'reference':
      return (
        Array.isArray(value.path) &&
        value.path.length > 0 &&
        value.path.every((part: unknown) => typeof part === 'string')
      )
    case 'unary':
      return (
        typeof value.operator === 'string' &&
        ['!', '+', '-'].includes(value.operator) &&
        isExpression(value.operand, depth + 1)
      )
    case 'binary':
      return (
        typeof value.operator === 'string' &&
        [
          '+',
          '-',
          '*',
          '/',
          '%',
          '<',
          '<=',
          '>',
          '>=',
          '==',
          '!=',
          '===',
          '!==',
          '&&',
          '||',
        ].includes(value.operator) &&
        isExpression(value.left, depth + 1) &&
        isExpression(value.right, depth + 1)
      )
    default:
      return false
  }
}

function isSource(value: unknown): value is Source {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    value.kind === 'drag' &&
    typeof value.target === 'string'
  )
}

function isState(value: unknown): value is State {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    (value.when === undefined || isExpression(value.when)) &&
    Array.isArray(value.targets) &&
    value.targets.every(
      (target: unknown) =>
        isRecord(target) &&
        typeof target.name === 'string' &&
        Array.isArray(target.properties) &&
        target.properties.every(
          (property: unknown) =>
            isRecord(property) &&
            typeof property.name === 'string' &&
            typeof property.value === 'string' &&
            (property.template === undefined ||
              (Array.isArray(property.template) &&
                property.template.every(
                  (part: unknown) => typeof part === 'string' || isExpression(part),
                ))),
        ),
    )
  )
}

export function isDefinition(value: unknown): value is Definition {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    (value.parameters === undefined ||
      isArrayOf(
        value.parameters,
        (parameter): parameter is MotionParameter =>
          isRecord(parameter) &&
          typeof parameter.name === 'string' &&
          (parameter.type === 'number' ||
            parameter.type === 'boolean' ||
            parameter.type === 'string'),
      )) &&
    (value.sources === undefined || isArrayOf(value.sources, isSource)) &&
    isArrayOf(value.states, isState) &&
    (value.generalTransition === undefined || isTransition(value.generalTransition)) &&
    Array.isArray(value.directionalTransitions) &&
    value.directionalTransitions.every(
      (direction: unknown) =>
        isRecord(direction) &&
        typeof direction.from === 'string' &&
        typeof direction.to === 'string' &&
        isTransition(direction.transition),
    )
  )
}
