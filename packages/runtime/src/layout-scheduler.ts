/** Shared per-document geometry reads. Publication never interleaves with the read phase. */
type Registration = {
  /**
   * Reads geometry and returns a callback that publishes the captured snapshot.
   * The scheduler completes every read before invoking any publication callback;
   * change notifications run in a later microtask, after all snapshots are installed.
   * This prevents notification-driven DOM updates from affecting subsequent reads
   * in the same batch, and lets consumers observe the complete batch of snapshots.
   */
  readonly read: () => () => void
  active: boolean
}

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
  private readonly registrations = new Set<Registration>()
  private readonly observed = new Map<HTMLElement, number>()
  private readonly resize: ResizeObserver
  private readonly mutations: MutationObserver
  private frame: number | undefined
  private readonly view: Window
  private disposed = false

  private readonly document: Document

  constructor(document: Document) {
    this.document = document
    const view = document.defaultView
    if (!view) throw new Error('Layout measurement requires a browsing context')

    this.view = view
    this.resize = new ResizeObserver(this.invalidate)
    this.mutations = new MutationObserver((records) => {
      if (
        records.some((record) => {
          if (record.type !== 'attributes' || record.attributeName !== 'style') return true

          return (
            layoutStyle(record.oldValue ?? '', document) !==
            // Attribute mutation records always target Elements, including other document realms.
            // eslint-disable-next-line typescript/no-unsafe-type-assertion
            layoutStyle((record.target as Element).getAttribute('style') ?? '', document)
          )
        })
      )
        this.invalidate()
    })
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

  invalidate = () => {
    if (this.disposed || this.frame !== undefined) return

    this.frame = this.view.requestAnimationFrame(this.flush)
  }

  private flush = () => {
    this.frame = undefined
    if (this.disposed) return

    const publications: (() => void)[] = []

    for (const registration of this.registrations) {
      publications.push(registration.read())
    }

    // Each publication first installs its snapshot; notifications run in a microtask afterwards.
    for (const publish of publications) publish()

    if (
      [...(managedAnimations.get(this.document) ?? [])].some(
        (animation) => animation.playState === 'running',
      )
    ) {
      this.invalidate()
    }
  }

  register(read: Registration['read'], elements: readonly HTMLElement[]): () => void {
    const registration = { read, active: true }
    this.registrations.add(registration)

    // Initial binding is synchronous so the owning Motion settles before first paint.
    try {
      read()()
    } catch (error) {
      this.registrations.delete(registration)
      if (this.registrations.size === 0) this.dispose()

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

      if (this.registrations.size === 0) this.dispose()
    }
  }

  private dispose() {
    this.disposed = true
    if (this.frame !== undefined) this.view.cancelAnimationFrame(this.frame)
    this.resize.disconnect()
    this.mutations.disconnect()
    this.view.removeEventListener('resize', this.invalidate)
    this.document.removeEventListener('load', this.invalidate, true)
    this.document.fonts.removeEventListener('loadingdone', this.invalidate)
    this.document.fonts.removeEventListener('loadingerror', this.invalidate)
    schedulers.delete(this.document)
  }
}

export function registerLayoutRead(
  document: Document,
  read: Registration['read'],
  elements: readonly HTMLElement[],
): () => void {
  let scheduler = schedulers.get(document)

  if (!scheduler) {
    scheduler = new LayoutScheduler(document)
    schedulers.set(document, scheduler)
  }

  const cleanup = scheduler.register(read, elements)

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
