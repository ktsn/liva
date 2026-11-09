/** CSS context needed to resolve logical components; no DOM access is performed here. */
export interface WritingContext {
  readonly writingMode: string
  readonly direction: string
}

type PhysicalLength = 'width' | 'height' | 'top' | 'right' | 'bottom' | 'left'
type LogicalLength =
  | 'inlineSize'
  | 'blockSize'
  | 'inlineStart'
  | 'inlineEnd'
  | 'blockStart'
  | 'blockEnd'
type Component =
  | PhysicalLength
  | LogicalLength
  | `${'translate' | 'scale'}.${'x' | 'y' | 'z'}`
  | 'rotate'
  | 'opacity'

/**
 * Numeric property semantics shared by CSS decoding, track expansion, and ownership.
 * Components identify independent physical values after logical resolution. Longhands
 * name the authored CSS fields used to split a shorthand without resolving its units.
 * Clamps apply either to every serialization or only when bounded output is requested.
 */
export interface PropertyRule {
  readonly kind: 'length' | 'translate' | 'scale' | 'rotate' | 'opacity'
  readonly components: readonly Component[]
  readonly unit: 'px' | 'deg' | ''
  readonly longhands?: readonly string[]
  readonly clamp?: {
    readonly minimum: number
    readonly maximum: number
    readonly boundedOnly: boolean
  }
}

const length = { kind: 'length', unit: 'px' } as const
const dimension = {
  ...length,
  clamp: { minimum: 0, maximum: Infinity, boundedOnly: true },
}
const physicalSides = ['top', 'right', 'bottom', 'left'] as const

// Keep property relationships in one table. Consumers dispatch on numeric kind,
// rather than repeating lists of property names for each operation.
const rules: ReadonlyMap<string, PropertyRule> = new Map([
  [
    'translate',
    { kind: 'translate', components: ['translate.x', 'translate.y', 'translate.z'], unit: 'px' },
  ],
  ['scale', { kind: 'scale', components: ['scale.x', 'scale.y', 'scale.z'], unit: '' }],
  ['rotate', { kind: 'rotate', components: ['rotate'], unit: 'deg' }],
  [
    'opacity',
    {
      kind: 'opacity',
      components: ['opacity'],
      unit: '',
      clamp: { minimum: 0, maximum: 1, boundedOnly: false },
    },
  ],
  ['width', { ...dimension, components: ['width'] }],
  ['height', { ...dimension, components: ['height'] }],
  ['inline-size', { ...dimension, components: ['inlineSize'] }],
  ['block-size', { ...dimension, components: ['blockSize'] }],
  ['top', { ...length, components: ['top'] }],
  ['right', { ...length, components: ['right'] }],
  ['bottom', { ...length, components: ['bottom'] }],
  ['left', { ...length, components: ['left'] }],
  ['inset', { ...length, components: physicalSides, longhands: physicalSides }],
  [
    'inset-inline',
    {
      ...length,
      components: ['inlineStart', 'inlineEnd'],
      longhands: ['inset-inline-start', 'inset-inline-end'],
    },
  ],
  [
    'inset-block',
    {
      ...length,
      components: ['blockStart', 'blockEnd'],
      longhands: ['inset-block-start', 'inset-block-end'],
    },
  ],
  ['inset-inline-start', { ...length, components: ['inlineStart'] }],
  ['inset-inline-end', { ...length, components: ['inlineEnd'] }],
  ['inset-block-start', { ...length, components: ['blockStart'] }],
  ['inset-block-end', { ...length, components: ['blockEnd'] }],
])

type Flow = {
  readonly inlineSize: 'width' | 'height'
  readonly blockSize: 'width' | 'height'
  readonly inline: readonly [PhysicalLength, PhysicalLength]
  readonly block: readonly [PhysicalLength, PhysicalLength]
}

const horizontal: Flow = {
  inlineSize: 'width',
  blockSize: 'height',
  inline: ['left', 'right'],
  block: ['top', 'bottom'],
}
const verticalRight: Flow = {
  inlineSize: 'height',
  blockSize: 'width',
  inline: ['top', 'bottom'],
  block: ['right', 'left'],
}
const verticalLeft: Flow = { ...verticalRight, block: ['left', 'right'] }

// Inline pairs are written for LTR. RTL reverses only that pair, including the
// bottom-to-top inline progression of sideways-lr.
const flows: ReadonlyMap<string, Flow> = new Map([
  ['horizontal-tb', horizontal],
  ['vertical-rl', verticalRight],
  ['vertical-lr', verticalLeft],
  ['sideways-rl', verticalRight],
  ['sideways-lr', { ...verticalLeft, inline: ['bottom', 'top'] }],
])

/** Returns the supported numeric rule, or undefined for an unrecognized property. */
export function propertyRule(property: string): PropertyRule | undefined {
  return rules.get(property)
}

/**
 * Resolves a supported rule's components using writing mode and direction.
 * Unknown modes retain the vertical fallback (right-to-left block flow for an rl
 * suffix); empty CSSOM context, such as a detached element, follows vertical-lr.
 */
export function resolvePropertyComponents(
  rule: PropertyRule,
  context: WritingContext,
): readonly string[] {
  if (rule.kind !== 'length') return rule.components

  const flow =
    flows.get(context.writingMode) ??
    (context.writingMode.endsWith('rl') ? verticalRight : verticalLeft)
  const [inlineStart, inlineEnd] =
    context.direction === 'rtl' ? [flow.inline[1], flow.inline[0]] : flow.inline
  const logical: Readonly<Partial<Record<Component, string>>> = {
    inlineSize: flow.inlineSize,
    blockSize: flow.blockSize,
    inlineStart,
    inlineEnd,
    blockStart: flow.block[0],
    blockEnd: flow.block[1],
  }

  return rule.components.map((component) => logical[component] ?? component)
}
