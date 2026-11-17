import { releaseResources } from '../evaluation/resource-cleanup.ts'
import {
  LayoutReadBatch,
  ProjectionReadPhase,
  type LayoutProjectionSnapshot,
} from './layout-bounds.ts'
import { captureInheritedProjection } from './layout-capture.ts'
import { registerLayoutRead } from './layout-scheduler.ts'
import type { LayoutCandidate, LayoutParticipant } from './layout-participant.ts'
import { identityProjection, type ProjectionMatrix } from './projection.ts'
import {
  projectionShape,
  projectionShapeMotion,
  projectionShapeTransform,
  type ProjectionShape,
  type ProjectionShapeState,
  type ProjectionShapeMotionResult,
} from './projection-shape.ts'

const axes = ['x', 'y', 'width', 'height'] as const
const zero: ProjectionShape = Object.freeze({
  origin: Object.freeze({ x: 0, y: 0 }),
  xEdge: Object.freeze({ x: 0, y: 0 }),
  yEdge: Object.freeze({ x: 0, y: 0 }),
})

type Candidate = LayoutCandidate & { readonly participant: LayoutParticipant }
type Motion = {
  readonly candidate: Candidate
  readonly destination: LayoutProjectionSnapshot
  readonly shape: ProjectionShape
  frame: LayoutProjectionSnapshot
  readonly motion: ProjectionShapeMotionResult
  start: number
  cumulative: ProjectionMatrix
}

function enabled(candidate: LayoutCandidate): boolean {
  return (
    !candidate.blocked &&
    !!candidate.configuration &&
    axes.some((axis) => candidate.configuration?.axes[axis])
  )
}

function sameGeometry(
  a: LayoutProjectionSnapshot | undefined,
  b: LayoutProjectionSnapshot | undefined,
): boolean {
  if (!a || !b) return a === b

  return (
    axes.every(
      (axis) =>
        Math.abs(a.box[axis] - b.box[axis]) <=
        (axis === 'x' || axis === 'y' ? a.positionPrecision + b.positionPrecision : 1e-7),
    ) &&
    (['a', 'b', 'c', 'd'] as const).every((axis) => Math.abs(a.frame[axis] - b.frame[axis]) < 1e-7)
  )
}

function parentMotion(
  element: HTMLElement,
  motions: ReadonlyMap<HTMLElement, Motion>,
): Motion | undefined {
  let parent = element.parentElement

  while (parent) {
    const motion = motions.get(parent)
    if (motion) return motion
    parent = parent.parentElement
  }

  return undefined
}

function sample(motion: Motion, time: number): ProjectionShapeState {
  return motion.motion.kind === 'motion'
    ? motion.motion.sample(time - motion.start)
    : { shape: motion.shape, velocity: zero }
}

/** Browser-native interpolation; derivatives use the performance clock in milliseconds. */
function tweenSampler(duration: number, easing: string) {
  const effect = new KeyframeEffect(null, [], { duration, easing, fill: 'both' })
  const animation = new Animation(effect)
  animation.pause()
  const progress = (time: number) => {
    animation.currentTime = Math.max(0, Math.min(duration, time))
    // Positive duration and fill:both keep every clamped sample in an active interval.
    return effect.getComputedTiming().progress!
  }

  return (time: number) => {
    const low = Math.max(0, time - 0.01)
    const high = Math.min(duration, time + 0.01)

    return { value: progress(time), velocity: (progress(high) - progress(low)) / (high - low) }
  }
}

/**
 * One Vue application's mutation transactions and retained full-shape trajectories.
 * begin() precedes DOM mutation; finish() follows binding/input reconciliation in
 * the same microtask checkpoint, before paint. Capture includes disabled potential
 * receivers. Only these transactions start motion; shared external observations
 * refresh geometry and terminate correction on actual change.
 *
 * Executor owns all style output. Geometry is read in explicit batches; ordinary
 * playback samples retained physical shapes/velocities without measuring the DOM.
 */
export class LayoutCoordinator {
  private readonly participants = new Set<LayoutParticipant>()
  private readonly motions = new Map<HTMLElement, Motion>()
  private captures?: Map<HTMLElement, ProjectionShapeState>
  private revisions = new Map<LayoutParticipant, number>()
  private baseline: ReadonlyMap<HTMLElement, LayoutProjectionSnapshot | undefined> = new Map()
  private observed: HTMLElement[] = []
  private cleanup?: () => void
  private frame?: number
  private disposed = false

