import {
  sampleSpring,
  type Definition,
  type Frame,
  type PropertyTransition,
  type Timing,
  type Transition,
} from '@liva/runtime'

export type LifecyclePhase = 'enter' | 'leave'

export interface TimelineTrack {
  lifecycle?: LifecyclePhase
  target: string
  property: string
  path: string
  local?: PropertyTransition
  timing?: Timing
  duration: number
  diagnostic?: string
  frames: readonly Frame[]
  explicit: readonly Frame[]
  inheritedFrames: boolean
  timingOrigin: string
}

const propertyAt = (transition: Transition | undefined, target: string, property: string) =>
  transition?.targets
    .find((item) => item.name === target)
    ?.properties.find((item) => item.name === property)

export function timingText(timing: Timing): string {
  if (timing.kind === 'tween') return `@tween: ${timing.durationMs}ms ${timing.easing}`
  if (timing.kind === 'spring-duration') return `@spring: ${timing.durationMs}ms ${timing.bounce}`
  return `@spring: ${timing.stiffness} ${timing.damping} ${timing.mass}`
}

export function transitionAt(
  definition: Definition,
  from: string,
  to: string,
  general: boolean,
  phase?: LifecyclePhase,
): Transition | undefined {
  if (phase) return definition[phase]

  return general
    ? definition.generalTransition
    : definition.directionalTransitions.find((item) => item.from === from && item.to === to)
        ?.transition
}

export function transitionPath(
  definition: Definition,
  from: string,
  to: string,
  general: boolean,
  phase?: LifecyclePhase,
) {
  if (phase) return `${definition.name}/${phase}`

  return `${definition.name}/transition/${general ? 'general' : `directional/${from}/${to}`}`
}

export function timelineTracks(
  definition: Definition,
  from: string,
  to: string,
  general: boolean,
  phase?: LifecyclePhase,
): TimelineTrack[] {
  const source = definition.states.find((state) => state.name === (phase ? to : from))
  const destination = definition.states.find((state) => state.name === to)
  const common = phase ? definition[phase] : definition.generalTransition
  const selected = transitionAt(definition, from, to, general, phase)

  const targets = (destination?.targets ?? []).map((target) => ({
    ...target,
    properties: [...target.properties],
  }))

  if (phase) {
    for (const transition of [common, selected]) {
      for (const target of transition?.targets ?? []) {
        let row = targets.find((item) => item.name === target.name)

        if (!row) {
          row = { name: target.name, properties: [] }
          targets.push(row)
        }

        for (const property of target.properties) {
          if (!row.properties.some((item) => item.name === property.name)) {
            row.properties.push({ name: property.name, value: '' })
          }
        }
      }
    }
  }

  return targets.flatMap((target) =>
    target.properties.map((property) => {
      const local = propertyAt(selected, target.name, property.name)
      const inherited = general ? undefined : propertyAt(common, target.name, property.name)
      const timing = local?.timing ?? inherited?.timing ?? selected?.timing ?? common?.timing
      const explicit = local?.keyframes ?? inherited?.keyframes ?? []
      const frames = [...explicit]
      const initial =
        source?.targets
          .find((item) => item.name === target.name)
          ?.properties.find((item) => item.name === property.name)?.value ?? property.value

      if (!frames.some((frame) => frame.offset === 0)) frames.push({ offset: 0, value: initial })
      if (!frames.some((frame) => frame.offset === 1))
        frames.push({ offset: 1, value: property.value })

      let duration = 0
      let diagnostic: string | undefined
      try {
        duration = timing
          ? timing.kind === 'spring-physics'
            ? sampleSpring(timing).durationMs
            : timing.durationMs
          : 0
      } catch (error) {
        diagnostic = String(error)
      }

      return {
        lifecycle: phase,
        target: target.name,
        property: property.name,
        path: `${transitionPath(definition, from, to, general, phase)}/target/${target.name}/property/${property.name}`,
        local,
        timing,
        duration,
        diagnostic,
        frames: frames.toSorted((a, b) => a.offset - b.offset),
        explicit,
        inheritedFrames: !general && !local?.keyframes && !!inherited?.keyframes,
        timingOrigin: local?.timing
          ? 'Local property'
          : inherited?.timing
            ? 'Inherited common property'
            : selected?.timing
              ? 'Transition default'
              : phase
                ? 'Lifecycle default'
                : 'Inherited common default',
      }
    }),
  )
}

export function normalizedOffset(time: number, duration: number): number {
  return duration > 0
    ? Math.round(Math.max(0, Math.min(1, time / duration)) * 1000000) / 1000000
    : 0
}

export function snapTime(
  time: number,
  extent: number,
  marks: number[],
  pixels: number,
  bypass: boolean,
): number {
  if (bypass) return time
  const step = extent / 10
  const candidates = [...marks, Math.round(time / step) * step]
  const closest = candidates.reduce(
    (best, candidate) => (Math.abs(candidate - time) < Math.abs(best - time) ? candidate : best),
    time + extent,
  )
  return Math.abs(closest - time) <= (extent * 7) / Math.max(1, pixels) ? closest : time
}

/** Preserve compiler-owned expression trees while creating the local editor model. */
export function editableDefinition(definition: Definition): Definition {
  return structuredClone(definition)
}
