import { LayoutReadBatch } from './layout-bounds.ts'
import { releaseResources } from '../evaluation/resource-cleanup.ts'

/** Shared per-document geometry reads. Publication never interleaves with the read phase. */
type Registration = {
  /**
   * Reads geometry and returns a callback that publishes the captured snapshot.
   * The scheduler completes every read before invoking any publication callback;
   * change notifications run in a later microtask, after all snapshots are installed.
   * This prevents notification-driven DOM updates from affecting subsequent reads
   * in the same batch, and lets consumers observe the complete batch of snapshots.
   */
  readonly read: (batch: LayoutReadBatch) => () => void
  readonly options: LayoutReadOptions
  active: boolean
}

/** Browser owner hooks for a shared observation phase. Initialization failures still throw. */
export interface LayoutReadOptions {
  /** Include external visual-property edits when a retained projection basis depends on them. */
  readonly visual?: boolean
  /** Remove temporary output before any reader; restore only after all reads/publications. */
  readonly prepare?: () => () => void
  /** Owns asynchronous read/publication/restoration failure cleanup and monitoring. */
  readonly onError?: (error: unknown) => void
}

type InlineChange = { readonly before: string; readonly after: string; readonly generated: boolean }
type InlineObserver = (change: InlineChange) => void

const schedulers = new WeakMap<Document, LayoutScheduler>()
const managedAnimations = new WeakMap<Document, Set<Animation>>()
const visualProperties = new Set(['transform', 'translate', 'rotate', 'scale', 'opacity'])

function layoutStyle(css: string, document: Document): string {
  const style = document.createElement('div').style
  style.cssText = css

  for (const property of visualProperties) style.removeProperty(property)

  return style.cssText
}

class LayoutScheduler {
  private readonly generated = new Map<Element, { before: string; after: string }[]>()
  private readonly registrations = new Set<Registration>()
  private readonly inlineObservers = new Map<Element, Set<InlineObserver>>()
  private readonly observed = new Map<HTMLElement, number>()
  private readonly resize: ResizeObserver
  private readonly mutations: MutationObserver
  private frame: number | undefined
  private readonly view: Window
  private disposed = false
  private inlineNotification = false

  private readonly document: Document

