import { parameterValues, LetBindingGraph, targetValues } from './let-bindings.ts'
import { renderDefinition, renderValue, selectState, type VariableValues } from './expression.ts'
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
  private values: VariableValues = {}
  private letBindings: LetBindingGraph
  private letBindingCleanups: (() => void)[] = []
  onReactiveState?: (state: string) => void
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
    state: string | Readonly<Record<string, unknown>> = {},
    report: (diagnostic: RuntimeDiagnostic) => void = console.warn,
  ) {
    const variables = parameterValues(
      definition.parameters ?? [],
      targetValues(definition),
      typeof state === 'string' ? {} : state,
    )
    this.letBindings = new LetBindingGraph(definition.letBindings ?? [], variables)
    this.values = this.letBindings.evaluate(variables)
    this.definition = definition
    this.state = typeof state === 'string' ? state : selectState(definition, this.values)
    getState(definition, this.state)
    this.report = report
    this.motion = matchMedia('(prefers-reduced-motion: reduce)')
    this.motion.addEventListener('change', this.motionChanged)
  }

  get reactiveState(): string {
    return selectState(this.definition, this.values)
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
        try {
          this.write(element, property.name, renderValue(property, this.values))
        } catch (error) {
          this.report({ code: 'runtime.expression', message: String(error), error })
        }
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

    this.clearLetBindings()
    this.cancel()
    this.restore()
    this.targets = next
    this.duplicateBindings = duplicate
    this.suspended = duplicate || missing

    if (this.definition.letBindings?.length || this.definition.parameters?.length) {
      this.state = selectState(this.definition, this.values)
      this.onReactiveState?.(this.state)
    }

    if (this.suspended) {
      this.report({
        code: 'runtime.targets',
        message: duplicate ? 'Duplicate target binding' : 'Missing target binding',
      })
    } else {
      this.bindLetBindings()
      this.settle()
    }
  }

  replaceDefinition(definition: Definition, state = this.state) {
    if (this.disposed) return
    getState(definition, state)
    const inputs = Object.fromEntries(
      (definition.parameters ?? [])
        .filter((parameter) =>
          this.definition.parameters?.some((previous) => previous.name === parameter.name),
        )
        .map((parameter) => [parameter.name, this.values[parameter.name]]),
    )
    const variables = parameterValues(
      definition.parameters ?? [],
      targetValues(definition, this.values),
      inputs,
    )
    const letBindings = new LetBindingGraph(
      definition.letBindings ?? [],
      variables,
      this.letBindings,
    )

    this.clearLetBindings()
    this.cancel()
    this.restore()

    this.letBindings = letBindings
    this.values = letBindings.evaluate(variables)
    this.definition = definition
    this.state = state
    this.suspended =
      this.duplicateBindings ||
      definition.states.some((s) => s.targets.some((t) => !this.targets.has(t.name)))
    if (!this.suspended) this.bindLetBindings()
    this.settle()
  }

  setState(state: string, options: { paused?: boolean } = {}): boolean {
    return this.transitionTo(state, options, this.values)
  }

  private transitionTo(
    state: string,
    options: { paused?: boolean },
    previousValues: VariableValues,
  ): boolean {
    if (this.disposed) return false

    let tracks: ResolvedTrack[]

    try {
      tracks = resolve(
        renderDefinition(
          renderDefinition(this.definition, previousValues, [this.state]),
          this.values,
          [state],
        ),
        this.state,
        state,
      )
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

    const interrupted =
      this.active.length > 0 ||
      (this.definition.letBindings?.length ?? 0) + (this.definition.parameters?.length ?? 0) > 0
    const snapshots = new Map<HTMLElement, Map<string, string>>()

    // Read every displayed value before canceling any effect or writing styles.
    for (const { track, element } of [
      ...this.active,
      ...tracks.map((candidate) => ({
        track: candidate,
        element: this.targets.get(candidate.target)!,
      })),
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
            if (this.disposed || generation !== this.generation || !this.active.includes(entry))
              return undefined
            this.write(element, track.property, track.destinationValue)
            animation.cancel()
            this.active = this.active.filter((a) => a !== entry)
            return undefined
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

  updateParameters(inputs: Readonly<Record<string, unknown>>) {
    if (this.disposed) return

    try {
      this.applyVariableValues(
        parameterValues(this.definition.parameters ?? [], this.values, inputs),
      )
    } catch (error) {
      this.report({ code: 'runtime.parameter', message: String(error), error })
    }
  }

  private applyVariableValues(values: VariableValues) {
    const previous = this.values

    try {
      values = this.letBindings.evaluate(values)
      const state = selectState(this.definition, values)
      const properties = getState(this.definition, state).targets.flatMap((target) =>
        target.properties
          .filter((property) => property.template)
          .map((property) => ({
            target: target.name,
            property,
            value: renderValue(property, values),
          })),
      )
      this.values = values

      if (state !== this.state) {
        if (!this.transitionTo(state, {}, previous)) {
          this.values = previous
          return
        }
      } else if (!this.suspended) {
        for (const { target, property, value } of properties) {
          let unchanged = false

          try {
            unchanged = value === renderValue(property, previous)
          } catch {
            // A valid update can recover a template that failed during initial settlement.
          }

          if (unchanged) continue
          const replaced = this.active.filter(
            (entry) => entry.track.target === target && entry.track.property === property.name,
          )
          this.active = this.active.filter((entry) => !replaced.includes(entry))
          for (const entry of replaced) entry.animation.cancel()
          this.write(this.targets.get(target)!, property.name, value)
        }
      }

      this.onReactiveState?.(state)
    } catch (error) {
      this.values = previous
      this.report({ code: 'runtime.expression', message: String(error), error })
    }
  }

  private clearLetBindings() {
    const cleanups = this.letBindingCleanups
    this.letBindingCleanups = []
    for (const cleanup of cleanups) cleanup()

    try {
      this.values = this.letBindings.evaluate(this.values)
    } catch (error) {
      this.report({ code: 'runtime.expression', message: String(error), error })
    }
  }

  private bindLetBindings() {
    this.letBindingCleanups.push(
      ...this.letBindings.bind(this.targets, () => this.applyVariableValues(this.values)),
    )
  }

  dispose() {
    if (this.disposed) return
    this.clearLetBindings()
    this.cancel()
    this.restore()
    this.motion.removeEventListener('change', this.motionChanged)
    this.targets.clear()
    this.disposed = true
  }
}
