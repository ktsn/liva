import type { Definition, Transition } from '../model/definition.ts'
import type { RenderedState } from '../model/presentation.ts'
import { renderFrame, renderTransition, type VariableValues } from '../evaluation/expression.ts'
import type { ResolvedTrack } from '../composition/resolve.ts'
import { CompletionGroup } from './completion-group.ts'
import { PresentationExecutor } from './presentation-executor.ts'
import { transitionPropertySources } from '../composition/layer-cascade.ts'
import { normalizeFrames } from '../composition/resolve.ts'

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

/** Browser-owned participant; compatibility work keeps this association through object spreads. */
export interface LifecyclePlayback {
  initializeLifecycle(
    session: LifecycleSession,
    phase: 'enter' | 'leave',
    work: readonly LifecycleWork[],
  ): void
  playLifecycle(session: LifecycleSession): void
  endLifecycle(session: LifecycleSession, result: LifecycleResult): void
}

export interface LifecycleWork {
  /** Internal playback owner; omitted by callers constructing standalone work. */
  readonly playback?: LifecyclePlayback
  /** Source identity and accepted inputs retained for delayed work across definition replacement. */
  readonly capture?: {
    readonly definition: Definition
    readonly environment: { values: VariableValues }
    readonly track: ResolvedTrack
  }
  readonly element: HTMLElement
  readonly track: ResolvedTrack
  /**
   * Restores the pre-session inline style instead of publishing an enter destination.
   * Layer-backed work uses this while its owner reapplies the latest cascade.
   */
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

      const timing = transitionPropertySources(transition, target.name, property.name).timing
        ?.timing

      if (!timing) throw new Error(`Missing lifecycle timing: ${target.name}.${property.name}`)

      const stateValue = state.targets
        .find((item) => item.name === target.name)
        ?.properties.find((item) => item.name === property.name)?.value
      const baseline = stateValue ?? displayed
      const explicit = property.keyframes?.map((frame) => renderFrame(frame, {}))
      const frames = normalizeFrames(
        phase === 'leave' ? displayed || baseline : baseline,
        baseline,
        explicit,
        timing,
      )

      tracks.push({
        target: target.name,
        property: property.name,
        timing,
        keyframes: frames,
        implicitStart: phase === 'leave' && !explicit?.some((frame) => frame.offset === 0),
        destinationValue: phase === 'enter' ? baseline : frames.at(-1)!.value,
      })
    }
  }

  return tracks
}

/** Evaluates only one applicable declaration, retaining an explicitly rebased start from the adapter. */
export function evaluateLifecycleTrack(
  phase: 'enter' | 'leave',
  source: Transition | undefined,
  state: RenderedState,
  values: VariableValues,
  captured: ResolvedTrack,
  rebased = false,
): ResolvedTrack {
  const target = source?.targets.find((candidate) => candidate.name === captured.target)
  const property = target?.properties.find((candidate) => candidate.name === captured.property)

  if (!source || !target || !property) return captured

  const transition = renderTransition(
    { ...source, targets: [{ ...target, properties: [property] }] },
    values,
  )
  const rendered = resolveLifecycleTracks(
    phase,
    transition,
    state,
    () => captured.keyframes[0].value,
  )[0]

  return rebased
    ? {
        ...rendered,
        keyframes: rendered.keyframes.map((frame, index) =>
          index === 0 ? { ...frame, value: captured.keyframes[0].value } : frame,
        ),
      }
    : rendered
}

/**
 * Compatibility boundary barrier. Participants own styles, native effects, and
 * observations; the group follows only their current effect IDs across retargets.
 * Standalone work uses the same executor as instance-backed playback.
 */
export class LifecycleSession {
  private work: LifecycleWork[]
  private readonly participants = new Map<LifecyclePlayback, LifecycleWork[]>()
  private ended = false
  private initialized = false
  private started = false
  private resolve!: (result: LifecycleResult) => void
  readonly finished = new Promise<LifecycleResult>((resolve) => {
    this.resolve = resolve
  })
  readonly completion = new CompletionGroup<LifecycleResult>('completed', (result) =>
    this.end(result),
  )

  private readonly phase: 'enter' | 'leave'
  private readonly report: (error: unknown) => void

  constructor(
    work: readonly LifecycleWork[],
    phase: 'enter' | 'leave',
    report: (error: unknown) => void = console.error,
  ) {
    this.work = [...work]
    this.phase = phase
    this.report = report
  }

  owns(element: HTMLElement, property: string): boolean {
    return (
      !this.ended &&
      this.work.some((item) => item.element === element && item.track.property === property)
    )
  }

  get isFinished(): boolean {
    return this.ended
  }

  initialize() {
    if (this.ended || this.initialized) return

    this.initialized = true

    let standalone: PresentationExecutor | undefined

    for (const item of this.work) {
      const participant =
        item.playback ??
        (standalone ??= new PresentationExecutor((diagnostic) => {
          if (diagnostic.error !== undefined) this.fail(diagnostic.error)
        }))
      const work = this.participants.get(participant) ?? []

      work.push(item)
      this.participants.set(participant, work)
    }

    try {
      for (const [participant, work] of this.participants)
        participant.initializeLifecycle(this, this.phase, work)
    } catch (error) {
      this.fail(error)

      throw error
    }
  }

  play() {
    if (this.ended || this.started) return

    this.started = true

    try {
      this.initialize()

      if (this.ended) return

      for (const participant of this.participants.keys()) participant.playLifecycle(this)

      this.completion.seal()
    } catch (error) {
      this.fail(error)
    }
  }

  /** Reports unexpected browser failures while resolving the public failed result. */
  fail(error: unknown) {
    if (this.ended) return

    this.completion.end('failed')
    this.report(error)
  }

  cancel(reason: 'superseded' | 'owner-teardown') {
    this.completion.end(reason)
  }

  private end(result: LifecycleResult) {
    this.ended = true

    for (const participant of this.participants.keys()) {
      try {
        participant.endLifecycle(this, result)
      } catch (error) {
        this.report(error)
      }
    }

    this.participants.clear()
    this.work = []
    this.resolve(result)
  }
}
