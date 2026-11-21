import { LayoutReadBatch, box, effectiveScrollLinks, type Box } from './layout-bounds.ts'
import type { LayoutAbsoluteBox } from './layout-constraints.ts'
import type { ProjectionBox, ProjectionMatrix } from './projection.ts'

/** Extends one read batch with retained transform replay and projection snapshots. */
export class ProjectionReadBatch extends LayoutReadBatch {
  /**
   * Fractional border origin in the document root's scroll-neutral physical plane.
   * Dimensions are target-local CSS px. The frame includes ordinary ancestor 2D
   * transforms/origins and excludes the target's own transform. Missing/unsupported
   * geometry returns undefined with the same support boundaries as measure().
   */
  projection(
    target: HTMLElement,
    transforms?: ReadonlyMap<HTMLElement, TransformSnapshot>,
  ): LayoutProjectionSnapshot | undefined {
    if (!target.isConnected) return undefined

    const boxes = this.chain(target)
    if (!boxes) return undefined

    const scrolling = effectiveScrollLinks(boxes)
    const links = boxes.slice(1).map((child, offset) => {
      const index = offset + 1
      const parent = boxes[index - 1]
      const transform = transforms?.get(parent.element) ?? parent
      const displacement = this.offset(child, parent)
      // This global frame starts at the document border origin. Page scrolling
      // already moves both centers equally and cancels in relativeOffset();
      // adding it again would shift retained trajectories on an unrelated update.
      // Nested scrolling still displaces only the child and must be restored.
      const scroll =
        parent.element !== target.ownerDocument.scrollingElement && scrolling.has(child)
          ? { x: parent.scrollX, y: parent.scrollY }
          : { x: 0, y: 0 }

      return {
        element: parent.element,
        x: displacement.x + scroll.x,
        y: displacement.y + scroll.y,
        origin: { x: transform.origin.x, y: transform.origin.y },
        own: transform.own,
        independent: transform.independent,
      }
    })
    const measured = boxes[boxes.length - 1]
    // Comparison metadata: eight float32 ulps per recovered ancestor center,
    // amplified by its cumulative affine condition number. Returned coordinates
    // are never rounded. Callers compare positions with both snapshots' budgets.
    const positionPrecision = boxes.reduce((precision, entry) => {
      const { a, b, c, d } = entry.linear
      const determinant = Math.abs(a * d - b * c)
      const norm = Math.max(Math.abs(a) + Math.abs(c), Math.abs(b) + Math.abs(d))
      const inverseNorm =
        Math.max(Math.abs(d) + Math.abs(c), Math.abs(b) + Math.abs(a)) / determinant
      const magnitude = Math.max(
        1,
        Math.abs(entry.center.x),
        Math.abs(entry.center.y),
        entry.width,
        entry.height,
      )

      return precision + magnitude * norm * inverseNorm * 2 ** -20
    }, 0)
    const absolute =
      measured.position === 'absolute'
        ? {
            containingBlock: measured.offsetParent,
            inlineSize: measured.style.inlineSize,
            blockSize: measured.style.blockSize,
            paddingInlineStart: measured.style.paddingInlineStart,
            paddingInlineEnd: measured.style.paddingInlineEnd,
            paddingBlockStart: measured.style.paddingBlockStart,
            paddingBlockEnd: measured.style.paddingBlockEnd,
          }
        : undefined
    const snapshot = (excluded: ReadonlySet<HTMLElement>): LayoutProjectionSnapshot => {
      let frame = new DOMMatrix()

      for (const link of links) {
        const own = new DOMMatrix()
          .translate(link.origin.x, link.origin.y)
          .multiply(excluded.has(link.element) ? link.independent : link.own)
          .translate(-link.origin.x, -link.origin.y)
        frame = frame.multiply(own).translate(link.x, link.y)
      }

      return {
        box: { x: frame.e, y: frame.f, width: measured.width, height: measured.height },
        frame,
        origin: { x: measured.origin.x, y: measured.origin.y },
        positionPrecision,
        cssTransform: measured.cssTransform,
        absolute,
        withoutTransforms: snapshot,
      }
    }

    return snapshot(new Set())
  }
}

export interface LayoutProjectionSnapshot {
  readonly box: ProjectionBox
  readonly frame: ProjectionMatrix
  readonly origin: Readonly<{ x: number; y: number }>
  /** Position comparison noise in reference CSS px, including chain conditioning. */
  readonly positionPrecision: number
  /** A non-none CSS transform already establishes the target's containing block. */
  readonly cssTransform: boolean
  /** Used logical CSS sizes (respecting box-sizing/writing-mode), before generated containing blocks. */
  readonly absolute?: LayoutAbsoluteBox
  /** Replays retained numeric links with selected ancestor CSS transform properties overridden. No DOM reads. */
  readonly withoutTransforms: (ancestors: ReadonlySet<HTMLElement>) => LayoutProjectionSnapshot
}

