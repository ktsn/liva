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

export interface Property {
  readonly name: string
  readonly value: string
}

export interface Target<T> {
  readonly name: string
  readonly properties: readonly T[]
}

export interface State {
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
