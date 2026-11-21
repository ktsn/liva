import type { ProjectionMatrix } from './projection.ts'
import { releaseResources } from '../evaluation/resource-cleanup.ts'
import { batchLayoutWrites } from './layout-write-phase.ts'

/** Natural destination border-box CSS px and cumulative generated local distortion. */
export interface LayoutStyleProjection {
  readonly width: number
  readonly height: number
  readonly distortion: ProjectionMatrix
}

/** One fresh, uncorrected paint snapshot in the current natural destination basis. */
export interface LayoutStyleObservation {
  readonly element: HTMLElement
  read(): void
}

// Paint source inheritance crosses Motion roots. Weak receiver keys retain no
// detached tree after both the native/Executor owners have released it.
const owners = new WeakMap<HTMLElement, () => () => void>()
const animations = new WeakMap<HTMLElement, Set<Animation>>()
// Final/removed sources must invalidate inherited caches even after their last
// native handle disappears. Unchanged paused clocks otherwise retain their cache.
const revisions = new WeakMap<Document, number>()

/** Invalidates retained paint sources without starting work or touching geometry. */
export function changeLayoutStyleSource(element: HTMLElement) {
  const document = element.ownerDocument
  revisions.set(document, (revisions.get(document) ?? 0) + 1)
}

/** Current known Liva paint-source epoch, shared where CSS inheritance crosses applications. */
export function layoutStyleSourceRevision(document: Document): number {
  return revisions.get(document) ?? 0
}

/** Registers the existing temporary owner; stale cleanup cannot unregister a replacement. */
export function ownLayoutStyleSource(element: HTMLElement, prepare: () => () => void): () => void {
  owners.set(element, prepare)

  return () => {
    if (owners.get(element) === prepare) owners.delete(element)
  }
}

/** Known Liva paint effects need source sampling, including through inherited properties. */
export function trackLayoutStyleSource(element: HTMLElement, animation: Animation) {
  let active = animations.get(element)

  if (!active) {
    active = new Set()
    animations.set(element, active)
  }

  if (active.has(animation)) return

  active.add(animation)
  changeLayoutStyleSource(element)
  const remove = () => {
    active.delete(animation)
    changeLayoutStyleSource(element)
    releaseResources([
      () => animation.removeEventListener('finish', remove),
      () => animation.removeEventListener('cancel', remove),
    ])
  }

  try {
    animation.addEventListener('finish', remove, { once: true })
    animation.addEventListener('cancel', remove, { once: true })
  } catch (error) {
    releaseResources([
      () => {
        throw error
      },
      remove,
    ])
  }
}

/** One owned document-timeline source sample; clocks are native effect-local milliseconds. */
export interface LayoutStyleSourceTime {
  readonly animation: Animation
  readonly time: Animation['currentTime']
}

/** Metadata-only source clocks, including ancestors. No style/geometry read or polling loop. */
export function layoutStyleSourceTimes(element: HTMLElement): readonly LayoutStyleSourceTime[] {
  const times: LayoutStyleSourceTime[] = []
  let current: HTMLElement | null = element

  while (current) {
    for (const animation of animations.get(current) ?? [])
      if (animation.playState !== 'idle') times.push({ animation, time: animation.currentTime })
    current = current.parentElement
  }

  return times
}

/**
 * Excludes every relevant temporary paint owner before reading any source and
 * restores all owners before returning. Ancestors are included across runtimes,
 * so CSS inherit never turns generated parent output into a child baseline.
 * Geometry transforms/constraints remain installed. Failed preparation/read still
 * attempts every acquired cleanup and preserves original failure identities.
 */
export function observeLayoutStyles<T>(elements: readonly HTMLElement[], read: () => T): T {
  const prepare = new Set<() => () => void>()

  for (const element of elements) {
    const path: HTMLElement[] = []
    let current: HTMLElement | null = element

    while (current) {
      path.push(current)
      current = current.parentElement
    }

    for (const ancestor of path.toReversed()) {
      const owner = owners.get(ancestor)
      if (owner) prepare.add(owner)
    }
  }

  const restorations: (() => void)[] = []
  let result: T

  releaseResources([
    () => {
      batchLayoutWrites(() => {
        for (const acquire of prepare) restorations.push(acquire())
      })

      result = read()
    },
    () => batchLayoutWrites(() => releaseResources(restorations.toReversed())),
  ])

  // A failed read propagates above; a successful callback assigns result once.
  return result!
}