type TransformSnapshot = Pick<Box, 'own' | 'independent' | 'origin'>

/**
 * Captures transform models before an observation-only suspension. Identity keeps
 * existing containing blocks; independent transforms are neutralized together.
 * A fresh LayoutReadBatch then recovers natural offsets without transformed-AABB
 * rounding. Replaying retained matrices reconstructs the original physical frame.
 * The caller owns batched writes/restoration and must complete them before paint.
 */
export class ProjectionReadPhase {
  readonly suspensions: {
    readonly element: HTMLElement
    readonly properties: ReadonlyMap<string, string>
  }[] = []
  private readonly transforms = new Map<HTMLElement, TransformSnapshot>()
  private readonly supported = new Map<HTMLElement, boolean>()
  private readonly viewports = new Map<HTMLElement, { width: number; height: number }>()

  constructor(targets: readonly HTMLElement[]) {
    let observationSafe = true

    for (const target of targets) {
      const chain: HTMLElement[] = []
      let current: HTMLElement | null = target
      while (current) {
        chain.unshift(current)
        current = current.parentElement
      }

      let linear = new DOMMatrix()
      let valid = target.isConnected

      for (const element of chain) {
        let transform = this.transforms.get(element)

        if (!this.supported.has(element)) {
          const dimensions = box(element, () => {})
          transform = dimensions
          this.supported.set(element, dimensions !== undefined)

          if (dimensions) {
            this.transforms.set(element, dimensions)
            const style = dimensions.style
            const properties = new Map<string, string>()

            if (
              [style.transform, style.translate, style.rotate, style.scale].some(
                (value) => value !== 'none',
              )
            ) {
              properties.set('transform', 'matrix(1, 0, 0, 1, 0, 0)')
              properties.set('translate', 'none')
              properties.set('rotate', 'none')
              properties.set('scale', 'none')
            }

            this.viewports.set(element, {
              width: element.clientWidth,
              height: element.clientHeight,
            })
            const scrolling = element.ownerDocument.scrollingElement === element
            // A temporary generic effect can suppress a CSS transition before
            // its first presentation. Keep native transition creation/timing in
            // the read-only path, including idle declarations with a delay.
            const transformTransition =
              style.transitionProperty
                .split(',')
                .some((property) => ['all', 'transform'].includes(property.trim())) &&
              [style.transitionDuration, style.transitionDelay].some((times) =>
                times.split(',').some((time) => parseFloat(time) !== 0),
              )
            if (transformTransition) observationSafe = false
            if (
              [style.overflowX, style.overflowY].some((value) =>
                ['auto', 'scroll', 'hidden'].includes(value),
              ) ||
              (scrolling &&
                (dimensions.scrollX !== 0 ||
                  dimensions.scrollY !== 0 ||
                  element.clientWidth !== element.ownerDocument.defaultView?.innerWidth ||
                  element.clientHeight !== element.ownerDocument.defaultView?.innerHeight))
            )
              observationSafe = false

            if (properties.size > 0) this.suspensions.push({ element, properties })
          }
        }

        if (!transform || !this.supported.get(element)) valid = false
        if (transform) linear = linear.multiply(transform.own)
        if (Math.abs(linear.a * linear.d - linear.b * linear.c) < 1e-10) valid = false
      }

      this.supported.set(target, valid)
    }

    // An identity effect can shrink visual overflow and clamp scroll positions.
    // Restoring the numbers cannot cancel already queued native scroll events.
    // Keep the existing read-only recovery for the whole scene in that case.
    if (!observationSafe) this.suspensions.length = 0
  }

  /** The observation must retain every ancestor's layout viewport, including scrollbar reservations. */
  preservesViewports(): boolean {
    return [...this.viewports].every(
      ([element, viewport]) =>
        element.clientWidth === viewport.width && element.clientHeight === viewport.height,
    )
  }

  /** Checks the browser's winning values; composite order alone cannot defeat important CSS. */
  neutral(element: HTMLElement): boolean {
    const style = getComputedStyle(element)
    const matrix = style.transform === 'none' ? new DOMMatrix() : new DOMMatrix(style.transform)

    return (
      matrix.is2D &&
      matrix.isIdentity &&
      [style.translate, style.rotate, style.scale].every((value) => value === 'none')
    )
  }

  read(target: HTMLElement, batch: ProjectionReadBatch): LayoutProjectionSnapshot | undefined {
    return this.supported.get(target) ? batch.projection(target, this.transforms) : undefined
  }
}
