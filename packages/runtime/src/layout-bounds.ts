export type LayoutBounds = Readonly<{
  x: number
  y: number
  width: number
  height: number
  attached: boolean
}>

export const missingBounds: LayoutBounds = Object.freeze({
  x: 0,
  y: 0,
  width: 0,
  height: 0,
  attached: false,
})

type Box = {
  element: HTMLElement
  style: CSSStyleDeclaration
  width: number
  height: number
  own: DOMMatrix
  linear: DOMMatrix
  origin: DOMPoint
}

function length(value: string, reference: number): number {
  if (value.endsWith('%')) return (parseFloat(value) * reference) / 100
  // CSSOM serializes supported computed lengths as pixels or percentages.
  return parseFloat(value)
}

function box(
  element: HTMLElement,
  unsupported: (reason: string) => void,
): Omit<Box, 'linear' | 'origin'> | undefined {
  const style = getComputedStyle(element)

  const boxes = element.getClientRects().length
  if (boxes === 0) return undefined

  if (
    boxes !== 1 ||
    element.namespaceURI !== 'http://www.w3.org/1999/xhtml' ||
    style.display === 'inline' ||
    style.position === 'fixed' ||
    style.position === 'sticky' ||
    style.perspective !== 'none' ||
    (style.zoom !== '1' && style.zoom !== 'normal')
  ) {
    unsupported(
      'measure requires single-box HTML layout without fixed/sticky positioning, zoom, or perspective',
    )
    return undefined
  }

  let width = parseFloat(style.width)
  let height = parseFloat(style.height)

  if (style.boxSizing !== 'border-box') {
    width +=
      parseFloat(style.paddingLeft) +
      parseFloat(style.paddingRight) +
      parseFloat(style.borderLeftWidth) +
      parseFloat(style.borderRightWidth)
    height +=
      parseFloat(style.paddingTop) +
      parseFloat(style.paddingBottom) +
      parseFloat(style.borderTopWidth) +
      parseFloat(style.borderBottomWidth)
  }

  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    unsupported('measure cannot resolve numeric border-box dimensions')
    return undefined
  }

  const own = new DOMMatrix()

  if (style.translate !== 'none') {
    const parts = style.translate.split(/\s+/)
    if (parts.length > 2) {
      unsupported('measure supports two-dimensional numeric transforms')
      return undefined
    }
    own.translateSelf(length(parts[0], width), length(parts[1] ?? '0', height))
  }

  if (style.rotate !== 'none') {
    if (!/^[+-]?[\d.]+deg$/.test(style.rotate)) {
      unsupported('measure supports two-dimensional rotation')
      return undefined
    }
    // CSSOM normalizes computed angles (including authored rad/grad/turn) to degrees.
    const degrees = parseFloat(style.rotate)
    own.rotateSelf(degrees)
  }

  if (style.scale !== 'none') {
    const parts = style.scale.split(/\s+/).map(Number)
    if (parts.length > 2) {
      unsupported('measure supports two-dimensional numeric transforms')
      return undefined
    }
    own.scaleSelf(parts[0], parts[1] ?? parts[0])
  }

  if (style.transform !== 'none') own.multiplySelf(new DOMMatrix(style.transform))
  if (!own.is2D) {
    unsupported('measure does not support three-dimensional transforms')
    return undefined
  }

  return { element, style, width, height, own }
}

/** Recover transformed border origins from affine corners, then remove each local transform. */
export function readLayoutBounds(
  target: HTMLElement | undefined,
  reference: HTMLElement | undefined,
  unsupported: (reason: string) => void = () => {},
): LayoutBounds {
  if (!target?.isConnected || !reference?.isConnected) return missingBounds

  if (!reference.contains(target)) {
    unsupported('measure relativeTo must be the target or an ancestor')
    return missingBounds
  }

  const chain: HTMLElement[] = []
  let current: HTMLElement | null = target

  while (current) {
    chain.unshift(current)
    current = current.parentElement
  }

  const boxes: Box[] = []
  let linear = new DOMMatrix()

  for (const element of chain) {
    const dimensions = box(element, unsupported)
    if (!dimensions) return missingBounds

    linear = linear.multiply(dimensions.own)
    if (Math.abs(linear.a * linear.d - linear.b * linear.c) < 1e-10) {
      unsupported('measure cannot resolve a singular transform')
      return missingBounds
    }

    const { width, height } = dimensions
    const rect = element.getBoundingClientRect()
    const origin = new DOMPoint(
      rect.left -
        Math.min(0, linear.a * width, linear.c * height, linear.a * width + linear.c * height),
      rect.top -
        Math.min(0, linear.b * width, linear.d * height, linear.b * width + linear.d * height),
    )
    boxes.push({ ...dimensions, linear, origin })
  }

  // The chain always includes the connected target.
  const measured = boxes[boxes.length - 1]
  const referenceIndex = boxes.findIndex((entry) => entry.element === reference)
  let x = 0
  let y = 0
  let escapedUntil: Element | null = null

  for (let index = boxes.length - 1; index > referenceIndex; index--) {
    const child = boxes[index]
    const parent = boxes[index - 1]

    if (child.style.position === 'absolute') escapedUntil = child.element.offsetParent
    const scrollAffectsTarget = escapedUntil === null || escapedUntil === parent.element
    if (escapedUntil === parent.element) escapedUntil = null
    const inverse = new DOMMatrix([
      parent.linear.a,
      parent.linear.b,
      parent.linear.c,
      parent.linear.d,
      0,
      0,
    ]).inverse()
    const delta = inverse.transformPoint(
      new DOMPoint(child.origin.x - parent.origin.x, child.origin.y - parent.origin.y),
    )
    const origin = child.style.transformOrigin.split(/\s+/)
    const ox = length(origin[0], child.width)
    const oy = length(origin[1], child.height)
    const shiftX = child.own.e + ox - child.own.a * ox - child.own.c * oy
    const shiftY = child.own.f + oy - child.own.b * ox - child.own.d * oy
    // Absolute descendants can escape static scrollers before their containing block.
    x += delta.x - shiftX + (scrollAffectsTarget ? parent.element.scrollLeft : 0)
    y += delta.y - shiftY + (scrollAffectsTarget ? parent.element.scrollTop : 0)
  }

  if (target !== reference) {
    const origin = boxes[referenceIndex]
    x -= parseFloat(origin.style.borderLeftWidth)
    y -= parseFloat(origin.style.borderTopWidth)
  }

  return Object.freeze({ x, y, width: measured.width, height: measured.height, attached: true })
}
