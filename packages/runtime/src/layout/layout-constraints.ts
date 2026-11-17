/**
 * Ordered stabilization rules for an absolute box whose containing block was
 * changed by generated projection. Freeze differing used padding first, then
 * inline size, then recheck block size after natural text reflow. Values are fixed
 * CSSOM used lengths, never width/height animation values.
 */
export const layoutConstraintPhases = [
  [
    ['padding-inline-start', 'paddingInlineStart'],
    ['padding-inline-end', 'paddingInlineEnd'],
    ['padding-block-start', 'paddingBlockStart'],
    ['padding-block-end', 'paddingBlockEnd'],
  ],
  [
    ['min-inline-size', 'inlineSize'],
    ['max-inline-size', 'inlineSize'],
  ],
  [
    ['min-block-size', 'blockSize'],
    ['max-block-size', 'blockSize'],
  ],
] as const

export type LayoutConstraintProperty = (typeof layoutConstraintPhases)[number][number][0]
export type LayoutBoxConstraints = ReadonlyMap<LayoutConstraintProperty, string>

export const layoutConstraintSources = [
  ...new Set(layoutConstraintPhases.flatMap((phase) => phase.map(([, source]) => source))),
]

/** Immutable used CSS lengths in the box's current writing mode and box sizing. */
export type LayoutAbsoluteBox = Readonly<
  Pick<CSSStyleDeclaration, (typeof layoutConstraintSources)[number]>
> & {
  readonly containingBlock: Element | null
}
