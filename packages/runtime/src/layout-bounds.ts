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
  center: DOMPoint
}

function length(value: string, reference: number): number {
  if (value.endsWith('%')) return (parseFloat(value) * reference) / 100
  // CSSOM serializes supported computed lengths as pixels or percentages.
  return parseFloat(value)
}

function box(
  element: HTMLElement,
  unsupported: (reason: string) => void,
): Omit<Box, 'linear' | 'center'> | undefined {
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

/**
 * Reads fractional, physical CSS-pixel bounds before transforms and scrolling.
 * Dimensions include the target's padding and border; x/y are measured from the
 * reference's padding-box origin. The reference must be the target or an ancestor.
 * Measuring the target relative to itself returns x=y=0.
 *
 * Missing, disconnected, or unsupported boxes return missingBounds. Unsupported
 * geometry additionally calls unsupported with its reason. This function only
 * reads geometry; observation and change publication belong to the caller.
 */
export function readLayoutBounds(
  target: HTMLElement | undefined,
  reference: HTMLElement | undefined,
  unsupported: (reason: string) => void = () => {},
): LayoutBounds {
  // Validate the coordinate relationship before reading geometry. Absence is an
  // ordinary lifecycle condition; an unrelated reference is an unsupported request.
  if (!target?.isConnected || !reference?.isConnected) return missingBounds

  if (!reference.contains(target)) {
    unsupported('measure relativeTo must be the target or an ancestor')
    return missingBounds
  }

  // Build a root-to-target chain so transforms can be composed in ancestor order.
  // Stopping at reference would miss transforms applied above that reference.
  const chain: HTMLElement[] = []
  let current: HTMLElement | null = target

  while (current) {
    chain.unshift(current)
    current = current.parentElement
  }

  // Capture untransformed border-box sizes, local 2D transforms, and viewport centers.
  // box() rejects layout outside the supported 2D model.
  const boxes: Box[] = []
  let linear = new DOMMatrix()

  for (const element of chain) {
    const dimensions = box(element, unsupported)
    if (!dimensions) return missingBounds

    // The a/b/c/d components map this element's local vectors into viewport axes.
    // A collapsed transform cannot be inverted, so its layout cannot be recovered.
    linear = linear.multiply(dimensions.own)
    if (Math.abs(linear.a * linear.d - linear.b * linear.c) < 1e-10) {
      unsupported('measure cannot resolve a singular transform')
      return missingBounds
    }

    const rect = element.getBoundingClientRect()
    // Rotation/skew can move the bounding rectangle's top-left away from every
    // corner of the element. An affine-transformed box and its axis-aligned bounds
    // share a center, so no corner reconstruction is needed.
    const center = new DOMPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
    boxes.push({ ...dimensions, linear, center })
  }

  // Walk from target back to reference, accumulating untransformed parent/child offsets.
  // The validated chain includes both elements; self-measurement skips the loop.
  const measured = boxes[boxes.length - 1]
  const referenceIndex = boxes.findIndex((entry) => entry.element === reference)
  let x = 0
  let y = 0
  let escapedUntil: Element | null = null

  for (let index = boxes.length - 1; index > referenceIndex; index--) {
    const child = boxes[index]
    const parent = boxes[index - 1]

    // An absolute box can use a containing block above its DOM parent. Ignore
    // intermediate scrolling until that containing block is reached, then resume
    // the usual scroll correction for its ancestors.
    if (child.style.position === 'absolute') escapedUntil = child.element.offsetParent
    const scrollAffectsTarget = escapedUntil === null || escapedUntil === parent.element
    if (escapedUntil === parent.element) escapedUntil = null

    // Transform a displacement, not an absolute point: common viewport translation
    // has already canceled in the center difference, so retain only the linear part.
    const inverse = new DOMMatrix([
      parent.linear.a,
      parent.linear.b,
      parent.linear.c,
      parent.linear.d,
      0,
      0,
    ]).inverse()

    // Undo the parent/ancestor rotation, scale, and skew to express the difference
    // in the parent's untransformed CSS-pixel axes.
    const delta = inverse.transformPoint(
      new DOMPoint(child.center.x - parent.center.x, child.center.y - parent.center.y),
    )

    // Locate the child's transformed center relative to its own border origin.
    // Subtract transform-origin before applying the local matrix and add it back
    // afterwards, matching the pivot used by CSS (including percentage origins).
    const origin = child.style.transformOrigin.split(/\s+/)
    const ox = length(origin[0], child.width)
    const oy = length(origin[1], child.height)
    const transformedCenter = child.own.transformPoint(
      new DOMPoint(child.width / 2 - ox, child.height / 2 - oy),
    )
    transformedCenter.x += ox
    transformedCenter.y += oy

    // The measured difference connects centers. Adding the parent's natural center
    // and subtracting the child's transformed center leaves their border-origin
    // displacement with the child's transform removed.
    x += delta.x + parent.width / 2 - transformedCenter.x
    y += delta.y + parent.height / 2 - transformedCenter.y

    // Scrolling displaced the viewport geometry but not the layout position.
    // Restore only the scroll offsets selected by the containing-block check above.
    if (scrollAffectsTarget) {
      x += parent.element.scrollLeft
      y += parent.element.scrollTop
    }
  }

  // The accumulated offsets use border origins. Shift into the reference's padding
  // box by removing its border, except when self-measurement must remain at zero.
  if (target !== reference) {
    const origin = boxes[referenceIndex]
    x -= parseFloat(origin.style.borderLeftWidth)
    y -= parseFloat(origin.style.borderTopWidth)
  }

  // Publish a value snapshot; dimensions come directly from the untransformed target
  // box rather than from its potentially rotated or scaled viewport rectangle. No
  // integer rounding is applied; browser geometry and transform precision can still
  // introduce small numeric errors.
  return Object.freeze({ x, y, width: measured.width, height: measured.height, attached: true })
}