  private readonly report: (error: unknown) => void

  constructor(report: (error: unknown) => void) {
    this.report = report
  }

  register(participant: LayoutParticipant): () => void {
    this.participants.add(participant)
    participant.onLayoutChange = this.ownershipChanged

    return () => {
      participant.onLayoutChange = undefined
      this.participants.delete(participant)
      const removed = [...this.motions].filter(
        ([, motion]) => motion.candidate.participant === participant,
      )
      for (const [element] of removed) this.motions.delete(element)
      this.stopIfIdle()

      releaseResources([
        ...removed.map(
          ([element]) =>
            () =>
              participant.layoutTransform(element, undefined),
        ),
        () => this.refreshObservation(),
      ])
    }
  }

  private candidates(transaction = false): Candidate[] {
    const candidates = new Map<HTMLElement, Candidate>()

    for (const participant of this.participants) {
      for (const candidate of participant.layoutCandidates(
        transaction ? this.revisions.get(participant) : undefined,
      )) {
        const previous = candidates.get(candidate.element)
        candidates.set(candidate.element, {
          ...candidate,
          participant,
          blocked: candidate.blocked || !!previous?.blocked,
        })
      }
    }

    return [...candidates.values()].toSorted((a, b) => {
      if (a.element.contains(b.element)) return -1
      if (b.element.contains(a.element)) return 1
      return 0
    })
  }

  private release() {
    releaseResources(
      [...this.motions].map(
        ([element, motion]) =>
          () =>
            motion.candidate.participant.layoutTransform(element, undefined),
      ),
    )
  }

  private read(candidates: readonly Candidate[]) {
    const phase = new ProjectionReadPhase(candidates.map((candidate) => candidate.element))
    const prepared: { element: HTMLElement; restore: () => void }[] = []
    const owners = new Map(
      candidates.map((candidate) => [candidate.element, candidate.participant]),
    )
    const fallback = candidates[0]?.participant

    try {
      if (fallback) {
        for (const suspension of phase.suspensions) {
          const owner = owners.get(suspension.element) ?? fallback
          prepared.push({
            element: suspension.element,
            restore: owner.layoutMeasure(suspension.element, suspension.properties),
          })
        }
      }

      // Important declarations can block the observation effect. Read every
      // effectiveness result before restoring any blocked overlay, so the final
      // geometry phase sees one stable scene and current authored presentation.
      const preservesViewports = phase.preservesViewports()
      const ineffective = prepared.filter(
        ({ element }) => !preservesViewports || !phase.neutral(element),
      )
      for (const entry of ineffective) {
        prepared.splice(prepared.indexOf(entry), 1)
        entry.restore()
      }

      const batch = new LayoutReadBatch()
      return new Map(candidates.map(({ element }) => [element, phase.read(element, batch)]))
    } finally {
      releaseResources(prepared.toReversed().map(({ restore }) => restore))
    }
  }

  begin() {
    try {
      if (this.disposed || this.captures) return

      const time = performance.now()
      this.render(time)
      const candidates = this.candidates()
      const displayed = this.read(candidates)
      this.revisions = new Map(
        [...this.participants].map((participant) => [participant, participant.layoutRevision]),
      )
      this.captures = new Map()

      for (const candidate of candidates) {
        const visual = displayed.get(candidate.element)
        if (!visual) continue

        const motion = this.motions.get(candidate.element)
        const parent = parentMotion(candidate.element, this.motions)
        const shape = projectionShape(visual.box, visual.frame)
        const state = motion
          ? sample(motion, time)
          : parent
            ? captureInheritedProjection(
                visual,
                {
                  cumulative: parent.cumulative,
                  frame: parent.frame,
                  sample: (at) => sample(parent, at),
                },
                time,
              )
            : shape
              ? { shape, velocity: zero }
              : undefined
        if (state) this.captures.set(candidate.element, state)
      }
    } catch (error) {
      this.recover(error)
      throw error
    }
  }

  finish() {
    try {
      this.commit()
    } catch (error) {
      this.recover(error)
      throw error
    }
  }

