import type { Definition, GuardedTransition, Property, State, Target } from './definition.ts'
import { evaluate, renderValue, type VariableValues } from './expression.ts'

export interface LayerResolution {
  readonly states: ReadonlyMap<string, string>
  readonly transitions: ReadonlyMap<string, GuardedTransition>
  readonly presentation: State
}

export function layerTargets(definition: Definition): readonly Target<Property>[] {
  return (definition.layers ?? []).flatMap((layer) => [
    ...layer.targets,
    ...(layer.states ?? []).flatMap((state) => state.targets),
  ])
}

export function resolveLayers(
  definition: Definition,
  values: VariableValues,
  previous: ReadonlyMap<string, string> = new Map(),
  advance = true,
): LayerResolution {
  const states = new Map<string, string>()
  const transitions = new Map<string, GuardedTransition>()
  const targets = new Map<string, Map<string, Property>>()

  const contribute = (contribution: readonly Target<Property>[]) => {
    for (const target of contribution) {
      let properties = targets.get(target.name)

      if (!properties) {
        properties = new Map()
        targets.set(target.name, properties)
      }

      for (const property of target.properties) {
        properties.set(property.name, { name: property.name, value: renderValue(property, values) })
      }
    }
  }

  for (const layer of definition.layers ?? []) {
    if (layer.when && evaluate(layer.when, values) !== true) continue

    contribute(layer.targets)

    if (!layer.states?.length) continue

    const current = previous.get(layer.name) ?? layer.initialState
    const selected = advance
      ? layer.transitions?.findLast(
          (transition) => transition.from === current && evaluate(transition.when, values) === true,
        )
      : undefined
    const next = selected?.to ?? current
    const state = layer.states.find((candidate) => candidate.name === next)

    if (!state) throw new Error(`Unknown current state in layer ${layer.name}: ${next}`)

    states.set(layer.name, state.name)

    if (selected) transitions.set(layer.name, selected)

    contribute(state.targets)
  }

  return {
    states,
    transitions,
    presentation: {
      name: '@layers',
      targets: [...targets].map(([name, properties]) => ({
        name,
        properties: [...properties.values()],
      })),
    },
  }
}