  constructor(document: Document) {
    this.document = document
    const view = document.defaultView
    if (!view) throw new Error('Layout measurement requires a browsing context')

    this.view = view
    this.resize = new ResizeObserver(this.invalidate)
    this.mutations = new MutationObserver((records) => this.changed(records, false))
    this.mutations.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeOldValue: true,
    })
    view.addEventListener('resize', this.invalidate)
    document.addEventListener('load', this.invalidate, true)
    document.fonts.addEventListener('loadingdone', this.invalidate)
    document.fonts.addEventListener('loadingerror', this.invalidate)
  }

  private changed = (records: MutationRecord[], synchronous: boolean) => {
    // Recover each exact new value from its following old-value record, so an
    // external edit between two generated writes is never suppressed with them.
    const following = new Map<Element, string>()
    const styles = new Map<MutationRecord, { element: Element; before: string; after: string }>()

    for (const record of records.toReversed()) {
      if (record.type !== 'attributes' || record.attributeName !== 'style') continue

      // Attribute mutation targets are Elements, also across document realms.
      // eslint-disable-next-line typescript/no-unsafe-type-assertion
      const element = record.target as Element
      const after = following.get(element) ?? element.getAttribute('style') ?? ''
      const before = record.oldValue ?? ''
      styles.set(record, { element, before, after })
      following.set(element, before)
    }

    const visual = [...this.registrations].some((registration) => registration.options.visual)
    let changed = false
    for (const record of records) {
      const style = styles.get(record)
      if (!style) {
        changed = true
        continue
      }

      const writes = this.generated.get(style.element)
      const index =
        writes?.findIndex(
          (write) => write.before === style.before && write.after === style.after,
        ) ?? -1
      const generated = writes !== undefined && index >= 0
      if (generated) writes.splice(index, 1)

      for (const observe of this.inlineObservers.get(style.element) ?? [])
        observe({ ...style, generated })
      if (
        !generated &&
        (visual
          ? style.before !== style.after
          : layoutStyle(style.before, this.document) !== layoutStyle(style.after, this.document))
      )
        changed = true
    }
    this.generated.clear()
    if (changed && synchronous) {
      // takeRecords supplies source order immediately, but must not advance
      // geometry notifications into the middle of an ongoing write transaction.
      if (!this.inlineNotification) {
        this.inlineNotification = true
        queueMicrotask(() => {
          this.inlineNotification = false
          this.invalidate()
        })
      }
    } else if (changed) this.invalidate()
  }

  observeInline(element: HTMLElement, observe: InlineObserver) {
    this.flushInline()
    let observers = this.inlineObservers.get(element)
    if (!observers) {
      observers = new Set()
      this.inlineObservers.set(element, observers)
    }
    observers.add(observe)
    let active = true

    return {
      flush: () => this.flushInline(),
      dispose: () => {
        if (!active) return
        this.flushInline()
        active = false
        observers.delete(observe)
        if (observers.size === 0) this.inlineObservers.delete(element)
        if (this.registrations.size === 0 && this.inlineObservers.size === 0) this.dispose()
      },
    }
  }

  private flushInline() {
    this.changed(this.mutations.takeRecords(), true)
  }

  invalidate = () => {
    if (this.disposed || this.registrations.size === 0 || this.frame !== undefined) return

    this.frame = this.view.requestAnimationFrame(this.flush)
  }

  private flush = () => {
    this.frame = undefined
    if (this.disposed) return

    this.batch([...this.registrations])

    if (
      [...(managedAnimations.get(this.document) ?? [])].some(
        (animation) => animation.playState === 'running',
      )
    )
      this.invalidate()
  }

  /** Every owner restores even when another reader/publication failed. */
  private batch(readers: readonly Registration[], initializing?: Registration) {
    const failed = new Set<Registration>()
    const errors: unknown[] = []
    const restorations: { registration: Registration; restore: () => void }[] = []
    const publications: { registration: Registration; publish: () => void }[] = []
    const run = <T>(registration: Registration, action: () => T): T | undefined => {
      try {
        return action()
      } catch (error) {
        failed.add(registration)

        if (registration === initializing || !registration.options.onError) {
          errors.push(error)
        } else {
          try {
            registration.options.onError(error)
          } catch (handlingError) {
            errors.push(
              new AggregateError([error, handlingError], 'Layout failure handling failed', {
                cause: error,
              }),
            )
          }
        }

        return undefined
      }
    }

    for (const registration of this.registrations) {
      const restore = run(registration, () => registration.options.prepare?.())
      if (restore) restorations.push({ registration, restore })
    }

    // prepare may remove an ancestor correction and change a containing block.
    // Construct the shared cache only after every owner has completed that phase.
    const batch = new LayoutReadBatch()

    for (const registration of readers) {
      if (!registration.active || failed.has(registration)) continue

      const publish = run(registration, () => registration.read(batch))
      if (publish) publications.push({ registration, publish })
    }

    for (const { registration, publish } of publications) {
      if (registration.active) run(registration, publish)
    }

    for (const { registration, restore } of restorations) run(registration, restore)

    // Shared cleanup preserves original identities, and combines independent
    // unhandled failures only after all owners have had their restoration attempt.
    releaseResources(
      errors.map((error) => () => {
        throw error
      }),
    )
  }

  register(
    read: Registration['read'],
    elements: readonly HTMLElement[],
    options: LayoutReadOptions,
  ): () => void {
    const registration = { read, options, active: true }
    this.registrations.add(registration)

    // Initial binding is synchronous so the owning Motion settles before first paint.
    try {
      this.batch([registration], registration)
    } catch (error) {
      this.registrations.delete(registration)
      if (this.registrations.size === 0 && this.inlineObservers.size === 0) this.dispose()

      throw new Error('Initial layout measurement failed', { cause: error })
    }

    for (const element of elements) {
      this.observed.set(element, (this.observed.get(element) ?? 0) + 1)
      this.resize.observe(element)
    }

    return () => {
      if (!registration.active) return

      registration.active = false
      this.registrations.delete(registration)

      for (const element of elements) {
        // Each registration increments these counts before exposing its cleanup.
        const count = this.observed.get(element)! - 1

        if (count === 0) {
          this.observed.delete(element)
          this.resize.unobserve(element)
        } else {
          this.observed.set(element, count)
        }
      }

      if (this.registrations.size === 0 && this.inlineObservers.size === 0) this.dispose()
    }
  }

  write(element: HTMLElement, action: () => void) {
    const before = element.getAttribute('style') ?? ''
    releaseResources([
      action,
      () => {
        const after = element.getAttribute('style') ?? ''
        if (before === after || !this.document.documentElement.contains(element)) return

        const writes = this.generated.get(element) ?? []
        writes.push({ before, after })
        this.generated.set(element, writes)
      },
    ])
  }

  private dispose() {
    this.disposed = true
    if (this.frame !== undefined) this.view.cancelAnimationFrame(this.frame)
    this.resize.disconnect()
    this.mutations.disconnect()
    this.generated.clear()
    this.view.removeEventListener('resize', this.invalidate)
    this.document.removeEventListener('load', this.invalidate, true)
    this.document.fonts.removeEventListener('loadingdone', this.invalidate)
    this.document.fonts.removeEventListener('loadingerror', this.invalidate)
    schedulers.delete(this.document)
  }
}