  private commit() {
    if (this.disposed) return

    const captures = this.captures
    this.captures = undefined
    const candidates = this.candidates(true)
    this.release()
    const snapshots = this.read(candidates)
    const previousMotions = new Map(this.motions)
    let fresh = this.plan(candidates, snapshots, captures, previousMotions)
    const stable = this.readOwnedDestinations(candidates, snapshots)
    if (stable !== snapshots) fresh = this.plan(candidates, stable, captures, previousMotions)

    this.baseline = stable
    this.installFrames(candidates)
    const start = performance.now()
    for (const motion of fresh) motion.start = start
    this.render(start)
    this.refreshObservation()
    this.schedule()
  }

  /**
   * Once projection is known to own a target, observe its overridden CSS transform
   * in the same identity basis used for output. Only an already non-none natural
   * transform is replaced here: its containing block remains unchanged. In
   * particular, natural none/transform changes can still reflow absolute children.
   * Unrelated ancestor presentation stays under the ordinary read-only/overlay path.
   */
  private readOwnedDestinations(
    candidates: readonly Candidate[],
    snapshots: ReadonlyMap<HTMLElement, LayoutProjectionSnapshot | undefined>,
  ) {
    const owned = [...this.motions.values()].filter(
      (motion) => snapshots.get(motion.candidate.element)?.cssTransform,
    )
    if (owned.length === 0) return snapshots

    const prepared: Motion[] = []
    try {
      for (const motion of owned) {
        prepared.push(motion)
        motion.candidate.participant.layoutTransform(
          motion.candidate.element,
          'matrix(1, 0, 0, 1, 0, 0)',
        )
      }

      return this.read(candidates)
    } finally {
      releaseResources(
        prepared
          .toReversed()
          .map(
            (motion) => () =>
              motion.candidate.participant.layoutTransform(motion.candidate.element, undefined),
          ),
      )
    }
  }

  /** Shared selection/trajectory planning for natural and owned observation bases. */
  private plan(
    candidates: readonly Candidate[],
    snapshots: ReadonlyMap<HTMLElement, LayoutProjectionSnapshot | undefined>,
    captures: ReadonlyMap<HTMLElement, ProjectionShapeState> | undefined,
    previousMotions: ReadonlyMap<HTMLElement, Motion>,
  ): Motion[] {
    this.motions.clear()
    const fresh: Motion[] = []

    for (const candidate of candidates) {
      const destination = snapshots
        .get(candidate.element)
        ?.withoutTransforms(new Set(this.motions.keys()))
      const previous = captures?.get(candidate.element)
      if (!enabled(candidate) || !destination || !previous) continue

      const configuration = candidate.configuration!
      const existing = previousMotions.get(candidate.element)
      const unchanged =
        existing &&
        sameGeometry(existing.destination, destination) &&
        axes.every(
          (axis) => existing.candidate.configuration?.axes[axis] === configuration.axes[axis],
        )

      if (unchanged) {
        this.motions.set(candidate.element, { ...existing, candidate })
        continue
      }

      const shape = projectionShape(destination.box, destination.frame)
      if (!shape) continue

      const timing = configuration.timing
      const tween =
        timing?.kind === 'tween' && timing.durationMs > 0 && timing.easing !== 'linear'
          ? tweenSampler(timing.durationMs, timing.easing)
          : undefined
      const motion = projectionShapeMotion(previous, shape, configuration.axes, timing, tween)
      if (motion.kind === 'settle' && !parentMotion(candidate.element, this.motions)) continue

      const entry: Motion = {
        candidate,
        destination,
        shape,
        frame: destination,
        motion,
        start: 0,
        cumulative: identityProjection,
      }
      this.motions.set(candidate.element, entry)
      fresh.push(entry)
    }

    return fresh
  }

  private installFrames(candidates: readonly Candidate[]) {
    if (this.motions.size === 0) return

    // Identity establishes the same containing blocks as the generated transform.
    // The renderer uses these actual local dimensions/frames while the trajectory
    // retains the natural physical destination, including absolute percentage boxes.
    for (const [element, motion] of this.motions)
      motion.candidate.participant.layoutTransform(element, 'matrix(1, 0, 0, 1, 0, 0)')
    const frames = this.read(candidates)

    for (const [element, motion] of this.motions) {
      const frame = frames.get(element)
      if (frame) motion.frame = frame
      else {
        this.motions.delete(element)
        motion.candidate.participant.layoutTransform(element, undefined)
      }
    }
  }

