import type { Composition, CompositionTransition, Definition } from '@liva/runtime'

export function copyComposition(composition: Composition): Composition {
  return { layers: { ...composition.layers }, states: { ...composition.states } }
}

export function compatibleTransition(
  definition: Definition,
  from: Composition,
  to: Composition,
  identity: CompositionTransition | undefined,
): CompositionTransition | undefined {
  if (!identity) return undefined

  const transition = definition.layers?.find((layer) => layer.name === identity.layer)
    ?.transitions?.[identity.index]

  return transition &&
    transition.from === from.states[identity.layer] &&
    transition.to === to.states[identity.layer]
    ? identity
    : undefined
}

export function selectTransition(
  definition: Definition,
  from: Composition,
  to: Composition,
  identity: CompositionTransition,
): { from: Composition; to: Composition } {
  const transition = definition.layers?.find((layer) => layer.name === identity.layer)
    ?.transitions?.[identity.index]

  if (!transition) throw new Error('Unknown transition declaration')

  return {
    from: {
      layers: { ...from.layers },
      states: { ...from.states, [identity.layer]: transition.from },
    },
    to: { layers: { ...to.layers }, states: { ...to.states, [identity.layer]: transition.to } },
  }
}
