/** Clockwise physical corner order shared by computed decoding and generated output. */
export const layoutRadiusProperties = [
  'border-top-left-radius',
  'border-top-right-radius',
  'border-bottom-right-radius',
  'border-bottom-left-radius',
] as const

export const layoutStyleProperties = [...layoutRadiusProperties, 'box-shadow'] as const

// Ordinary numeric canonicalization does not expand radius shorthands/logical
// corners. These native CSS names all affect the same four-corner visual group.
const sources = new Set<string>([
  ...layoutStyleProperties,
  'border-radius',
  'border-start-start-radius',
  'border-start-end-radius',
  'border-end-start-radius',
  'border-end-end-radius',
])

/** Known paint-only properties whose authored effects require source style sampling. */
export function isLayoutStyleProperty(property: string): boolean {
  return sources.has(property)
}
