import { waapiProperty } from './animation.ts'
export { waapiProperty } from './animation.ts'
import { parameterValues, LetBindingGraph, targetValues } from './let-bindings.ts'
import {
  evaluate,
  renderDefinition,
  renderValue,
  selectState,
  type VariableValues,
} from './expression.ts'
import type { Definition } from './definition.ts'
import { getState, resolve, type ResolvedTrack } from './resolve.ts'
import {
  resolveLifecycle,
  captureLifecycleDefinition,
  hasLifecycle,
  type LifecycleSession,
} from './lifecycle.ts'
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

export class LivaInstance {
  definition: Definition
  state: string
  private values: VariableValues = {}
  private letBindings: LetBindingGraph
  private letBindingCleanups: (() => void)[] = []
  onReactiveState?: (state: string) => void
  onEvent?: (name: string) => void
  private eventValues = new Map<string, boolean>()
  private targets = new Map<string, HTMLElement>()
  private targetElements = new Map<string, HTMLElement[]>()
  private active: ActiveTrack[] = []
  private enterSessions = new Set<LifecycleSession>()
  private leaveSessions = new Set<LifecycleSession>()
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
    this.evaluateEvents(false)
    this.state = typeof state === 'string' ? state : selectState(definition, this.values)
    getState(definition, this.state)
    this.report = report
    this.motion = matchMedia('(prefers-reduced-motion: reduce)')
    this.motion.addEventListener('change', this.motionChanged)
  }

  retainLifecycle(phase: 'enter' | 'leave', session: LifecycleSession) {
    const sessions = phase === 'enter' ? this.enterSessions : this.leaveSessions
    sessions.add(session)
    void session.finished.then(() => sessions.delete(session))
  }

  captureLifecycle(phase: 'enter' | 'leave', names: readonly string[], element?: HTMLElement) {
    const definition = renderDefinition(this.definition, this.values, [this.state])
    const targets = new Map(
      [...this.targets]
        .filter(([name]) => names.includes(name))
        .map(([name, target]) => [name, element ?? target]),
    )
    const work = resolveLifecycle(
      phase,
      captureLifecycleDefinition(definition, phase, this.state, this.values),
      getState(definition, this.state),
      targets,
    )

    return work
  }

  releaseLifecycle(names: readonly string[], element: HTMLElement) {
    const interrupted = this.active.filter(
      (entry) => names.includes(entry.track.target) && entry.element === element,
    )
    this.active = this.active.filter((entry) => !interrupted.includes(entry))
    for (const entry of interrupted) entry.animation.cancel()
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

  private cancel(cancelEnter = true) {
    if (cancelEnter) {
      for (const session of this.enterSessions) session.cancel('superseded')
      this.enterSessions.clear()
    }
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
      for (const element of this.targetElements.get(target.name) ?? []) {
        for (const property of target.properties) {
          try {
            this.write(element, property.name, renderValue(property, this.values))
          } catch (error) {
            this.report({ code: 'runtime.expression', message: String(error), error })
          }
        }
      }
    }
  }

  bind(entries: readonly (readonly [string, HTMLElement])[]) {
    if (this.disposed) return

    const next = new Map(entries)
    const duplicate = next.size !== entries.length && !hasLifecycle(this.definition)
    const missing = this.definition.states.some((state) =>
      state.targets.some((target) => !next.has(target.name)),
    )
    const unchanged =
      !duplicate &&
      (!missing || hasLifecycle(this.definition)) &&
      !this.suspended &&
      entries.length === [...this.targetElements.values()].flat().length &&
      entries.every(([key, value]) => this.targetElements.get(key)?.includes(value))

    if (unchanged) return

    this.clearLetBindings()
    this.cancel(false)
    this.restore()
    this.targets = next
    this.targetElements.clear()
    for (const [name, element] of entries) {
      const elements = this.targetElements.get(name) ?? []
      elements.push(element)
      this.targetElements.set(name, elements)
    }
    this.duplicateBindings = duplicate
    this.suspended = duplicate || (missing && !hasLifecycle(this.definition))

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
    this.eventValues.clear()
    this.evaluateEvents(false)
    this.state = state
    this.suspended =
      this.duplicateBindings ||
      (!hasLifecycle(definition) &&
        definition.states.some((s) => s.targets.some((t) => !this.targets.has(t.name))))
    if (!this.suspended) this.bindLetBindings()
    this.settle()
  }

  setState(state: string, options: { paused?: boolean } = {}): boolean {
    return this.transitionTo(state, options, this.values)
  }

  /** Prepare scrub-ready lifecycle effects without invoking presence removal callbacks. */
  previewLifecycle(phase: 'enter' | 'leave'): boolean {
    if (this.disposed || this.suspended) return false

    const prepared: ActiveTrack[] = []

    try {
      const work = [...this.targetElements].flatMap(([name, elements]) =>
        elements.flatMap((element) => this.captureLifecycle(phase, [name], element)),
      )

      for (const { track, element } of work) {
        const timing =
          track.timing.kind === 'tween'
            ? { durationMs: track.timing.durationMs, easing: 'linear' }
            : sampleSpring(track.timing)
        const effect = new KeyframeEffect(
          element,
          track.keyframes.map((frame) => ({
            [waapiProperty(track.property)]: frame.value,
            offset: frame.offset,
            easing: frame.easing,
          })),
          {
            duration: timing.durationMs,
            easing: timing.easing,
            fill: phase === 'enter' ? 'backwards' : 'both',
          },
        )
        const animation = new Animation(effect, document.timeline)

        prepared.push({ track, element, animation })
      }

      this.cancel()
      this.active = prepared
      this.manuallyPaused = true

      for (const { animation } of prepared) {
        animation.pause()
        animation.currentTime = 0
      }

      return true
    } catch (error) {
      for (const { animation } of prepared) animation.cancel()

      this.report({ code: 'runtime.animation', message: String(error), error })
      return false
    }
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
        this.values,
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

    tracks = tracks.filter((track) => this.targets.has(track.target))

    const interrupted =
      this.enterSessions.size > 0 ||
      this.active.length > 0 ||
      (this.definition.letBindings?.length ?? 0) + (this.definition.parameters?.length ?? 0) > 0
    const snapshots = new Map<HTMLElement, Map<string, string>>()

    const boundTracks = tracks.flatMap((track) =>
      /* v8 ignore start -- @preserve: Tracks were filtered against targets, which bind populates together with targetElements. */
      (this.targetElements.get(track.target) ?? [])
        /* v8 ignore stop -- @preserve */
        .filter(
          (element) =>
            ![...this.leaveSessions].some((session) => session.owns(element, track.property)),
        )
        .map((element) => ({ track, element })),
    )

    // Read every displayed value before canceling any effect or writing styles.
    for (const { track, element } of [...this.active, ...boundTracks]) {
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
      for (const { track, element } of boundTracks) {
        preparing = track
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
        /* v8 ignore else -- @preserve: The active document timeline has a numeric currentTime; null belongs to inactive documents. */
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
    } catch (error) /* v8 ignore next -- @preserve: Effects are already constructed on the document timeline; synchronous playback failure requires replacing browser APIs. */ {
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

  private evaluateEvents(emit = true) {
    const pending: string[] = []

    for (const event of this.definition.events ?? []) {
      const next = evaluate(event.when, this.values) === true
      if (emit && next && this.eventValues.get(event.name) === false) pending.push(event.name)
      this.eventValues.set(event.name, next)
    }

    for (const name of pending) this.onEvent?.(name)
  }

  private applyVariableValues(values: VariableValues) {
    const previous = this.values

    try {
      values = this.letBindings.evaluate(values)
      this.values = values
      this.evaluateEvents()
      if (this.disposed) return

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
          for (const session of this.enterSessions) session.cancel('superseded')
          this.enterSessions.clear()
          const replaced = this.active.filter(
            (entry) => entry.track.target === target && entry.track.property === property.name,
          )
          this.active = this.active.filter((entry) => !replaced.includes(entry))
          for (const entry of replaced) entry.animation.cancel()
          for (const element of this.targetElements.get(target) ?? []) {
            this.write(element, property.name, value)
          }
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
    this.leaveSessions.clear()
    for (const session of this.enterSessions) session.cancel('owner-teardown')
    this.enterSessions.clear()
    this.clearLetBindings()
    this.cancel()
    this.restore()
    this.motion.removeEventListener('change', this.motionChanged)
    this.targets.clear()
    this.targetElements.clear()
    this.eventValues.clear()
    this.onEvent = undefined
    this.onReactiveState = undefined
    this.disposed = true
  }
}
