import { waapiProperty } from './animation.ts'
import { propertyRule, resolvePropertyComponents, type PropertyRule } from './property-rules.ts'

/**
 * A displayed CSS value in canonical numeric space: px for lengths, deg for rotation,
 * and unitless values for scale/opacity. Values and addresses have matching order;
 * addresses identify shared physical properties or individual transform axes.
 */
export type NumericProperty = {
  readonly values: readonly number[]
  readonly addresses: readonly string[]
  /**
   * Encodes components in the same order as values. Opacity is always clamped to
   * [0, 1]; bounded output additionally clamps dimensions to nonnegative values.
   */
  serialize(values: readonly number[], bounded?: boolean): string
}

/** Serializes canonical components using the rule's output unit and clamping policy. */
function serialize(rule: PropertyRule, values: readonly number[], bounded: boolean): string {
  const clamp = rule.clamp

  return values
    .map((value) => {
      const result =
        clamp && (!clamp.boundedOnly || bounded)
          ? Math.max(clamp.minimum, Math.min(clamp.maximum, value))
          : value

      return `${result}${rule.unit}`
    })
    .join(' ')
}

/**
 * Encodes finite canonical numeric components without reading the DOM. Values must
 * follow the property's component order: px for lengths/translate, deg for rotate,
 * and unitless values for scale/opacity. Opacity is always clamped to [0, 1]; bounded
 * output additionally clamps dimensions to nonnegative values. Unsupported properties
 * return undefined. Component count and finiteness are the caller's responsibility.
 */
export function encodeProperty(
  property: string,
  values: readonly number[],
  bounded = false,
): string | undefined {
  return propertyEncoder(property)?.(values, bounded)
}

/** Returns a pure canonical-component encoder, or undefined for an unsupported property. */
export function propertyEncoder(property: string) {
  const rule = propertyRule(property)

  return rule
    ? (values: readonly number[], bounded: boolean) => serialize(rule, values, bounded)
    : undefined
}

/** Splits space-separated computed components while keeping CSS math expressions intact. */
function components(value: string): string[] {
  const result: string[] = []
  let depth = 0
  let start = 0

  for (let index = 0; index <= value.length; index++) {
    const character = value[index]
    if (character === '(') depth++
    if (character === ')') depth--

    if (index === value.length || (depth === 0 && /\s/.test(character))) {
      // Computed CSS serializes components with one separator and no edge whitespace.
      result.push(value.slice(start, index))
      start = index + 1
    }
  }

  return result
}

/**
 * Reads one nonempty, browser-validated computed CSS component as a finite number.
 * Supports unitless numbers, px, deg, percentages, and normalized calc/min/max/clamp
 * expressions. Unsupported tokens or nonfinite results return undefined; this is
 * not a validator or unit resolver for arbitrary authored CSS.
 *
 * @param reference The numeric value represented by 100%, in the result's units.
 * For translate X/Y this is the element's border-box width/height in px; for
 * unitless scale/opacity it is 1. Callers pass 0 when the computed component is
 * expected to have no remaining percentage, such as a resolved length or rotation.
 */
function numeric(value: string, reference: number): number | undefined {
  // Numeric inputs are nonempty computed CSS values; even unsupported keywords tokenize.
  const tokens = value.match(/(?:\d*\.)?\d+(?:e[+-]?\d+)?(?:px|%|deg)?|[a-zA-Z]+|[()+*/,-]/g)!
  /* v8 ignore if -- @preserve: CSSOM's validated numeric serialization uses only this token alphabet; unknown words are rejected by atom(). */
  if (tokens.join('') !== value.replace(/\s/g, '')) return undefined
  let cursor = 0

  /** Reads a primary expression or unary minus, resolving percentages against reference. */
  const atom = (): number => {
    const token = tokens[cursor++]
    if (token === '-') return -atom()

    if (token === '(') {
      const result = sum()
      cursor++ // Computed CSSOM math is syntactically balanced.
      return result
    }

    if (['calc', 'min', 'max', 'clamp'].includes(token)) {
      cursor++ // CSSOM validates the function delimiter and arity.
      const args = [sum()]

      while (tokens[cursor] === ',') {
        cursor++
        args.push(sum())
      }

      cursor++ // Computed CSSOM math is syntactically balanced.
      if (token === 'calc') return args[0]
      if (token === 'min') return Math.min(...args)
      if (token === 'max') return Math.max(...args)
      return Math.max(args[0], Math.min(args[1], args[2]))
    }

    const match = token?.match(/^((?:\d*\.)?\d+(?:e[+-]?\d+)?)(px|%|deg)?$/)
    if (!match) return NaN
    const number = Number(match[1])
    const unit = match[2]
    // reference supplies the value of 100% in the output's units:
    // 50% of a 200px translate axis becomes 100px before arithmetic is evaluated.
    if (unit === '%') return (number * reference) / 100
    // Computed rotation is serialized in degrees, including authored rad/grad/turn.
    return number
  }

  /** Reads multiplication before addition, using CSSOM's normalized numeric factors. */
  const product = (): number => {
    let result = atom()

    // Computed CSS normalizes numeric division to a multiplicative coefficient.
    while (tokens[cursor] === '*') {
      cursor++
      result *= atom()
    }

    return result
  }

  /** Reads an additive expression up to a comma, closing delimiter, or the end of input. */
  const sum = (): number => {
    let result = product()

    while (tokens[cursor] === '+' || tokens[cursor] === '-') {
      const operator = tokens[cursor++]
      const right = product()
      result = operator === '+' ? result + right : result - right
    }

    return result
  }

  const result = sum()
  return cursor === tokens.length && Number.isFinite(result) ? result : undefined
}

