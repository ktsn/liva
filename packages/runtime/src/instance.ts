import type { Definition } from './definition.ts'
import { getState, resolve, type ResolvedTrack } from './resolve.ts'
import { sampleSpring } from './spring.ts'

export interface RuntimeDiagnostic {
  readonly code: string
  readonly message: string
  readonly track?: ResolvedTrack
  readonly error?: unknown
}

type InlineValue = { value: string; priority: string }
type OwnedElement = {
  element: HTMLElement
  original: Map<string, InlineValue>
  originalCss: string
  pending: Map<string, { property: string; value: string; priority: string }>
  written: Map<string, InlineValue>
}

function inlineDeclarations(element: HTMLElement): Map<string, InlineValue> {
  return new Map(
    Array.from(element.style).map((property) => [
      property,
      {
        value: element.style.getPropertyValue(property),
        priority: element.style.getPropertyPriority(property),
      },
    ]),
  )
}

type ActiveTrack = { track: ResolvedTrack; element: HTMLElement; animation: Animation }

export function waapiProperty(property: string): string {
  if (property.startsWith('--')) {
    return property
  }

  if (property === 'offset') return 'cssOffset'
  if (property === 'float') return 'cssFloat'
  // Metadata names have no CSS counterpart/WAAPI alias. Kebab spelling prevents
  // them from overwriting effect metadata while still reaching the browser.
  if (property === 'easing' || property === 'composite') return `-${property}`

  return property.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())
}

export class LivaInstance {
  definition: Definition
  state: string
  private targets = new Map<string, HTMLElement>()
  private active: ActiveTrack[] = []
  private owned: OwnedElement[] = []
  private generation = 0
  private manuallyPaused = false
  private disposed = false
  private suspended = true
  private duplicateBindings = false
  private readonly motion: MediaQueryList
  private readonly report: (diagnostic: RuntimeDiagnostic) => void

  constructor(
    definition: Definition,
    state: string,
    report: (diagnostic: RuntimeDiagnostic) => void = console.warn,
  ) {
    getState(definition, state)
    this.definition = definition
    this.state = state
    this.report = report
    this.motion = matchMedia('(prefers-reduced-motion: reduce)')
    this.motion.addEventListener('change', this.motionChanged)
  }

  get animations(): readonly Animation[] {
    return this.active.map((a) => a.animation)
  }

  private motionChanged = () => {
    if (this.motion.matches && !this.manuallyPaused) {
      this.cancel()
      this.settle()
    }
  }

  private cancel() {
    this.generation++
    this.manuallyPaused = false

    for (const { animation } of this.active) {
      animation.cancel()
    }

    this.active = []
  }

  private write(element: HTMLElement, property: string, value: string) {
    const before = inlineDeclarations(element)
    let owned = this.owned.find((o) => o.element === element)

    if (!owned) {
      owned = {
        element,
        original: before,
        originalCss: element.style.cssText,
        pending: new Map(),
        written: new Map(),
      }
      this.owned.push(owned)
    }

    const beforeCss = element.style.cssText
    element.style.setProperty(property, value)
    const after = inlineDeclarations(element)

    const pending = document.createElement('div')
    if (beforeCss !== element.style.cssText) {
      pending.style.setProperty(property, value)
    }
    const pendingNames = new Set(
      Array.from(pending.style).filter((name) => pending.style.getPropertyValue(name) === ''),
    )

    // CSSOM enumerates the affected longhands, including shorthand side effects.
    for (const name of new Set([...before.keys(), ...after.keys()])) {
      const previous = before.get(name)
      const next = after.get(name)

      if (
        pendingNames.has(name) ||
        previous?.value !== next?.value ||
        previous?.priority !== next?.priority
      ) {
        owned.written.set(name, next ?? { value: '', priority: '' })

        if (pendingNames.has(name)) {
          owned.pending.set(name, {
            property,
            value: element.style.getPropertyValue(property),
            priority: element.style.getPropertyPriority(property),
          })
        } else {
          owned.pending.delete(name)
        }
      }
    }
  }

  private restore() {
    for (const { element, original, originalCss, pending, written } of this.owned) {
      const current = inlineDeclarations(element)
      const baseline = document.createElement('div')
      const external = document.createElement('div')
      baseline.style.cssText = originalCss
      external.style.cssText = element.style.cssText
      const stillOwned = new Set<string>()

      for (const [property, last] of written) {
        const value = current.get(property) ?? { value: '', priority: '' }
        const signature = pending.get(property)
        const pendingChanged =
          signature !== undefined &&
          (element.style.getPropertyValue(signature.property) !== signature.value ||
            element.style.getPropertyPriority(signature.property) !== signature.priority)

        if (!pendingChanged && value.value === last.value && value.priority === last.priority) {
          stillOwned.add(property)
          external.style.removeProperty(property)
        }
      }

      for (const property of original.keys()) {
        if (!stillOwned.has(property) && !current.has(property)) {
          baseline.style.removeProperty(property)
        }
      }

      for (const property of Array.from(external.style)) {
        baseline.style.removeProperty(property)
      }

      // Restore the intact original serialization, then overlay external writes.
      // This retains var()-valued shorthands that CSSOM cannot expose as longhands.
      element.style.cssText = baseline.style.cssText + ';' + external.style.cssText
    }

    this.owned = []
  }

