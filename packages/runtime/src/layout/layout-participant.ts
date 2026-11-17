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
  /** Temporary output is restored through Executor's ordinary inline ownership machinery. */
  layoutTransform(element: HTMLElement, transform: string | undefined): void
  /** Synchronous observation-only overrides; returned cleanup restores the current outer owner. */
  layoutMeasure(element: HTMLElement, properties: ReadonlyMap<string, string>): () => void
  /** Releases temporary output/observations, retaining failed native resources for retry. */
  layoutCleanup(): void
  onLayoutChange?: () => void
}
