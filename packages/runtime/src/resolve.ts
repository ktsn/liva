import { renderTransition, type VariableValues } from './expression.ts'
import type { Definition, Frame, State, Timing, Transition } from './definition.ts'

export interface ResolvedTrack {
  readonly directionalOwner?: string
  readonly ownerState?: string
  readonly implicitStart?: boolean
  readonly target: string
  readonly property: string
  readonly timing: Timing
  readonly keyframes: readonly Frame[]
  readonly destinationValue: string
}

const propertyAt = (transition: Transition | undefined, target: string, property: string) =>
  transition?.targets.find((t) => t.name === target)?.properties.find((p) => p.name === property)

export function getState(definition: Definition, name: string): State {
  const state = definition.states.find((candidate) => candidate.name === name)

  if (!state) {
    throw new Error(`Unknown Liva state: ${name}`)
  }

  return state
}

export function resolve(
  definition: Definition,
  fromName: string,
  toName: string,
  values: VariableValues = {},
): ResolvedTrack[] {
  const from = getState(definition, fromName)
  const to = getState(definition, toName)

  if (fromName === toName) {
    return []
  }

  const general = definition.generalTransition
    ? renderTransition(definition.generalTransition, values)
    : undefined
  const selected = definition.directionalTransitions.find(
    (t) => t.from === fromName && t.to === toName,
  )?.transition

  const directional = selected ? renderTransition(selected, values) : undefined

  const tracks: ResolvedTrack[] = []

  for (const target of to.targets) {
    for (const property of target.properties) {
      const source = from.targets
        .find((t) => t.name === target.name)
        ?.properties.find((p) => p.name === property.name)?.value

      if (source === undefined) {
        throw new Error(`Incomplete state ${fromName}: ${target.name}.${property.name}`)
      }

      const gp = propertyAt(general, target.name, property.name)
      const dp = propertyAt(directional, target.name, property.name)
      const explicitFrames = dp?.keyframes ?? gp?.keyframes ?? property.keyframes

      if (source === property.value && !explicitFrames?.length) {
        continue
      }

      const timing =
        dp?.timing ?? gp?.timing ?? property.timing ?? directional?.timing ?? general?.timing

      if (!timing && property.template) continue

      if (!timing) {
        throw new Error(`Missing timing: ${target.name}.${property.name}`)
      }

      const frames = normalizeFrames(source, property.value, explicitFrames, timing)

      tracks.push({
        target: target.name,
        property: property.name,
        timing,
        keyframes: frames,
        destinationValue: property.value,
      })
    }
  }

  return tracks
}

export function normalizeFrames(
  source: string,
  destination: string,
  explicitFrames: readonly Frame[] | undefined,
  timing: Timing,
  allowSpringKeyframes = false,
): Frame[] {
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

  if (
    !allowSpringKeyframes &&
    timing.kind !== 'tween' &&
    frames.some((f) => (f.offset > 0 && f.offset < 1) || f.easing !== undefined)
  ) {
    throw new Error('Spring tracks cannot contain intermediate frames or frame easing')
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
