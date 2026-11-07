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

/**
 * Yields the layers and states selected by an explicit composition in definition order.
 * Ordinary layers contribute only when enabled; stateful layers contribute their
 * selected state. Guards and expressions are not evaluated, and state machines
 * are not advanced. Pass the result to {@link resolveLayerCascade} to resolve
 * ownership and timing precedence.
 *
 * @throws If a stateful layer's selected state is missing or unknown.
 */
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

/**
 * Resolves property ownership and independent timing inheritance across selected layers.
 * State properties override common properties within a layer; later layers override
 * earlier layers for each target/property pair.
 *
 * Timing precedence within each contributing layer, highest first:
 * - State property, state target, state-wide timing.
 * - Common property, common target, layer-wide timing.
 * Without a local timing provider, the previous layer's timing is retained even
 * when the value owner changes. Transition overrides are applied separately using
 * {@link transitionPropertySources}.
 *
 * Mapping callbacks separate precedence from expression evaluation: playback maps
 * declarations to evaluated values, while editor inspection retains source references.
 * Each layer's winning contributions are mapped in iteration order, including those
 * later obscured by another layer, preserving runtime evaluation and failure order.
 *
 * @param selection Layers and optional states in cascade order.
 * @param mapValue Maps the winning property declaration within each layer.
 * @param mapTiming Maps a local timing provider, only when one exists, before mapValue.
 * @returns Targets with resolved values, winning sources, all contributing declarations
 * in precedence order, and independently resolved timing.
 */
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
