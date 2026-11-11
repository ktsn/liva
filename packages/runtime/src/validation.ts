import type {
  Definition,
  Layer,
  MotionParameter,
  Expression,
  LetBinding,
  Frame,
  CssValue,
  PropertyValue,
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

function hasOnlyFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return Object.keys(value).every((name) => fields.includes(name))
}

function isCssValue(value: unknown): value is CssValue {
  if (!isRecord(value)) return false

  switch (value.kind) {
    case 'literal':
      return hasOnlyFields(value, ['kind', 'value']) && typeof value.value === 'string'
    case 'template':
      return (
        hasOnlyFields(value, ['kind', 'parts']) &&
        Array.isArray(value.parts) &&
        value.parts.every((part: unknown) => typeof part === 'string' || isExpression(part))
      )
    default:
      return false
  }
}

function isPropertyValue(value: unknown): value is PropertyValue {
  if (!isRecord(value)) return false

  switch (value.kind) {
    case 'literal':
    case 'template':
      return isCssValue(value)
    case 'binding':
      return hasOnlyFields(value, ['kind', 'expression']) && isExpression(value.expression)
    case 'keyframes':
      return (
        hasOnlyFields(value, ['kind', 'frames']) &&
        isArrayOf(value.frames, isFrame) &&
        value.frames.some((frame) => frame.offset === 1)
      )
    default:
      return false
  }
}

export function isFrame(value: unknown): value is Frame {
  return (
    isRecord(value) &&
    hasOnlyFields(value, ['offset', 'value', 'easing', 'easingExpression']) &&
    typeof value.offset === 'number' &&
    isCssValue(value.value) &&
    (value.easingExpression === undefined || isExpression(value.easingExpression)) &&
    (value.easing === undefined || typeof value.easing === 'string')
  )
}

function isPropertyTransition(value: unknown): value is PropertyTransition {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    (value.timingExpression === undefined || isExpression(value.timingExpression)) &&
    (value.timing === undefined || isTiming(value.timing)) &&
    (value.keyframes === undefined || isArrayOf(value.keyframes, isFrame))
  )
}

function hasTimingProperties(value: Record<string, unknown>): boolean {
  return (
    value.timingProperties === undefined ||
    (Array.isArray(value.timingProperties) &&
      value.timingProperties.every((name: unknown) => typeof name === 'string'))
  )
}

function isTransitionTarget(value: unknown): value is Target<PropertyTransition> {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    hasTimingProperties(value) &&
    (value.timingExpression === undefined || isExpression(value.timingExpression)) &&
    isArrayOf(value.properties, isPropertyTransition)
  )
}

function isTransition(value: unknown): value is Transition {
  return (
    isRecord(value) &&
    (value.timingExpression === undefined || isExpression(value.timingExpression)) &&
    (value.timing === undefined || isTiming(value.timing)) &&
    isArrayOf(value.targets, isTransitionTarget)
  )
}

function isExpression(value: unknown, depth = 0): value is Expression {
  if (!isRecord(value) || depth > 256) return false

  switch (value.kind) {
    case 'call':
      return (
        typeof value.function === 'string' &&
        Array.isArray(value.arguments) &&
        value.arguments.every(
          (argument: unknown) =>
            isRecord(argument) &&
            typeof argument.name === 'string' &&
            isExpression(argument.value, depth + 1),
        )
      )
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

function isLetBinding(value: unknown): value is LetBinding {
  return isRecord(value) && typeof value.name === 'string' && isExpression(value.initializer)
}

function isStyleScope(value: unknown): value is State {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    (value.timingExpression === undefined || isExpression(value.timingExpression)) &&
    Array.isArray(value.targets) &&
    value.targets.every(
      (target: unknown) =>
        isRecord(target) &&
        typeof target.name === 'string' &&
        hasTimingProperties(target) &&
        (target.timingExpression === undefined || isExpression(target.timingExpression)) &&
        Array.isArray(target.properties) &&
        target.properties.every(
          (property: unknown) =>
            isRecord(property) &&
            hasOnlyFields(property, ['name', 'value', 'timing', 'timingExpression']) &&
            typeof property.name === 'string' &&
            isPropertyValue(property.value) &&
            (property.timing === undefined || isTiming(property.timing)) &&
            (property.timingExpression === undefined || isExpression(property.timingExpression)),
        ),
    )
  )
}

function isLayer(value: unknown): value is Layer {
  return (
    isStyleScope(value) &&
    isRecord(value) &&
    (value.when === undefined || isExpression(value.when)) &&
    (value.states === undefined || isArrayOf(value.states, isStyleScope)) &&
    (value.initialState === undefined || typeof value.initialState === 'string') &&
    (value.transitions === undefined ||
      (Array.isArray(value.transitions) &&
        value.transitions.every(
          (item: unknown) =>
            isRecord(item) &&
            typeof item.from === 'string' &&
            typeof item.to === 'string' &&
            isExpression(item.when) &&
            isTransition(item.transition),
        )))
  )
}

export function isDefinition(value: unknown): value is Definition {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    isArrayOf(value.layers, isLayer) &&
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
    (value.letBindings === undefined || isArrayOf(value.letBindings, isLetBinding)) &&
    (value.enter === undefined || isTransition(value.enter)) &&
    (value.leave === undefined || isTransition(value.leave)) &&
    (value.events === undefined ||
      (Array.isArray(value.events) &&
        value.events.every(
          (event: unknown) =>
            isRecord(event) && typeof event.name === 'string' && isExpression(event.when),
        )))
  )
}
