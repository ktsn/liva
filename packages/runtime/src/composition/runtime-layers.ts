import { cascadeTargets, targetTiming } from './layer-cascade.ts'
import { normalizeFrames } from './resolve.ts'
import type { Definition, Transition } from '../model/definition.ts'
import type { RenderedState } from '../model/presentation.ts'
import { renderFrame, renderTransition, type VariableValues } from '../evaluation/expression.ts'
import type { LayerResolution, LayerProperty } from './layers.ts'
import type { ResolvedTrack } from './resolve.ts'

export type EvaluatedProperty = LayerProperty

/** Evaluated declarations and receiver identifiers; operation lifetime stays outside these values. */
export interface EvaluatedLayer {
  readonly id: string
  readonly scope: 'all' | readonly number[]
  readonly targets: readonly {
    readonly name: string
    readonly properties: readonly EvaluatedProperty[]
  }[]
}

export interface LayerChange {
  readonly from: readonly EvaluatedLayer[]
  readonly to: readonly EvaluatedLayer[]
}

/** Converts the ordinary selected cascade without changing public composition or Definition IR. */
export function ordinaryLayer(resolution: LayerResolution): EvaluatedLayer {
  return { id: '@ordinary', scope: 'all', targets: resolution.presentation.targets }
}

/** Cascades values and timing independently, retaining source order for physical aliases. */
export function composeRuntimeLayers(
  layers: readonly EvaluatedLayer[],
  receiver: number,
): LayerResolution['presentation'] {
  const targets = layers
    .filter((layer) => layer.scope === 'all' || layer.scope.includes(receiver))
    .flatMap((layer) =>
      layer.targets.map((target) => ({
        name: target.name,
        properties: target.properties.map((property) => ({
          name: property.name,
          value: property,
          timing: property.timing ? { value: property.timing } : undefined,
        })),
      })),
    )

  return {
    name: '@layers',
    targets: cascadeTargets(targets, 'last').map((target) => ({
      name: target.name,
      properties: target.properties.map((property) => ({
        ...property.value,
        timing: property.timing,
      })),
    })),
  }
}

/** Converts evaluated endpoint/frame instructions into the common layer representation. */
export function trackLayer(
  id: string,
  receiver: number,
  tracks: readonly ResolvedTrack[],
  start = false,
  authored?: ResolvedTrack,
): EvaluatedLayer {
  const targets = new Map<string, EvaluatedProperty[]>()

  for (const track of tracks) {
    const properties = targets.get(track.target) ?? []
    targets.set(track.target, properties)
    properties.push({
      name: track.property,
      owner: id,
      value: start
        ? track.keyframes[0].value
        : (track.keyframes.findLast((frame) => frame.offset === 1)?.value ??
          track.destinationValue),
      completionValue: start ? undefined : track.destinationValue,
      timing: start ? { kind: 'tween', durationMs: 0, easing: 'linear' } : track.timing,
      keyframes: start ? undefined : track.keyframes,
      ...(authored && authored.property !== track.property ? { authored } : {}),
    })
  }

  return {
    id,
    scope: [receiver],
    targets: [...targets].map(([name, properties]) => ({ name, properties })),
  }
}

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

export function normalizeLifecycleTracks(
  phase: 'enter' | 'leave',
  transition: Transition | undefined,
  state: RenderedState,
  presentation: ReadonlyMap<string, string>,
): ResolvedTrack[] {
  const tracks: ResolvedTrack[] = []

  for (const target of transition?.targets ?? []) {
    for (const property of target.properties) {
      const displayed = presentation.get(`${target.name}\0${property.name}`)
      if (displayed === undefined) continue
      const timing =
        property.timing ?? targetTiming(target, property.name)?.timing ?? transition?.timing
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
        keyframes: normalizeFrames(frames[0].value, baseline, frames, timing),
        destinationValue: phase === 'enter' ? baseline : frames.at(-1)!.value,
      })
    }
  }

  return tracks
}
