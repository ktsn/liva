import type { LayoutStyleProjection, LayoutStyleObservation } from './style-observation.ts'
import type { LayoutBoxConstraints } from './layout-constraints.ts'
import type { ResolvedLayoutConfiguration } from '../model/layout.ts'

/** One physical receiver; aliases never create separate generated style owners. */
export interface LayoutCandidate {
  readonly element: HTMLElement
  readonly spring?: typeof import('../motion/spring-motion.ts').springMotion
  readonly configuration?: ResolvedLayoutConfiguration
  readonly blocked: boolean
}

/** Executor's browser capability. Runtime continues to receive no elements/effects. */
export interface LayoutParticipant {
  readonly layoutRevision: number
  /** Unchanged revisions select persistent timing; changed revisions retain this transaction's timing. */
  layoutCandidates(transactionRevision?: number): readonly LayoutCandidate[]
  /**
   * Temporary output uses ordinary inline ownership. Optional fixed logical min/max
   * constraints/padding retain a participating absolute box's natural used layout when an
   * ancestor projection changes its containing block; they never animate dimensions.
   * Optional styles use cumulative generated local distortion and natural border-box
   * dimensions, after the batched source observation below. Omitting styles retains
   * the current paint context during geometry-only observation. Undefined transform
   * releases all temporary output to current CSS.
   */
  layoutTransform(
    element: HTMLElement,
    transform: string | undefined,
    constraints?: LayoutBoxConstraints,
    styles?: LayoutStyleProjection,
  ): void
  /** Batches a fresh uncorrected paint baseline only when its source can have changed. */
  layoutStyleObservation(
    element: HTMLElement,
    width: number,
    height: number,
  ): LayoutStyleObservation | undefined
  /** Synchronous observation-only overrides; returned cleanup restores the current outer owner. */
  layoutMeasure(element: HTMLElement, properties: ReadonlyMap<string, string>): () => void
  /** Releases temporary output/observations, retaining failed native resources for retry. */
  layoutCleanup(): void
  onLayoutChange?: () => void
}
