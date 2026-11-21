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

export type Box = {
  element: HTMLElement
  style: CSSStyleDeclaration
  width: number
  height: number
  own: DOMMatrix
  independent: DOMMatrix
  cssTransform: boolean
  position: string
  offsetParent: Element | null
  scrollX: number
  scrollY: number
  origin: DOMPoint
  linear: DOMMatrix
  center: DOMPoint
}

/** Child links whose parent's scrolling displaces this target's layout box. */
export function effectiveScrollLinks(boxes: readonly Box[]): ReadonlySet<Box> {
  const links = new Set<Box>()
  let containing: Element | null = null

  // Absolute descendants can skip intermediate DOM scrollers until their real
  // containing block. Both local bounds and global projection use this same rule.
  for (let index = boxes.length - 1; index > 0; index--) {
    const child = boxes[index]
    const parent = boxes[index - 1]

    if (child.position === 'absolute') containing = child.offsetParent
    if (containing === null || containing === parent.element) links.add(child)
    if (containing === parent.element) containing = null
  }

  return links
}

function length(value: string, reference: number): number {
  if (value.endsWith('%')) return (parseFloat(value) * reference) / 100
  // CSSOM serializes supported computed lengths as pixels or percentages.
  return parseFloat(value)
}

export function box(
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

  // Engines disagree on percentage transforms for stroke-box on HTML elements.
  // Reject it explicitly rather than silently choosing one engine's reference size.
  if (style.transformBox === 'stroke-box') {
    unsupported('measure does not support stroke-box transforms on HTML elements')
    return undefined
  }

  // For HTML layout boxes, fill-box uses the content box and view-box uses the
  // border box. Percentage translations resolve against this reference box.
  // https://www.w3.org/TR/css-transforms-1/#transform-box
  const contentBox = style.transformBox === 'content-box' || style.transformBox === 'fill-box'
  const insetX = parseFloat(style.paddingLeft) + parseFloat(style.borderLeftWidth)
  const insetY = parseFloat(style.paddingTop) + parseFloat(style.borderTopWidth)
  const referenceWidth = contentBox
    ? width - insetX - parseFloat(style.paddingRight) - parseFloat(style.borderRightWidth)
    : width
  const referenceHeight = contentBox
    ? height - insetY - parseFloat(style.paddingBottom) - parseFloat(style.borderBottomWidth)
    : height
  const own = new DOMMatrix()

  if (style.translate !== 'none') {
    const parts = style.translate.split(/\s+/)
    if (parts.length > 2) {
      unsupported('measure supports two-dimensional numeric transforms')
      return undefined
    }
    own.translateSelf(length(parts[0], referenceWidth), length(parts[1] ?? '0', referenceHeight))
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

  const independent = DOMMatrix.fromMatrix(own)
  if (style.transform !== 'none') own.multiplySelf(new DOMMatrix(style.transform))
  if (!own.is2D) {
    unsupported('measure does not support three-dimensional transforms')
    return undefined
  }

  // Engines can resolve percentage origins against border-box dimensions even when
  // content-box is used for rendering, discarding whether the authored value was
  // a percentage or a length. Without DOM writes the used pivot is ambiguous.
  // Translation-only matrices do not depend on the pivot and remain measurable.
  if (
    contentBox &&
    (referenceWidth !== width || referenceHeight !== height) &&
    (own.a !== 1 || own.b !== 0 || own.c !== 0 || own.d !== 1)
  ) {
    unsupported('measure cannot resolve content-box transform origins for rotation, scale, or skew')
    return undefined
  }

  const parts = style.transformOrigin.split(/\s+/)
  const origin = new DOMPoint(length(parts[0], width), length(parts[1], height))

  return {
    element,
    style,
    width,
    height,
    own,
    independent,
    cssTransform: style.transform !== 'none',
    origin,
    position: style.position,
    offsetParent: style.position === 'absolute' ? element.offsetParent : null,
    scrollX: element.scrollLeft,
    scrollY: element.scrollTop,
  }
}

/** Border-origin displacement in the parent's untransformed, scrolled local axes. */
function relativeOffset(child: Box, parent: Box): { x: number; y: number } {
  // Center differences cancel viewport translation. Undo cumulative ancestor
  // rotation/scale, then undo the child's local transform about its used pivot.
  const inverse = new DOMMatrix([
    parent.linear.a,
    parent.linear.b,
    parent.linear.c,
    parent.linear.d,
    0,
    0,
  ]).inverse()
  const delta = inverse.transformPoint(
    new DOMPoint(child.center.x - parent.center.x, child.center.y - parent.center.y),
  )
  const pivot = child.own.transformPoint(
    new DOMPoint(child.width / 2 - child.origin.x, child.height / 2 - child.origin.y),
  )

  return {
    x: delta.x + parent.width / 2 - pivot.x - child.origin.x,
    y: delta.y + parent.height / 2 - pivot.y - child.origin.y,
  }
}

/**
 * Reads fractional, physical CSS-pixel bounds before transforms and scrolling.
 * Dimensions include the target's padding and border; x/y are measured from the
 * reference's padding-box origin. The reference must be the target or an ancestor.
 * Measuring the target relative to itself returns x=y=0.
 *
 * The target and its full ancestor chain must use supported single-box HTML layout.
 * Unsupported conditions are:
 * - Non-HTML elements (including SVG), inline display, or multiple box fragments.
 * - Fixed/sticky positioning, perspective, 3D transforms, or non-default CSS zoom.
 * - Singular or numerically collapsed cumulative transforms.
 * - HTML transform-box: stroke-box.
 * - Content/fill-box rotation, scaling, or skew when content and border dimensions
 *   differ, because the rendered transform-origin cannot be determined reliably.
 *   Translation-only content/fill-box transforms remain supported.
 * - Unresolvable numeric dimensions or transform expressions, such as a translate
 *   value that retains calc() instead of resolving to supported numeric components.
 * - A reference that is neither the target nor an ancestor.
 *
 * Missing, disconnected, boxless (including display:none), or unsupported geometry
 * returns missingBounds: zero coordinates/dimensions and attached=false. Unsupported
 * conditions additionally call unsupported with their reason; normal absence does
 * not. Visibility:hidden and zero-size boxes remain measurable when otherwise
 * supported. Very small invertible scales can amplify browser rounding errors.
 * This function only reads geometry; observation and publication belong to the caller.
 */
export function readLayoutBounds(
  target: HTMLElement | undefined,
  reference: HTMLElement | undefined,
  unsupported: (reason: string) => void = () => {},
): LayoutBounds {
  if (!target || !reference) return missingBounds

  return new LayoutReadBatch(unsupported).bounds(target, reference)
}

/** One read-only phase. Discard this cache before any DOM/style mutation. */
export class LayoutReadBatch {
  private readonly boxes = new Map<
    HTMLElement,
    { value: Box | undefined; reasons: readonly string[] }
  >()
  private readonly offsets = new Map<HTMLElement, { x: number; y: number }>()

  private readonly unsupported: (reason: string) => void

  constructor(unsupported: (reason: string) => void = () => {}) {
    this.unsupported = unsupported
  }

  protected offset(child: Box, parent: Box) {
    let offset = this.offsets.get(child.element)

    if (!offset) {
      offset = relativeOffset(child, parent)
      this.offsets.set(child.element, offset)
    }

    return offset
  }

  protected chain(target: HTMLElement, unsupported = this.unsupported): Box[] | undefined {
    const chain: HTMLElement[] = []
    let current: HTMLElement | null = target

    while (current) {
      chain.unshift(current)
      current = current.parentElement
    }

    const boxes: Box[] = []
    let linear = new DOMMatrix()

    for (const element of chain) {
      let cached = this.boxes.get(element)

      if (!cached) {
        const reasons: string[] = []
        const dimensions = box(element, (reason) => reasons.push(reason))
        let value: Box | undefined

        if (dimensions) {
          const cumulative = linear.multiply(dimensions.own)

          if (Math.abs(cumulative.a * cumulative.d - cumulative.b * cumulative.c) < 1e-10) {
            reasons.push('measure cannot resolve a singular transform')
          } else {
            const rect = element.getBoundingClientRect()
            const center = new DOMPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
            value = { ...dimensions, linear: cumulative, center }
          }
        }

        cached = { value, reasons }
        this.boxes.set(element, cached)
      }

      const measured = cached.value

      if (!measured) {
        for (const reason of cached.reasons) unsupported(reason)
        return undefined
      }

      boxes.push(measured)
      linear = measured.linear
    }

    return boxes
  }

  bounds(
    target: HTMLElement,
    reference: HTMLElement,
    unsupported = this.unsupported,
  ): LayoutBounds {
    if (!target.isConnected || !reference.isConnected) return missingBounds

    if (!reference.contains(target)) {
      unsupported('measure relativeTo must be the target or an ancestor')
      return missingBounds
    }

    const boxes = this.chain(target, unsupported)
    if (!boxes) return missingBounds

    // Walk from target back to reference, accumulating untransformed parent/child offsets.
    // The validated chain includes both elements; self-measurement skips the loop.
    const measured = boxes[boxes.length - 1]
    const referenceIndex = boxes.findIndex((entry) => entry.element === reference)
    let x = 0
    let y = 0
    const scrolling = effectiveScrollLinks(boxes)

    for (let index = boxes.length - 1; index > referenceIndex; index--) {
      const child = boxes[index]
      const parent = boxes[index - 1]

      const offset = this.offset(child, parent)
      x += offset.x
      y += offset.y

      // Scrolling displaced the viewport geometry but not the layout position.
      // Restore only the scroll offsets selected by the containing-block check above.
      if (scrolling.has(child)) {
        x += parent.scrollX
        y += parent.scrollY
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
}