  private settle() {
    if (this.suspended || this.disposed) return

    for (const target of getState(this.definition, this.state).targets) {
      const element = this.targets.get(target.name)!

      for (const property of target.properties) {
        this.write(element, property.name, property.value)
      }
    }
  }

  bind(entries: readonly (readonly [string, HTMLElement])[]) {
    if (this.disposed) return

    const next = new Map(entries)
    const duplicate = next.size !== entries.length
    const missing = this.definition.states.some((state) =>
      state.targets.some((target) => !next.has(target.name)),
    )
    const unchanged =
      !duplicate &&
      !missing &&
      !this.suspended &&
      next.size === this.targets.size &&
      [...next].every(([key, value]) => this.targets.get(key) === value)

    if (unchanged) return

    this.cancel()
    this.restore()
    this.targets = next
    this.duplicateBindings = duplicate
    this.suspended = duplicate || missing

    if (this.suspended) {
      this.report({
        code: 'runtime.targets',
        message: duplicate ? 'Duplicate target binding' : 'Missing target binding',
      })
    } else {
      this.settle()
    }
  }

  replaceDefinition(definition: Definition, state = this.state) {
    if (this.disposed) return
    getState(definition, state)
    this.cancel()
    this.restore()
    this.definition = definition
    this.state = state
    this.suspended =
      this.duplicateBindings ||
      definition.states.some((s) => s.targets.some((t) => !this.targets.has(t.name)))
    this.settle()
  }

  setState(state: string, options: { paused?: boolean } = {}): boolean {
    if (this.disposed) return false

    let tracks: ResolvedTrack[]

    try {
      tracks = resolve(this.definition, this.state, state)
    } catch (error) {
      this.report({ code: 'runtime.state', message: String(error), error })
      return false
    }

    if (state === this.state) return true

    if (this.suspended || (this.motion.matches && !options.paused)) {
      this.state = state
      this.cancel()
      this.settle()
      return true
    }

    const interrupted = this.active.length > 0
    const snapshots = new Map<HTMLElement, Map<string, string>>()

    // Read every displayed value before canceling any effect or writing styles.
    for (const { track, element } of [
      ...this.active,
      ...tracks.map((track) => ({ track, element: this.targets.get(track.target)! })),
    ]) {
      let properties = snapshots.get(element)

      if (!properties) {
        properties = new Map()
        snapshots.set(element, properties)
      }

      properties.set(track.property, getComputedStyle(element).getPropertyValue(track.property))
    }

    const prepared: ActiveTrack[] = []
    let preparing: ResolvedTrack | undefined

    try {
      for (const track of tracks) {
        preparing = track
        const element = this.targets.get(track.target)!
        const timing =
          track.timing.kind === 'tween'
            ? { durationMs: track.timing.durationMs, easing: 'linear' }
            : sampleSpring(track.timing)

        if (timing.durationMs === 0) continue

        const frames = track.keyframes.map((frame, index) => ({
          [waapiProperty(track.property)]:
            interrupted && index === 0 ? snapshots.get(element)!.get(track.property)! : frame.value,
          offset: frame.offset,
          easing: frame.easing,
        }))
        const effect = new KeyframeEffect(element, frames, {
          duration: timing.durationMs,
          easing: timing.easing,
          fill: options.paused ? 'backwards' : 'both',
        })
        const animation = new Animation(effect, document.timeline)
        prepared.push({ track, element, animation })
      }
    } catch (error) {
      for (const { animation } of prepared) animation.cancel()
      this.report({ code: 'runtime.animation', message: String(error), track: preparing, error })
      return false
    }

    this.cancel()
    this.state = state
    const generation = this.generation
    this.settle()

    for (const { track, element } of options.paused ? [] : prepared) {
      this.write(element, track.property, snapshots.get(element)!.get(track.property)!)
    }

    this.active = prepared
    this.manuallyPaused = options.paused ?? false
    const start = document.timeline.currentTime

    try {
      for (const entry of prepared) {
        const { animation, track, element } = entry
        if (options.paused) {
          animation.pause()
          animation.currentTime = 0
          continue
        }

        animation.play()
        if (typeof start === 'number') animation.startTime = start

        void animation.finished
          .then(() => {
            if (this.disposed || generation !== this.generation) return
            this.write(element, track.property, track.destinationValue)
            animation.cancel()
            this.active = this.active.filter((a) => a !== entry)
          })
          .catch(() => {})
      }
    } catch (error) {
      this.cancel()
      this.settle()
      this.report({ code: 'runtime.animation', message: String(error), track: preparing, error })
      return false
    }

    return true
  }

  dispose() {
    if (this.disposed) return
    this.cancel()
    this.restore()
    this.motion.removeEventListener('change', this.motionChanged)
    this.targets.clear()
    this.disposed = true
  }
}
