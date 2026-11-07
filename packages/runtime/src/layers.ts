import {
  compositionLayerSelection,
  resolveLayerCascade,
  transitionPropertySources,
  type LayerSelection,
} from './layer-cascade.ts'
import { timingValue } from './timing-values.ts'
import { normalizeFrames, type ResolvedTrack } from './resolve.ts'
import type { Definition, GuardedTransition, Property, State, Target } from './definition.ts'
import {
  evaluate,
  renderValue,
  renderFrame,
  renderTransition,
  type VariableValues,
} from './expression.ts'

interface LayerProperty extends Property {
  readonly owner: string
}

export interface Composition {
  readonly layers: Readonly<Record<string, boolean>>
  readonly states: Readonly<Record<string, string>>
}

export interface CompositionTransition {
  readonly layer: string
  readonly index: number
}

export interface LayerResolution {
  readonly composition: Composition
  readonly states: ReadonlyMap<string, string>
  readonly transitions: ReadonlyMap<string, GuardedTransition>
  readonly presentation: Omit<State, 'targets'> & {
    readonly targets: readonly Target<LayerProperty>[]
  }
}

export function layerTargets(definition: Definition): readonly Target<Property>[] {
  return definition.layers.flatMap((layer) => [
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
  return resolveLayerSelection(definition, values, previous, advance)
}

function resolveLayerSelection(
  definition: Definition,
  values: VariableValues,
  previous: ReadonlyMap<string, string>,
  advance: boolean,
  selection?: Composition,
): LayerResolution {
  const activeLayers: Record<string, boolean> = Object.create(null)
  const states = new Map<string, string>()
  const transitions = new Map<string, GuardedTransition>()

  function* selectLayers(): Generator<LayerSelection> {
    if (selection) {
      Object.assign(activeLayers, selection.layers)

      for (const selected of compositionLayerSelection(definition, selection)) {
        if (selected.state) states.set(selected.layer.name, selected.state.name)

        yield selected
      }

      return
    }

    for (const layer of definition.layers) {
      const active = !layer.when || evaluate(layer.when, values) === true

      if (!layer.states?.length) activeLayers[layer.name] = active

      if (!active) continue

      if (!layer.states?.length) {
        yield { layer }

        continue
      }

      const current = previous.get(layer.name) ?? layer.initialState
      const selected = advance
        ? layer.transitions?.findLast(
            (transition) =>
              transition.from === current && evaluate(transition.when, values) === true,
          )
        : undefined
      const next = selected?.to ?? current
      const state = layer.states.find((candidate) => candidate.name === next)

      if (!state) throw new Error(`Unknown current state in layer ${layer.name}: ${next}`)

      states.set(layer.name, state.name)

      if (selected) transitions.set(layer.name, selected)

      yield { layer, state }
    }
  }

  const targets = resolveLayerCascade(
    selectLayers(),
    ({ layer, property }) => ({
      ...property,
      owner: layer.name,
      value: renderValue(property, values),
      keyframes: property.keyframes?.map((frame) => renderFrame(frame, values)),
    }),
    // The cascade invokes mapTiming only for a declaration with a timing expression or value.
    ({ declaration }) =>
      declaration.timingExpression
        ? timingValue(evaluate(declaration.timingExpression, values))
        : declaration.timing!,
  )

  return {
    composition: { layers: activeLayers, states: Object.fromEntries(states) },
    states,
    transitions,
    presentation: {
      name: '@layers',
      targets: targets.map((target) => ({
        name: target.name,
        properties: target.properties.map((property) => ({
          ...property.value,
          timing: property.timing,
        })),
      })),
    },
  }
}

export function resolveComposition(
  definition: Definition,
  values: VariableValues,
  composition: Composition,
  from?: Composition,
  selected: readonly CompositionTransition[] = [],
): LayerResolution {
  validateComposition(definition, composition)

  if (from) validateComposition(definition, from)

  const result = resolveLayerSelection(
    definition,
    values,
    new Map(Object.entries(composition.states)),
    false,
    composition,
  )

  return { ...result, transitions: compositionTransitions(definition, composition, from, selected) }
}

export function compositionTransitions(
  definition: Definition,
  composition: Composition,
  from: Composition | undefined,
  selected: readonly CompositionTransition[],
): ReadonlyMap<string, GuardedTransition> {
  const transitions = new Map<string, GuardedTransition>()

  for (const identity of selected) {
    const layer = definition.layers.find((candidate) => candidate.name === identity.layer)
    const transition = Number.isInteger(identity.index)
      ? layer?.transitions?.[identity.index]
      : undefined

    if (
      !transition ||
      !from ||
      transition.from !== from.states[identity.layer] ||
      transition.to !== composition.states[identity.layer] ||
      transitions.has(identity.layer)
    ) {
      throw new Error(`Invalid composition transition: ${identity.layer}[${identity.index}]`)
    }

    transitions.set(identity.layer, transition)
  }

  return transitions
}

function validateComposition(definition: Definition, composition: Composition): void {
  const layers = definition.layers
  const ordinary = layers.filter((layer) => !layer.states?.length)
  const stateful = layers.filter((layer) => layer.states?.length)

  if (
    Object.keys(composition.layers).length !== ordinary.length ||
    Object.keys(composition.states).length !== stateful.length ||
    ordinary.some(
      (layer) =>
        !Object.hasOwn(composition.layers, layer.name) ||
        typeof composition.layers[layer.name] !== 'boolean',
    ) ||
    stateful.some(
      (layer) =>
        !Object.hasOwn(composition.states, layer.name) ||
        !layer.states?.some((state) => state.name === composition.states[layer.name]),
    )
  ) {
    throw new Error('Invalid composition: supply every ordinary layer and stateful layer state')
  }
}

export function layerPropertyChanged(
  previous: LayerResolution,
  target: string,
  property: LayerProperty,
): boolean {
  const before = previous.presentation.targets
    .find((item) => item.name === target)
    ?.properties.find((item) => item.name === property.name)

  return (
    before?.value !== property.value ||
    before?.owner !== property.owner ||
    JSON.stringify(before?.timing) !== JSON.stringify(property.timing) ||
    JSON.stringify(before?.keyframes) !== JSON.stringify(property.keyframes)
  )
}

export function resolveLayerTracks(
  previous: LayerResolution,
  next: LayerResolution,
  values: VariableValues,
  displayed: (target: string, property: string) => string,
  warn: (message: string) => void,
  retarget: (target: string, property: string) => boolean = () => false,
): ResolvedTrack[] {
  const tracks: ResolvedTrack[] = []

  for (const target of next.presentation.targets) {
    for (const property of target.properties) {
      const owner = property.owner
      const transition = next.transitions.get(owner)?.transition
      const { target: transitionTarget, property: instruction } = transitionPropertySources(
        transition,
        target.name,
        property.name,
      )
      if (
        !layerPropertyChanged(previous, target.name, property) &&
        !instruction &&
        !transition?.timingExpression &&
        !transition?.timing &&
        !transitionTarget?.timingExpression &&
        !transitionTarget?.timing &&
        !retarget(target.name, property.name)
      )
        continue

      const rendered = transition
        ? renderTransition(
            {
              ...transition,
              targets: [
                {
                  ...transitionTarget,
                  name: target.name,
                  properties: [instruction ?? { name: property.name }],
                },
              ],
            },
            values,
          )
        : undefined
      const override = rendered?.targets[0].properties[0]
      const timing =
        transitionPropertySources(rendered, target.name, property.name).timing?.timing ??
        property.timing

      if (!timing) continue

      const explicit = override?.keyframes ?? property.keyframes
      const endpoint = override?.keyframes?.find((frame) => frame.offset === 1)

      if (endpoint && endpoint.value !== property.value) {
        warn(
          `Transition endpoint differs from resolved style: ${target.name}.${property.name}; completion restores ${property.value}`,
        )
      }

      tracks.push({
        target: target.name,
        property: property.name,
        timing,
        destinationValue: property.value,
        implicitStart: !explicit?.some((frame) => frame.offset === 0),
        directionalOwner:
          instruction || rendered?.timing || rendered?.targets[0].timing ? owner : undefined,
        ownerState: next.states.get(owner),
        keyframes: normalizeFrames(
          displayed(target.name, property.name),
          property.value,
          explicit,
          timing,
        ),
      })
    }
  }

  return tracks
}
