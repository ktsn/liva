import type {
  Definition,
  Layer,
  Property,
  State,
  Target,
  Timing,
  Expression,
  Transition,
} from '../model/definition.ts'
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

/** Select shared target timing only for properties inside its authored block. */
export function targetTiming<T>(
  target: Target<T> | undefined,
  property: string,
): Target<T> | undefined {
  return target?.timingProperties && !target.timingProperties.includes(property)
    ? undefined
    : target
}

/**
 * Yields the layers and states selected by an explicit composition in definition order.
 * Ordinary layers contribute only when enabled; stateful layers contribute their
 * selected state. Guards and expressions are not evaluated, and state machines
 * are not advanced. Pass the result to {@link resolveLayerCascade} to resolve
 * ownership and timing precedence.
 *
 * @yields Each enabled ordinary layer or stateful layer with its selected state.
 * @throws If a stateful layer's selected state is missing or unknown.
 */
export function* compositionLayerSelection(
  definition: Definition,
  composition: Composition,
): Generator<LayerSelection> {
  for (const layer of definition.layers) {
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
 * Shared value/timing cascade. Later values win; timing changes only when a provider
 * is present. The timing wrapper distinguishes an absent provider from an explicitly
 * mapped undefined value. Source order can retain first insertion or the last owner.
 */
export function cascadeTargets<Value, ResolvedTiming>(
  targets: Iterable<
    Target<{
      readonly name: string
      readonly value: Value
      readonly timing?: { readonly value: ResolvedTiming }
    }>
  >,
  order: 'first' | 'last',
  merge: (previous: Value | undefined, next: Value) => Value = (_previous, next) => next,
): readonly Target<{
  readonly name: string
  readonly value: Value
  readonly timing?: ResolvedTiming
}>[] {
  const result = new Map<
    string,
    Map<string, { name: string; value: Value; timing?: ResolvedTiming }>
  >()

  for (const target of targets) {
    const properties = result.get(target.name) ?? new Map()
    result.set(target.name, properties)

    for (const property of target.properties) {
      const previous = properties.get(property.name)
      const value = merge(previous?.value, property.value)
      const timing = property.timing ? property.timing.value : previous?.timing

      if (order === 'last') properties.delete(property.name)

      properties.set(property.name, { name: property.name, value, timing })
    }
  }

  return [...result].map(([name, properties]) => ({ name, properties: [...properties.values()] }))
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
  type Contribution = {
    value: Value
    source: PropertySource
    declarations: readonly PropertySource[]
  }

  function* contributions(): Generator<
    Target<{ name: string; value: Contribution; timing?: { value: ResolvedTiming } }>
  > {
    for (const { layer, state } of selection) {
      const targets = new Map<string, Map<string, PropertySource[]>>()

      for (const scope of [{ targets: layer.targets }, ...(state ? [state] : [])]) {
        for (const target of scope.targets) {
          const properties = targets.get(target.name) ?? new Map<string, PropertySource[]>()
          targets.set(target.name, properties)

          for (const property of target.properties) {
            const declarations = properties.get(property.name) ?? []
            declarations.push({
              layer,
              state: scope === state ? state : undefined,
              target,
              property,
            })
            properties.set(property.name, declarations)
          }
        }
      }

      for (const [name, properties] of targets) {
        if (properties.size === 0) yield { name, properties: [] }

        const commonTarget = layer.targets.find((target) => target.name === name)
        const stateTarget = state?.targets.find((target) => target.name === name)

        for (const [propertyName, declarations] of properties) {
          // Each contribution is created by pushing at least one source.
          const source = declarations[declarations.length - 1]
          const candidates: TimingSource[] = []

          for (const scope of [
            ...(state ? [{ state, target: stateTarget, declaration: state }] : []),
            { state: undefined, target: commonTarget, declaration: layer },
          ]) {
            const { target } = scope
            const property = target?.properties.find((item) => item.name === propertyName)

            if (property)
              candidates.push({
                layer,
                state: scope.state,
                target,
                property,
                declaration: property,
              })

            const sharedTiming = targetTiming(target, propertyName)

            if (sharedTiming)
              candidates.push({ layer, state: scope.state, target, declaration: sharedTiming })

            candidates.push({ layer, state: scope.state, declaration: scope.declaration })
          }

          const provider = candidates.find((candidate) => timingProvider(candidate.declaration))
          // Preserve evaluation/failure order: timing before value, including
          // contributions subsequently hidden by later layers.
          const timing = provider ? { value: mapTiming(provider) } : undefined
          const value = mapValue(source)

          yield {
            name,
            properties: [{ name: propertyName, value: { value, source, declarations }, timing }],
          }
        }
      }
    }
  }

  return cascadeTargets(contributions(), 'first', (previous, next) => ({
    ...next,
    declarations: [...(previous?.declarations ?? []), ...next.declarations],
  })).map((target) => ({
    name: target.name,
    properties: target.properties.map((property) => ({
      name: property.name,
      value: property.value.value,
      source: property.value.source,
      declarations: property.value.declarations,
      timing: property.timing,
    })),
  }))
}

export function transitionPropertySources(
  transition: Transition | undefined,
  targetName: string,
  propertyName: string,
) {
  const target = transition?.targets.find((item) => item.name === targetName)
  const property = target?.properties.find((item) => item.name === propertyName)
  const timing = timingProvider<TimingDeclaration>(
    property,
    targetTiming(target, propertyName),
    transition,
  )

  return { target, property, timing }
}
