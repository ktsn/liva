import type { Definition, Transition } from '../model/definition.ts'
import type { RenderedState } from '../model/presentation.ts'
import { renderFrame, renderTransition, type VariableValues } from '../evaluation/expression.ts'
import type { ResolvedTrack } from '../composition/resolve.ts'
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

/**
 * Evaluates one matching authored declaration, preserving a captured displayed start
 * when rebased. Without a matching declaration, retains the supplied captured track.
 * No values are sampled or changed; expression/timing errors propagate.
 */
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
