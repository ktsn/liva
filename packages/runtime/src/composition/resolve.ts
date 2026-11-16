import type { Timing } from '../model/definition.ts'
import type { RenderedFrame } from '../model/presentation.ts'

export interface ResolvedTrack {
  /** Effective evaluated declaration identity, retained across canonical expansion. */
  readonly owner?: string
  /** Authored declaration identity retained when a scoped layer is normalized to components. */
  readonly sourceProperty?: string
  readonly sourceDestination?: string
  readonly directionalOwner?: string
  readonly ownerState?: string
  readonly implicitStart?: boolean
  readonly target: string
  readonly property: string
  readonly timing: Timing
  readonly keyframes: readonly RenderedFrame[]
  readonly destinationValue: string
}

export function normalizeFrames(
  source: string,
  destination: string,
  explicitFrames: readonly RenderedFrame[] | undefined,
  timing: Timing,
): RenderedFrame[] {
  const frames = (explicitFrames ?? [])
    .map((frame) => ({ ...frame }))
    .toSorted((a, b) => a.offset - b.offset)

  if (
    frames.some(
      (frame, i) =>
        !Number.isFinite(frame.offset) ||
        frame.offset < 0 ||
        frame.offset > 1 ||
        (i > 0 && frame.offset === frames[i - 1].offset),
    )
  ) {
    throw new Error('Invalid or duplicate frame offset')
  }

  if (frames[0]?.offset !== 0) {
    frames.unshift({ offset: 0, value: source })
  }

  if (frames.at(-1)?.offset !== 1) {
    frames.push({ offset: 1, value: destination })
  }

  return frames.map((frame) => ({
    ...frame,
    easing: frame.easing ?? (timing.kind === 'tween' ? timing.easing : 'linear'),
  }))
}
