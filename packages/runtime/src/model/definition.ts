import type { LayoutDeclaration } from './layout.ts'
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

/** One endpoint at a normalized offset in [0, 1]; its CSS value cannot be a binding or track. */
export interface Frame {
  readonly easingExpression?: Expression
  readonly offset: number
  readonly value: CssValue
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
  /** Primitive descriptor, or a nonempty set of exact decoded string values. */
  readonly type:
    | 'number'
    | 'boolean'
    | 'string'
    | { readonly kind: 'stringUnion'; readonly values: readonly string[] }
}

export interface LetBinding {
  readonly name: string
  readonly initializer: Expression
}

/**
 * One CSS endpoint: opaque text or ordered text/scalar-expression interpolation parts.
 * Templates retain their surrounding quotes and CSS text in the parts themselves;
 * the original source spelling is available separately through development mappings.
 */
export type CssValue =
  | { readonly kind: 'literal'; readonly value: string }
  | { readonly kind: 'template'; readonly parts: readonly (string | Expression)[] }

/**
 * Exclusive declaration source. Bindings identify property controllers, not CSS text.
 * Style keyframe arrays are sorted by offset and include a 100% destination, from
 * which the runtime derives the settled value. Nested tracks are not supported.
 */
export type PropertyValue =
  | CssValue
  | { readonly kind: 'binding'; readonly expression: Expression }
  | { readonly kind: 'keyframes'; readonly frames: readonly Frame[] }

export interface Property {
  readonly timingExpression?: Expression
  readonly timing?: Timing
  readonly name: string
  readonly value: PropertyValue
}

/** CSS and reserved layout declarations share source order, but have distinct value contracts. */
export type Declaration = Property | LayoutDeclaration

export function isCssProperty(declaration: Declaration): declaration is Property {
  return !('kind' in declaration)
}

export interface Target<T> {
  /** Limits target timing to properties declared in its authored target block. */
  readonly timingProperties?: readonly string[]
  readonly timingExpression?: Expression
  readonly timing?: Timing
  readonly name: string
  readonly properties: readonly T[]
}

export interface State {
  readonly timingExpression?: Expression
  readonly timing?: Timing
  readonly name: string
  readonly targets: readonly Target<Declaration>[]
}

export interface GuardedTransition {
  readonly event?: Expression
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
  readonly targets: readonly Target<Declaration>[]
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
  readonly schemaVersion: 3
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
    bundle.schemaVersion !== 3 ||
    !isArrayOf(bundle.definitions, isDefinition)
  ) {
    throw new Error('Unsupported Liva Definition IR schema')
  }

  return freezeDefinition({ schemaVersion: 3 as const, definitions: bundle.definitions })
}