  private render(time: number) {
    let released = false

    for (const [element, motion] of this.motions) {
      const running =
        motion.motion.kind === 'motion' && time - motion.start < motion.motion.durationMs
      if (running || parentMotion(element, this.motions)) continue

      this.motions.delete(element)
      motion.candidate.participant.layoutTransform(element, undefined)
      released = true
    }

    // An ending ancestor can release a containing block or ordinary CSS rotation.
    // Refresh only at this ownership boundary, never on ordinary playback frames.
    if (released && this.motions.size > 0)
      this.installFrames([...this.motions.values()].map((motion) => motion.candidate))

    for (const [element, motion] of this.motions) {
      const parent = parentMotion(element, this.motions)
      const output = projectionShapeTransform(
        sample(motion, time).shape,
        motion.frame.box,
        motion.frame.frame,
        parent?.cumulative,
        motion.frame.origin,
      )

      if (output.kind === 'settle') {
        this.motions.delete(element)
        motion.candidate.participant.layoutTransform(element, undefined)
      } else {
        motion.cumulative = output.cumulative
        motion.candidate.participant.layoutTransform(element, output.transform)
      }
    }
  }

  private schedule() {
    if (this.frame !== undefined || this.motions.size === 0) return

    this.frame = requestAnimationFrame((time) => {
      this.frame = undefined

      try {
        this.render(time)
        this.schedule()
      } catch (error) {
        this.observationFailed(error)
      }
    })
  }

  private ownershipChanged = () => {
    const candidates = new Map(this.candidates().map((candidate) => [candidate.element, candidate]))

    for (const [element, motion] of this.motions) {
      const candidate = candidates.get(element)
      const sourceChanged =
        candidate?.configuration?.source.declaration !==
        motion.candidate.configuration?.source.declaration
      if (
        candidate &&
        enabled(candidate) &&
        !sourceChanged &&
        !axes.some(
          (axis) =>
            motion.candidate.configuration?.axes[axis] && !candidate.configuration?.axes[axis],
        )
      )
        continue

      this.motions.delete(element)
      motion.candidate.participant.layoutTransform(element, undefined)
    }

    this.stopIfIdle()
  }

  private stopIfIdle() {
    if (this.motions.size === 0 && this.frame !== undefined) {
      cancelAnimationFrame(this.frame)
      this.frame = undefined
    }
  }

  private refreshObservation() {
    const elements = this.candidates()
      .filter(enabled)
      .map((candidate) => candidate.element)
    if (
      elements.length === this.observed.length &&
      elements.every((element, index) => element === this.observed[index])
    )
      return

    this.cleanup?.()
    this.cleanup = undefined
    this.observed = elements
    if (elements.length === 0) return

    let initializing = true
    this.cleanup = registerLayoutRead(
      elements[0].ownerDocument,
      () => {
        if (initializing || this.captures) return () => {}

        const candidates = this.candidates().filter(enabled)
        const snapshots = this.readOwnedDestinations(candidates, this.read(candidates))
        const changed = [...snapshots].some(
          ([element, snapshot]) => !sameGeometry(snapshot, this.baseline.get(element)),
        )

        return () => {
          this.baseline = snapshots
          if (changed) this.settle()
        }
      },
      elements,
      {
        visual: true,
        prepare: () => {
          if (initializing || this.captures) return () => {}
          this.release()
          return () => this.render(performance.now())
        },
        onError: this.observationFailed,
      },
    )
    initializing = false
  }

  private settle() {
    const motions = [...this.motions]
    this.motions.clear()
    if (this.frame !== undefined) cancelAnimationFrame(this.frame)
    this.frame = undefined

    releaseResources(
      motions.map(
        ([element, motion]) =>
          () =>
            motion.candidate.participant.layoutTransform(element, undefined),
      ),
    )
  }

  private recover(error: unknown) {
    this.captures = undefined
    const cleanup = this.cleanup
    this.cleanup = undefined
    this.observed = []

    try {
      releaseResources([() => this.settle(), () => cleanup?.()])
    } catch (cleanupError) {
      this.report(
        new AggregateError([error, cleanupError], 'Layout recovery failed', { cause: error }),
      )
    }
  }

  private observationFailed = (error: unknown) => {
    this.recover(error)
    this.report(error)
  }

  dispose() {
    this.disposed = true
    const cleanup = this.cleanup
    this.cleanup = undefined
    this.captures = undefined
    this.baseline = new Map()
    this.revisions.clear()
    this.observed = []
    for (const participant of this.participants) participant.onLayoutChange = undefined
    this.participants.clear()

    releaseResources([() => this.settle(), () => cleanup?.()])
  }
}
