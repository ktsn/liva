import type { LayoutBoxConstraints } from './layout-constraints.ts'
import type { ResolvedLayoutConfiguration } from '../model/layout.ts'

/** One physical receiver; aliases never create separate generated style owners. */
export interface LayoutCandidate {
  readonly element: HTMLElement
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
   * Undefined transform releases both output and constraints to current CSS.
   */
  layoutTransform(
    element: HTMLElement,
    transform: string | undefined,
    constraints?: LayoutBoxConstraints,
  ): void
  /** Synchronous observation-only overrides; returned cleanup restores the current outer owner. */
  layoutMeasure(element: HTMLElement, properties: ReadonlyMap<string, string>): () => void
  /** Releases temporary output/observations, retaining failed native resources for retry. */
  layoutCleanup(): void
  onLayoutChange?: () => void
}
