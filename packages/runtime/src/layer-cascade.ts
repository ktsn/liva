import type {
  Definition,
  Layer,
  Property,
  State,
  Target,
  Timing,
  Expression,
  Transition,
} from './definition.ts'
import type { Composition } from './layers.ts'

export interface LayerSelection {
  readonly layer: Layer
  readonly state?: State
}

export interface PropertySource extends LayerSelection {
  readonly target: Target<Property>
  readonly property: Property
}

export interface TimingDeclaration {
  readonly timing?: Timing
  readonly timingExpression?: Expression
}

export interface TimingSource extends LayerSelection {
  readonly target?: Target<Property>
  readonly property?: Property
  readonly declaration: TimingDeclaration
}

export interface CascadedProperty<Value, ResolvedTiming> {
  readonly name: string
  readonly value: Value
  readonly source: PropertySource
  readonly declarations: readonly PropertySource[]
  readonly timing?: ResolvedTiming
}

export function timingProvider<T extends TimingDeclaration>(...candidates: (T | undefined)[]) {
  return candidates.find((candidate) => candidate?.timingExpression || candidate?.timing)
}

export function* compositionLayerSelection(
  definition: Definition,
  composition: Composition,
): Generator<LayerSelection> {
  for (const layer of definition.layers ?? []) {
    if (!layer.states?.length) {
      if (composition.layers[layer.name]) yield { layer }

      continue
    }

    const name = composition.states[layer.name]
    const state = layer.states.find((candidate) => candidate.name === name)

    if (!state) throw new Error(`Unknown current state in layer ${layer.name}: ${name}`)

    yield { layer, state }
  }
}

export function resolveLayerCascade<Value, ResolvedTiming>(
  selection: Iterable<LayerSelection>,
  mapValue: (source: PropertySource) => Value,
  mapTiming: (source: TimingSource) => ResolvedTiming,
): readonly Target<CascadedProperty<Value, ResolvedTiming>>[] {
  const targets = new Map<string, Map<string, CascadedProperty<Value, ResolvedTiming>>>()

  for (const { layer, state } of selection) {
    const contributions = new Map<string, Map<string, PropertySource[]>>()

    for (const scope of [{ targets: layer.targets }, ...(state ? [state] : [])]) {
      for (const target of scope.targets) {
        let properties = contributions.get(target.name)

        if (!properties) {
          properties = new Map()
          contributions.set(target.name, properties)
        }

        for (const property of target.properties) {
          const declarations = properties.get(property.name) ?? []
          declarations.push({ layer, state: scope === state ? state : undefined, target, property })
          properties.set(property.name, declarations)
        }
      }
    }

    for (const [targetName, contribution] of contributions) {
      let properties = targets.get(targetName)

      if (!properties) {
        properties = new Map()
        targets.set(targetName, properties)
      }

      const commonTarget = layer.targets.find((target) => target.name === targetName)
      const stateTarget = state?.targets.find((target) => target.name === targetName)

      for (const [name, declarations] of contribution) {
        // A contribution is created only when at least one declaration is pushed.
        const source = declarations.at(-1)!
        const candidates: TimingSource[] = []

        for (const scope of [
          ...(state ? [{ state, target: stateTarget, declaration: state }] : []),
          { state: undefined, target: commonTarget, declaration: layer },
        ]) {
          const { target } = scope
          const property = target?.properties.find((item) => item.name === name)

          if (property)
            candidates.push({ layer, state: scope.state, target, property, declaration: property })
          if (target) candidates.push({ layer, state: scope.state, target, declaration: target })

          candidates.push({ layer, state: scope.state, declaration: scope.declaration })
        }

        const provider = candidates.find((candidate) => timingProvider(candidate.declaration))
        const previous = properties.get(name)
        const timing = provider ? mapTiming(provider) : previous?.timing

        properties.set(name, {
          name,
          source,
          value: mapValue(source),
          declarations: [...(previous?.declarations ?? []), ...declarations],
          timing,
        })
      }
    }
  }

  return [...targets].map(([name, properties]) => ({ name, properties: [...properties.values()] }))
}

export function transitionPropertySources(
  transition: Transition | undefined,
  targetName: string,
  propertyName: string,
) {
  const target = transition?.targets.find((item) => item.name === targetName)
  const property = target?.properties.find((item) => item.name === propertyName)
  const timing = timingProvider<TimingDeclaration>(property, target, transition)

  return { target, property, timing }
}
