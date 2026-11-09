import { waapiProperty } from './animation.ts'
import { propertyRule, resolvePropertyComponents } from './property-rules.ts'

export type NumericProperty = {
  readonly values: readonly number[]
  readonly addresses: readonly string[]
  serialize(values: readonly number[], bounded?: boolean): string
}

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

/** Computed CSS math retains percentages for individual translate; no JS evaluation is used. */
function numeric(value: string, reference: number): number | undefined {
  // Numeric inputs are nonempty computed CSS values; even unsupported keywords tokenize.
  const tokens = value.match(/(?:\d*\.)?\d+(?:e[+-]?\d+)?(?:px|%|deg)?|[a-zA-Z]+|[()+*/,-]/g)!
  /* v8 ignore if -- @preserve: CSSOM's validated numeric serialization uses only this token alphabet; unknown words are rejected by atom(). */
  if (tokens.join('') !== value.replace(/\s/g, '')) return undefined
  let cursor = 0

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
    if (unit === '%') return (number * reference) / 100
    // Computed rotation is serialized in degrees, including authored rad/grad/turn.
    return number
  }

  const product = (): number => {
    let result = atom()

    // Computed CSS normalizes numeric division to a multiplicative coefficient.
    while (tokens[cursor] === '*') {
      cursor++
      result *= atom()
    }

    return result
  }

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
    values = [
      numeric(parts[0] ?? '0', borderSize(style, 'width')),
      numeric(parts[1] ?? '0', borderSize(style, 'height')),
      numeric(parts[2] ?? '0', 0),
    ]
  } else if (rule.kind === 'scale') {
    const parts = text === 'none' ? [] : components(text)
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
    values = addresses.map((name) => numeric(style.getPropertyValue(name).trim(), 0))
  }

  if (values.some((value) => value === undefined)) return undefined
  const numbers = values.filter((value): value is number => value !== undefined)

  return {
    values: numbers,
    addresses,
    serialize(next, bounded = false) {
      const clamp = rule.clamp

      return next
        .map((value) => {
          const result =
            clamp && (!clamp.boundedOnly || bounded)
              ? Math.max(clamp.minimum, Math.min(clamp.maximum, value))
              : value

          return `${result}${rule.unit}`
        })
        .join(' ')
    },
  }
}

/** Let the browser resolve authored units/calc() before entering canonical interpolation space. */
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

/** Reference bases used by authored relative endpoints; never include the animated dimension itself. */
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

export function propertyAddresses(element: HTMLElement, property: string): readonly string[] {
  const rule = propertyRule(property)

  if (!rule) return [property]

  // Static components need no CSSOM read; only length aliases depend on writing context.
  return rule.kind === 'length'
    ? resolvePropertyComponents(rule, getComputedStyle(element))
    : rule.components
}

/** Expand compatible inset/logical declarations while keeping authored values and easing intact. */
export function canonicalTracks(
  element: HTMLElement,
  track: import('./resolve.ts').ResolvedTrack,
): readonly import('./resolve.ts').ResolvedTrack[] {
  const rule = propertyRule(track.property)
  if (rule?.kind !== 'length') return [track]
  const addresses = resolvePropertyComponents(rule, getComputedStyle(element))
  if (addresses.length === 1 && addresses[0] === track.property) return [track]

  // Authored longhand names split the CSS value; resolved components determine
  // which physical tracks receive it. Neither step resolves authored units.
  const names = rule.longhands ?? [track.property]
  const split = (value: string): readonly string[] | undefined => {
    const style = element.ownerDocument.createElement('div').style
    style.setProperty(track.property, value)
    const values = names.map((name) => style.getPropertyValue(name))

    return values.every((entry) => entry !== '') ? values : undefined
  }
  const destination = split(track.destinationValue)
  const frames = track.keyframes.map((frame) => split(frame.value))
  if (!destination || frames.some((frame) => frame === undefined)) return [track]

  return addresses.map((property, index) => ({
    ...track,
    property,
    destinationValue: destination[index],
    keyframes: track.keyframes.map((frame, frameIndex) => ({
      ...frame,
      // Every frame was split successfully above, with one value per canonical address.
      value: frames[frameIndex]![index],
    })),
  }))
}
