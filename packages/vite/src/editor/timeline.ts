import {
  sampleSpring,
  resolveLayerTracks,
  type LayerResolution,
  type Definition,
  type Frame,
  type PropertyTransition,
  type Timing,
  type Transition,
  type State,
  resolveLifecycleTracks,
} from '@liva/runtime'

export type LifecyclePhase = 'enter' | 'leave'

export interface TimelineTrack {
  readonly?: boolean
  fromValue?: string
  toValue?: string
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

export function compositionTimelineTracks(
  from: LayerResolution,
  to: LayerResolution,
): TimelineTrack[] {
  const tracks = resolveLayerTracks(
    from,
    to,
    {},
    (target, property) =>
      from.presentation.targets
        .find((item) => item.name === target)
        ?.properties.find((item) => item.name === property)?.value ?? '',
    () => {},
    () => true,
  )

  return to.presentation.targets.flatMap((target) =>
    target.properties.map((property) => {
      const track = tracks.find(
        (item) => item.target === target.name && item.property === property.name,
      )
      const initial =
        from.presentation.targets
          .find((item) => item.name === target.name)
          ?.properties.find((item) => item.name === property.name)?.value ?? ''
      const timing = track?.timing
      let duration = 0
      let diagnostic: string | undefined

      try {
        duration = timing
          ? timing.kind === 'tween'
            ? timing.durationMs
            : sampleSpring(timing).durationMs
          : 0
      } catch (error) {
        diagnostic = String(error)
      }
      const explicit =
        to.transitions
          .get(property.owner)
          ?.transition.targets.find((item) => item.name === target.name)
          ?.properties.find((item) => item.name === property.name)?.keyframes ??
        property.keyframes ??
        []

      return {
        target: target.name,
        property: property.name,
        path: `${target.name}/${property.name}`,
        timing,
        duration,
        diagnostic,
        fromValue: initial,
        toValue: property.value,
        frames: track?.keyframes ?? [
          { offset: 0, value: initial },
          { offset: 1, value: property.value },
        ],
        explicit,
        inheritedFrames: false,
        timingOrigin: `Animation owner: ${property.owner}`,
        readonly: true,
      }
    }),
  )
}

export function compositionLifecycleTracks(
  name: string,
  phase: LifecyclePhase,
  presentation: State,
  transition: Transition | undefined,
): TimelineTrack[] {
  const resolved = resolveLifecycleTracks(
    phase,
    transition,
    presentation,
    (target, property) =>
      presentation.targets
        .find((item) => item.name === target)
        ?.properties.find((item) => item.name === property)?.value ?? '',
  )
  const pairs = new Map<string, { target: string; property: string; value: string }>()

  for (const target of presentation.targets) {
    for (const property of target.properties)
      pairs.set(`${target.name}/${property.name}`, {
        target: target.name,
        property: property.name,
        value: property.value,
      })
  }

  for (const target of transition?.targets ?? []) {
    for (const property of target.properties) {
      const key = `${target.name}/${property.name}`
      if (!pairs.has(key))
        pairs.set(key, { target: target.name, property: property.name, value: '' })
    }
  }

  return [...pairs.values()].map(({ target, property, value }) => {
    const track = resolved.find((item) => item.target === target && item.property === property)
    const local = transition?.targets
      .find((item) => item.name === target)
      ?.properties.find((item) => item.name === property)
    const timing = track?.timing
    const frames = track?.keyframes ?? [
      { offset: 0, value },
      { offset: 1, value },
    ]
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
      target,
      property,
      path: `${name}/${phase}/target/${target}/property/${property}`,
      local,
      timing,
      duration,
      diagnostic,
      frames,
      explicit: local?.keyframes ?? [],
      inheritedFrames: false,
      timingOrigin: `Motion ${phase}`,
      readonly: true,
      fromValue: frames.find((frame) => frame.offset === 0)?.value,
      toValue: phase === 'enter' ? value : frames.find((frame) => frame.offset === 1)?.value,
    }
  })
}

export function timingText(timing: Timing): string {
  if (timing.kind === 'tween') return `Tween: ${timing.durationMs} ms, ${timing.easing}`
  if (timing.kind === 'spring-duration')
    return `Spring: ${timing.durationMs} ms, bounce ${timing.bounce}`
  return `Spring: stiffness ${timing.stiffness}, damping ${timing.damping}, mass ${timing.mass}`
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
