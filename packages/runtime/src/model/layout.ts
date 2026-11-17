import type { Expression, Timing } from './definition.ts'

/**
 * Physical axes in the existing geometry coordinate system. Width/height select
 * generated scaling, never CSS dimension writes. All false disables correction.
 */
export interface LayoutAxes {
  readonly x: boolean
  readonly y: boolean
  readonly width: boolean
  readonly height: boolean
}

/** Fixed selection authored in source; timing expressions retain ordinary timing rules. */
export interface LayoutDeclaration {
  readonly kind: 'layout'
  readonly name: '$layout'
  readonly axes: LayoutAxes
  readonly timingExpression?: Expression
  readonly timing?: Timing
}

/** Authored identity for source mapping; target is the canonical name, including self. */
export interface LayoutDeclarationSource {
  readonly layer: string
  readonly state?: string
  readonly target: string
  readonly declaration: LayoutDeclaration
}

/** Timing provenance follows the same layer/state/target/property scopes as CSS. */
export interface LayoutTimingSource {
  readonly layer: string
  readonly state?: string
  readonly target?: string
  readonly property?: string
  /** Index in this layer's transitions when directional timing supplies the value. */
  readonly transition?: number
}

/**
 * Effective layout configuration for one logical target, separate from CSS tracks.
 * Resolve at each geometry change/retarget even if the selection text is unchanged.
 * Missing timing settles immediately. Explicit Liva transform ownership suppresses
 * both projection and child compensation, including an authored transform: none.
 */
export interface ResolvedLayoutConfiguration {
  readonly target: string
  readonly axes: LayoutAxes
  readonly timing?: Timing
  readonly source: LayoutDeclarationSource
  readonly timingSource?: LayoutTimingSource
  readonly declarations: readonly LayoutDeclarationSource[]
  /** Ordinary layer/state ownership; scoped lifecycle/preview owners are execution facts. */
  readonly explicitTransform: boolean
}

/** Checks serialized axes, rejecting missing axes and unsupported coordinate options. */
export function isLayoutAxes(value: unknown): value is LayoutAxes {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false

  const names = ['x', 'y', 'width', 'height']
  const entries = Object.entries(value)

  return (
    entries.length === names.length &&
    entries.every(([name, axis]) => names.includes(name) && typeof axis === 'boolean')
  )
}
