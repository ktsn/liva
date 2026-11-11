import { trackLayoutAnimation } from './layout-scheduler.ts'
import type { Definition, Transition } from './definition.ts'
import type { RenderedState } from './presentation.ts'
import { renderFrame, renderTransition, type VariableValues } from './expression.ts'
import type { ResolvedTrack } from './resolve.ts'
import { sampleSpring } from './spring.ts'
import { waapiProperty } from './animation.ts'

export function lifecycleTransitions(
  definition: Definition,
  phase: 'enter' | 'leave',
): readonly Transition[] {
  const transition = definition[phase]

  return transition ? [transition] : []
}

export function hasLifecycle(definition: Definition): boolean {
  return (
    lifecycleTransitions(definition, 'enter').length > 0 ||
    lifecycleTransitions(definition, 'leave').length > 0
  )
}

/** Select and render only the lifecycle that is starting, leaving inactive expressions unevaluated. */
export function captureLifecycleDefinition(
  definition: Definition,
  phase: 'enter' | 'leave',
  values: VariableValues,
): Transition | undefined {
  const transition = definition[phase]

  if (!transition) return undefined

  return renderTransition(transition, values)
}

export interface LifecycleWork {
  readonly element: HTMLElement
  readonly track: ResolvedTrack
  /** Layer owners apply the latest cascade after completion, including removing absent properties. */
  readonly restoreOnCompletion?: boolean
}

export type LifecycleResult = 'completed' | 'superseded' | 'owner-teardown' | 'failed'

/** Resolve against a captured presentation; the result does not retain an instance. */
export function resolveLifecycle(
  phase: 'enter' | 'leave',
  transition: Transition | undefined,
  state: RenderedState,
  targets: ReadonlyMap<string, HTMLElement>,
): LifecycleWork[] {
  const tracks = resolveLifecycleTracks(phase, transition, state, (target, property) => {
    const element = targets.get(target)
    if (!element) return undefined
    return element.isConnected
      ? getComputedStyle(element).getPropertyValue(property)
      : element.style.getPropertyValue(property)
  })

  return tracks.map((track) => ({ element: targets.get(track.target)!, track }))
}

/**
 * Resolves a captured transition, whose frame expressions have already become literals.
 * Undefined presentation means the target is absent; an empty value may use State CSS.
 */
export function resolveLifecycleTracks(
  phase: 'enter' | 'leave',
  transition: Transition | undefined,
  state: RenderedState,
  presentation: (target: string, property: string) => string | undefined,
): ResolvedTrack[] {
  const tracks: ResolvedTrack[] = []

  for (const target of transition?.targets ?? []) {
    for (const property of target.properties) {
      const displayed = presentation(target.name, property.name)
      if (displayed === undefined) continue
      const timing = property.timing ?? transition?.timing
      if (!timing) throw new Error(`Missing lifecycle timing: ${target.name}.${property.name}`)

      const stateValue = state.targets
        .find((item) => item.name === target.name)
        ?.properties.find((item) => item.name === property.name)?.value
      const frames = (property.keyframes ?? []).map((frame) => renderFrame(frame, {}))
      const baseline = stateValue ?? displayed

      if (frames[0]?.offset !== 0) {
        frames.unshift({ offset: 0, value: phase === 'leave' ? displayed || baseline : baseline })
      }

      if (frames.at(-1)?.offset !== 1) frames.push({ offset: 1, value: baseline })

      tracks.push({
        target: target.name,
        property: property.name,
        timing,
        keyframes: frames.map((frame) => ({
          ...frame,
          easing: frame.easing ?? (timing.kind === 'tween' ? timing.easing : 'linear'),
        })),
        destinationValue: phase === 'enter' ? baseline : frames.at(-1)!.value,
      })
    }
  }

  return tracks
}

/** Owns effects and completion independently of component effects and Motion disposal. */
export class LifecycleSession {
  private work: LifecycleWork[]
  private effects: Animation[] = []
  private originals: { element: HTMLElement; property: string; value: string; priority: string }[] =
    []
  private ended = false
  private initialized = false
  private started = false
  private resolve!: (result: LifecycleResult) => void
  readonly finished = new Promise<LifecycleResult>((resolve) => {
    this.resolve = resolve
  })

  private readonly phase: 'enter' | 'leave'
  private readonly report: (error: unknown) => void

  constructor(
    work: readonly LifecycleWork[],
    phase: 'enter' | 'leave',
    report: (error: unknown) => void = console.error,
  ) {
    this.phase = phase
    this.report = report
    this.work = [...work]
  }

  owns(element: HTMLElement, property: string): boolean {
    return this.work.some((item) => item.element === element && item.track.property === property)
  }

  get isFinished(): boolean {
    return this.ended
  }

  initialize() {
    if (this.ended || this.initialized) return
    this.initialized = true

    for (const { element, track } of this.work) {
      this.originals.push({
        element,
        property: track.property,
        value: element.style.getPropertyValue(track.property),
        priority: element.style.getPropertyPriority(track.property),
      })
      element.style.setProperty(track.property, track.keyframes[0].value)
    }
  }

  play() {
    if (this.ended || this.started) return
    this.started = true

    try {
      const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches

      for (const { element, track } of this.work) {
        const timing =
          track.timing.kind === 'tween'
            ? { durationMs: track.timing.durationMs, easing: 'linear' }
            : sampleSpring(track.timing)

        if (reduced || timing.durationMs === 0) continue

        const effect = new KeyframeEffect(
          element,
          track.keyframes.map((frame) => ({
            [waapiProperty(track.property)]: frame.value,
            offset: frame.offset,
            easing: frame.easing,
          })),
          { duration: timing.durationMs, easing: timing.easing, fill: 'both' },
        )
        const animation = new Animation(effect, document.timeline)
        this.effects.push(animation)
        animation.play()
        trackLayoutAnimation(element, track.property, animation)
      }

      void Promise.all(this.effects.map((effect) => effect.finished)).then(
        () => this.end('completed'),
        (error) => this.fail(error),
      )
    } catch (error) {
      this.fail(error)
    }
  }

  private fail(error: unknown) {
    if (this.ended) return

    this.end('failed')
    this.report(error)
  }

  cancel(reason: 'superseded' | 'owner-teardown') {
    this.end(reason)
  }

  private end(result: LifecycleResult) {
    if (this.ended) return
    this.ended = true

    for (const original of this.originals) {
      original.element.style.setProperty(original.property, original.value, original.priority)
    }

    if (result === 'completed' && this.phase === 'enter') {
      for (const { element, track, restoreOnCompletion } of this.work) {
        if (restoreOnCompletion) continue

        element.style.setProperty(track.property, track.destinationValue)
      }
    }

    for (const effect of this.effects) effect.cancel()
    this.effects = []
    this.originals = []
    this.work = []
    this.resolve(result)
  }
}
