import type { Transition } from '../model/definition.ts'
import type { RenderedState } from '../model/presentation.ts'
import type { ResolvedTrack } from '../composition/resolve.ts'
import {
  PresencePlayback,
  resolveLifecycleTracks,
  type PresentationExecutor,
  type CapturedPresence,
} from './presentation-executor.ts'
import { lifecycleOrigin } from './execution-contracts.ts'
export { resolveLifecycleTracks } from './presentation-executor.ts'
export {
  lifecycleTransitions,
  hasLifecycle,
  captureLifecycleDefinition,
} from '../composition/runtime-layers.ts'

export interface LifecycleWork {
  readonly element: HTMLElement
  readonly track: ResolvedTrack
  readonly restoreOnCompletion?: boolean
  /** Internal capture association survives existing work/track spread-based rebasing. */
  readonly [lifecycleOrigin]?: CapturedPresence
}

export type LifecycleResult = 'completed' | 'superseded' | 'owner-teardown' | 'failed'

/** Resolve against a captured presentation; native ownership is established only when a session starts. */
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

/** Compatibility facade over executor-owned effects and identifier-based completion. */
export class LifecycleSession {
  private readonly playback: PresencePlayback
  readonly finished: Promise<LifecycleResult>

  constructor(
    work: readonly LifecycleWork[],
    phase: 'enter' | 'leave',
    report: (error: unknown) => void = console.error,
  ) {
    this.playback = new PresencePlayback(work, phase, report)
    this.finished = this.playback.finished
  }

  retain(executor: PresentationExecutor) {
    this.playback.retain(executor)
  }

  owns(element: HTMLElement, property: string) {
    return this.playback.owns(element, property)
  }

  get isFinished() {
    return this.playback.isFinished
  }

  /** Applies the current start before paint; failure reports, settles as failed, cleans up and rethrows its cause. */
  initialize() {
    this.playback.initialize()
  }

  /** Starts once; preparation/native failure reports its cause and resolves finished as failed. */
  play() {
    this.playback.play()
  }

  cancel(reason: 'superseded' | 'owner-teardown') {
    this.playback.cancel(reason)
  }
}