/**
 * Ordered inline mutation history for the existing temporary style owner. Uses
 * the same document observer as geometry. flush() consumes pending native records
 * synchronously before an owner rewrites/releases; it never reads layout or polls.
 */
export function observeLayoutInline(element: HTMLElement, observe: InlineObserver) {
  const document = element.ownerDocument
  let scheduler = schedulers.get(document)
  if (!scheduler) {
    scheduler = new LayoutScheduler(document)
    schedulers.set(document, scheduler)
  }

  return scheduler.observeInline(element, observe)
}

export function registerLayoutRead(
  document: Document,
  read: Registration['read'],
  elements: readonly HTMLElement[],
  options: LayoutReadOptions = {},
): () => void {
  let scheduler = schedulers.get(document)

  if (!scheduler) {
    scheduler = new LayoutScheduler(document)
    schedulers.set(document, scheduler)
  }

  const cleanup = scheduler.register(read, elements, options)

  if ((managedAnimations.get(document)?.size ?? 0) > 0) scheduler.invalidate()

  return cleanup
}

/** Only Liva-managed layout effects opt into per-frame invalidation. */
export function trackLayoutAnimation(element: HTMLElement, property: string, animation: Animation) {
  if (visualProperties.has(property)) return

  const document = element.ownerDocument
  let active = managedAnimations.get(document)

  if (!active) {
    active = new Set()
    managedAnimations.set(document, active)
  }

  if (active.has(animation)) return

  active.add(animation)
  schedulers.get(document)?.invalidate()

  const remove = () => {
    active.delete(animation)
    animation.removeEventListener('finish', remove)
    animation.removeEventListener('cancel', remove)
    schedulers.get(document)?.invalidate()
  }
  animation.addEventListener('finish', remove, { once: true })
  animation.addEventListener('cancel', remove, { once: true })
}

/** Executor-owned temporary output, excluded from external-layout invalidation. */
export function writeLayoutStyle(element: HTMLElement, action: () => void) {
  const scheduler = schedulers.get(element.ownerDocument)
  if (scheduler) scheduler.write(element, action)
  else action()
}
