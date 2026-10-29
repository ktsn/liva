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
  readonly offset: number
  readonly value: string
  readonly easing?: string
}

export type Expression =
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

export type Source =
  | { readonly kind: 'external'; readonly name: string; readonly type: 'Boolean' }
  | { readonly kind: 'drag'; readonly name: string; readonly target: string }

export interface Property {
  readonly template?: readonly (string | Expression)[]
  readonly name: string
  readonly value: string
}

export interface Target<T> {
  readonly name: string
  readonly properties: readonly T[]
}

export interface State {
  readonly when?: Expression
  readonly name: string
  readonly targets: readonly Target<Property>[]
}

export interface PropertyTransition {
  readonly name: string
  readonly timing?: Timing
  readonly keyframes?: readonly Frame[]
}

export interface Transition {
  readonly timing?: Timing
  readonly targets: readonly Target<PropertyTransition>[]
}

export interface Definition {
  readonly sources?: readonly Source[]
  readonly name: string
  readonly states: readonly State[]
  readonly generalTransition?: Transition
  readonly directionalTransitions: readonly {
    readonly from: string
    readonly to: string
    readonly transition: Transition
  }[]
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
