import { resolveComposition, type LayerResolution } from '../composition/layers.ts'
import type { VariableValues } from '../evaluation/expression.ts'
import type { Definition } from '../model/definition.ts'
import type { ExecutionPort } from './execution-contracts.ts'
import {
  orderedResolution,
  planControllerBindings,
  planControllerPresentation,
  layerPropertyKey,
} from './presentation-planner.ts'

/** Resolves controller ownership and values through shared live/isolated browser phases. Times use performance-clock milliseconds. */
export function resolveControllerPresentation(
  execution: Pick<ExecutionPort, 'releaseControllers' | 'observeReceivers' | 'applyControllers'>,
  definition: Definition,
  resolution: LayerResolution,
  values: VariableValues,
  time: number,
  live = true,
): LayerResolution {
  resolution = orderedResolution(resolution, definition)
  const targets = new Set(
    resolution.presentation.targets
      .filter((target) => target.properties.some((property) => property.binding))
      .map((target) => target.name),
  )

  if (targets.size === 0) {
    if (live) execution.releaseControllers(time)

    return resolution
  }

  const normal = resolveComposition(
    {
      ...definition,
      layers: definition.layers.map((layer) => ({
        ...layer,
        targets: layer.targets.map((target) => ({
          ...target,
          properties: target.properties.filter((property) => property.value.kind !== 'binding'),
        })),
        states: layer.states?.map((state) => ({
          ...state,
          targets: state.targets.map((target) => ({
            ...target,
            properties: target.properties.filter((property) => property.value.kind !== 'binding'),
          })),
        })),
      })),
    },
    values,
    resolution.composition,
  )
  const receivers = execution.observeReceivers(resolution, targets, live)
  const bindings = planControllerBindings(resolution, receivers)
  const outputs = new Map(execution.applyControllers(bindings, values, time, live))

  for (const receiver of receivers) {
    for (const property of receiver.fallbacks)
      outputs.set(layerPropertyKey(receiver.target, property), undefined)
  }

  return planControllerPresentation(resolution, normal, outputs, definition)
}
