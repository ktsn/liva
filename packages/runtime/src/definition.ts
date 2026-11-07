import { isArrayOf, isDefinition, isRecord } from './validation.ts'

export type Timing =
  | { readonly kind: 'tween'; readonly durationMs: number; readonly easing: string }
  | { readonly kind: 'spring-duration'; readonly durationMs: number; readonly bounce: number }
  | {
      readonly kind: 'spring-physics'
      readonly stiffness: number
      readonly damping: number
      readonly mass: number
    }

export interface Frame {
  readonly easingExpression?: Expression
  readonly template?: readonly (string | Expression)[]
  readonly offset: number
  readonly value: string
  readonly easing?: string
}

export interface CallExpression {
  readonly kind: 'call'
  readonly function: string
  readonly arguments: readonly { readonly name: string; readonly value: Expression }[]
}

export type Expression =
  | CallExpression
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'reference'; readonly path: readonly string[] }
  | { readonly kind: 'unary'; readonly operator: string; readonly operand: Expression }
  | {
      readonly kind: 'binary'
      readonly operator: string
      readonly left: Expression
      readonly right: Expression
    }

export interface MotionParameter {
  readonly name: string
  readonly type: 'number' | 'boolean' | 'string'
}

export interface LetBinding {
  readonly name: string
  readonly initializer: Expression
}

export interface Property {
  readonly timingExpression?: Expression
  readonly timing?: Timing
  readonly keyframes?: readonly Frame[]
  readonly template?: readonly (string | Expression)[]
  readonly name: string
  readonly value: string
}

export interface Target<T> {
  readonly timingExpression?: Expression
  readonly timing?: Timing
  readonly name: string
  readonly properties: readonly T[]
}

export interface State {
  readonly timingExpression?: Expression
  readonly timing?: Timing
  readonly name: string
  readonly targets: readonly Target<Property>[]
}

export interface GuardedTransition {
  readonly from: string
  readonly to: string
  readonly when: Expression
  readonly transition: Transition
}

export interface Layer {
  readonly timingExpression?: Expression
  readonly timing?: Timing
  readonly name: string
  readonly when?: Expression
  readonly targets: readonly Target<Property>[]
  readonly states?: readonly State[]
  readonly initialState?: string
  readonly transitions?: readonly GuardedTransition[]
}

export interface PropertyTransition {
  readonly timingExpression?: Expression
  readonly name: string
  readonly timing?: Timing
  readonly keyframes?: readonly Frame[]
}

export interface Transition {
  readonly timingExpression?: Expression
  readonly timing?: Timing
  readonly targets: readonly Target<PropertyTransition>[]
}

export interface Definition {
  readonly layers: readonly Layer[]
  readonly enter?: Transition
  readonly leave?: Transition
  readonly events?: readonly { readonly name: string; readonly when: Expression }[]
  readonly parameters?: readonly MotionParameter[]
  readonly letBindings?: readonly LetBinding[]
  readonly name: string
}

export interface DefinitionBundle {
  readonly schemaVersion: 1
  readonly definitions: readonly Definition[]
}

export function freezeDefinition<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      freezeDefinition(child)
    }

    Object.freeze(value)
  }

  return value
}

/** Accepts serialized output from the trusted Rust compiler, not arbitrary user data. */
export function decodeBundle(json: string): DefinitionBundle {
  const bundle: unknown = JSON.parse(json)

  if (
    !isRecord(bundle) ||
    bundle.schemaVersion !== 1 ||
    !isArrayOf(bundle.definitions, isDefinition)
  ) {
    throw new Error('Unsupported Liva Definition IR schema')
  }

  return freezeDefinition({ schemaVersion: 1 as const, definitions: bundle.definitions })
}
