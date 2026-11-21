import type { Definition, Expression } from '../model/definition.ts'
import type { LayerResolution } from '../composition/layers.ts'
import {
  layerPropertyKey,
  orderedResolution,
  ownsCanonicalProperty,
  type ReceiverAddresses,
} from './presentation-planner.ts'

export interface ControllerBinding {
  readonly target: string
  readonly property: string
  readonly expression: Expression
}

/** Selects target-wide bindings before any live controller operation is requested. */
export function planControllerBindings(
  resolution: LayerResolution,
  receivers: readonly ReceiverAddresses[],
): ControllerBinding[] {
  return resolution.presentation.targets.flatMap((target) =>
    target.properties.flatMap((property) => {
      if (!property.binding) return []

      const obscured = receivers.some(
        (receiver) =>
          receiver.target === target.name &&
          ((receiver.bindings !== undefined && !receiver.bindings.includes(property.name)) ||
            receiver.addresses.some(
              (declaration) =>
                declaration.name === property.name &&
                declaration.addresses.some(
                  (address) => !ownsCanonicalProperty(receiver.addresses, property.name, address),
                ),
            )),
      )

      return obscured
        ? []
        : [{ target: target.name, property: property.name, expression: property.binding }]
    }),
  )
}

/** Applies supplied controller CSS values, preserving normal fallback and source order. */
export function planControllerPresentation(
  resolution: LayerResolution,
  normal: LayerResolution,
  outputs: ReadonlyMap<string, string | undefined>,
  definition: Definition,
): LayerResolution {
  const targets = resolution.presentation.targets.map((target) => ({
    ...target,
    properties: target.properties.flatMap((property) => {
      if (!property.binding) return [property]

      const key = layerPropertyKey(target.name, property.name)

      if (!outputs.has(key)) return []

      const value = outputs.get(key)

      if (value !== undefined) return [{ ...property, value }]

      const fallback = normal.presentation.targets
        .find((item) => item.name === target.name)
        ?.properties.find((item) => item.name === property.name)

      return fallback ? [fallback] : []
    }),
  }))

  return orderedResolution(
    {
      ...resolution,
      declarations: resolution.presentation,
      presentation: { ...resolution.presentation, targets },
    },
    definition,
  )
}
