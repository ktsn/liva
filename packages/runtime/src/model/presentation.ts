import type { Expression, Target, Timing } from './definition.ts'

/** Evaluated CSS keyframe; expressions and template structure remain in the source IR. */
export interface RenderedFrame {
  readonly offset: number
  readonly value: string
  readonly easing?: string
}

/**
 * Evaluated presentation, distinct from the declaration's exclusive source variant.
 * A binding retains its controller expression until the owner supplies the CSS value.
 */
export interface RenderedProperty {
  readonly name: string
  readonly value: string
  /** Final style reconciled after an explicit track, when distinct from its animated endpoint. */
  readonly completionValue?: string
  readonly timing?: Timing
  readonly keyframes?: readonly RenderedFrame[]
  readonly binding?: Expression
}

/** Fully evaluated CSS values for one presentation. */
export interface RenderedState {
  readonly name: string
  readonly targets: readonly Target<RenderedProperty>[]
}