/**
 * Returns an untransformed border-box dimension in px from computed numeric sizing.
 * Content-box dimensions include padding and borders in the returned percentage basis.
 * Returns NaN if the computed sizing is not numeric.
 */
function borderSize(style: CSSStyleDeclaration, axis: 'width' | 'height'): number {
  const value = Number.parseFloat(style[axis])
  if (style.boxSizing === 'border-box') return value

  const sides = axis === 'width' ? ['Left', 'Right'] : ['Top', 'Bottom']
  return (
    value +
    sides.reduce(
      (total, side) =>
        total +
        Number.parseFloat(style.getPropertyValue(`padding-${side.toLowerCase()}`)) +
        Number.parseFloat(style.getPropertyValue(`border-${side.toLowerCase()}-width`)),
      0,
    )
  )
}

/**
 * Reads the currently displayed value of a supported numeric property, including
 * active animation effects. Logical properties resolve to physical addresses in
 * the target's writing context. Transform identities expand to complete components.
 * Translate percentages assume a border-box reference; other transform reference
 * boxes are not accounted for.
 * Returns undefined for detached/unrendered targets, unsupported properties, or
 * computed values outside the numeric codec's supported space.
 */
export function decodeProperty(
  element: HTMLElement,
  property: string,
): NumericProperty | undefined {
  if (!element.isConnected || element.getClientRects().length === 0) return undefined
  const rule = propertyRule(property)
  if (!rule) return undefined

  const style = getComputedStyle(element)
  const text = style.getPropertyValue(property).trim()
  let values: (number | undefined)[]
  const addresses = resolvePropertyComponents(rule, style)

  if (rule.kind === 'translate') {
    const parts = text === 'none' ? [] : components(text)

    // Individual translate can retain percentages in computed CSS. X/Y use the
    // target's own box, rather than its parent's size; Z has no percentage basis.
    values = [
      numeric(parts[0] ?? '0', borderSize(style, 'width')),
      numeric(parts[1] ?? '0', borderSize(style, 'height')),
      numeric(parts[2] ?? '0', 0),
    ]
  } else if (rule.kind === 'scale') {
    const parts = text === 'none' ? [] : components(text)

    // A percentage in a unitless component is a ratio: reference=1 makes 50% equal 0.5.
    values = [
      numeric(parts[0] ?? '1', 1),
      numeric(parts[1] ?? parts[0] ?? '1', 1),
      numeric(parts[2] ?? '1', 1),
    ]
  } else if (rule.kind === 'rotate') {
    values = [numeric(text === 'none' ? '0deg' : text, 0)]
  } else if (rule.kind === 'opacity') {
    values = [numeric(text, 1)]
  } else {
    // These physical length reads expect CSSOM-resolved px values, so the caller
    // supplies no percentage basis here, unlike individual translate above.
    values = addresses.map((name) => numeric(style.getPropertyValue(name).trim(), 0))
  }

  if (values.some((value) => value === undefined)) return undefined
  const numbers = values.filter((value): value is number => value !== undefined)

  return {
    values: numbers,
    addresses,
    serialize(next, bounded = false) {
      return serialize(rule, next, bounded)
    },
  }
}

/**
 * Decodes an authored endpoint in the target's current CSS context into numeric space.
 * Returns undefined for invalid CSS, intrinsic auto/calc-size endpoints, or values
 * unsupported by decodeProperty. A temporary animation effect is always cancelled
 * before returning; inline declarations are not changed.
 */
export function decodeDestination(
  element: HTMLElement,
  property: string,
  value: string,
): NumericProperty | undefined {
  if (value.trim() === 'auto' || value.includes('calc-size(') || !CSS.supports(property, value))
    return undefined
  const probe = element.animate(
    [{ [waapiProperty(property)]: value }, { [waapiProperty(property)]: value }],
    {
      duration: 1,
      fill: 'both',
    },
  )

  try {
    probe.pause()
    probe.currentTime = 0

    return decodeProperty(element, property)
  } finally {
    probe.cancel()
  }
}

/**
 * Returns an opaque comparison key for the tracked dependencies of a relative endpoint:
 * percentage dimensions, font sizes, viewport size, and referenced custom properties.
 * A changed key signals that the authored destination must be resolved again.
 * Returns undefined for unsupported properties or destinations without recognized
 * relative units/var(). This key is not numeric's scalar percentage reference.
 */
export function propertyReference(
  element: HTMLElement,
  property: string,
  destination: string,
): string | undefined {
  const rule = propertyRule(property)
  if (!rule || !/%|(?:em|rem|vw|vh|vmin|vmax)\b|var\(/.test(destination)) return undefined

  const style = getComputedStyle(element)
  const container =
    style.position === 'absolute'
      ? (element.offsetParent ?? element.parentElement)
      : element.parentElement
  const parent = container ? getComputedStyle(container) : undefined

  // Translate percentages depend on the target's own box. Other endpoints track
  // the container, so animating width/height does not invalidate its own destination
  // on every frame merely because the displayed dimension changed.
  const percentage =
    rule.kind === 'translate'
      ? [borderSize(style, 'width'), borderSize(style, 'height')]
      : parent
        ? [borderSize(parent, 'width'), borderSize(parent, 'height')]
        : [0, 0]
  const variables = [...destination.matchAll(/var\(\s*(--[\w-]+)/g)].map((match) =>
    style.getPropertyValue(match[1]),
  )

  return JSON.stringify([
    percentage,
    style.fontSize,
    getComputedStyle(element.ownerDocument.documentElement).fontSize,
    element.ownerDocument.defaultView?.innerWidth,
    element.ownerDocument.defaultView?.innerHeight,
    variables,
  ])
}

/**
 * Returns the ordered component identities used for property ownership. Logical
 * aliases share physical identities; transform axes have separate identities.
 * An unsupported property retains its authored name as a single opaque address.
 */
export function propertyAddresses(element: HTMLElement, property: string): readonly string[] {
  const rule = propertyRule(property)

  if (!rule) return [property]

  // Static components need no CSSOM read; only length aliases depend on writing context.
  return rule.kind === 'length'
    ? resolvePropertyComponents(rule, getComputedStyle(element))
    : rule.components
}

/**
 * Expands supported inset/logical tracks into equivalent physical-property tracks
 * in the target's current writing context, preserving authored units and frame timing.
 * Returns the original track if it is already canonical, unsupported, or any value
 * cannot be split into the required longhands by the browser.
 */
export function canonicalTracks(
  element: HTMLElement,
  track: import('../composition/resolve.ts').ResolvedTrack,
): readonly import('../composition/resolve.ts').ResolvedTrack[] {
  return canonicalTrackFacts(element, track).map((fact) => fact.track)
}

/**
 * Observes expansion once, retaining the canonical component addresses alongside
 * each playback unit. Opaque/unsplittable CSS remains one atomic browser track;
 * no additional codec support or unit conversion is introduced.
 */
export function canonicalTrackFacts(
  element: HTMLElement,
  track: import('../composition/resolve.ts').ResolvedTrack,
): readonly {
  readonly track: import('../composition/resolve.ts').ResolvedTrack
  readonly addresses: readonly string[]
}[] {
  const rule = propertyRule(track.property)
  if (rule?.kind !== 'length')
    return [{ track, addresses: propertyAddresses(element, track.property) }]
  const addresses = resolvePropertyComponents(rule, getComputedStyle(element))
  if (addresses.length === 1 && addresses[0] === track.property) return [{ track, addresses }]

  // Authored longhand names split the CSS value; resolved components determine
  // which physical tracks receive it. Neither step resolves authored units.
  const names = rule.longhands ?? [track.property]

  /** Returns authored longhand values in component order, or undefined if splitting fails. */
  const split = (value: string): readonly string[] | undefined => {
    const style = element.ownerDocument.createElement('div').style
    style.setProperty(track.property, value)
    const values = names.map((name) => style.getPropertyValue(name))

    return values.every((entry) => entry !== '') ? values : undefined
  }
  const destination = split(track.destinationValue)
  const frames = track.keyframes.map((frame) => split(frame.value))
  if (!destination || frames.some((frame) => frame === undefined)) return [{ track, addresses }]

  return addresses.map((property, index) => ({
    addresses: [property],
    track: {
      ...track,
      property,
      destinationValue: destination[index],
      keyframes: track.keyframes.map((frame, frameIndex) => ({
        ...frame,
        // Every frame was split successfully above, with one value per canonical address.
        value: frames[frameIndex]![index],
      })),
    },
  }))
}
