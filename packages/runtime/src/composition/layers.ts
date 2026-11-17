import { resolveSelectedLayout } from './layout.ts'
import type { ResolvedLayoutConfiguration } from '../model/layout.ts'
import type { RuntimeValue } from '../evaluation/reactive-value.ts'
import {
  cascadeProperty,
  compositionLayerSelection,
  resolveLayerCascade,
  targetTiming,
  transitionPropertySources,
  type LayerSelection,
} from './layer-cascade.ts'
import { timingValue } from '../evaluation/timing-values.ts'
import { normalizeFrames, type ResolvedTrack } from './resolve.ts'
import {
  isCssProperty,
  type Declaration,
  type Definition,
  type GuardedTransition,
  type Property,
  type Target,
} from '../model/definition.ts'
import {
  evaluate,
  renderProperty,
  renderFrame,
  renderTransition,
  type VariableValues,
} from '../evaluation/expression.ts'

import {
  layerPropertyKey,
  type RenderedProperty,
  type RenderedState,
  type RenderedFrame,
} from '../model/presentation.ts'

export interface LayerProperty extends RenderedProperty {
  readonly owner: string
  readonly sourceProperty?: string
  readonly sourceDestination?: string
}

/** Evaluated cascade input. Receiver scopes use executor-issued identities, never elements. */
export interface EvaluatedLayer {
  readonly id: string
  readonly scope?: readonly number[]
  readonly targets: readonly Target<LayerProperty>[]
}

/** Composes values and timing independently, in source order, for one receiver. */
export function composeEvaluatedLayers(
  layers: readonly EvaluatedLayer[],
  receiver?: number,
  declarationOrder = true,
): readonly Target<LayerProperty>[] {
  const targets = new Map<string, Map<string, LayerProperty>>()

  for (const layer of layers) {
    if (layer.scope && (receiver === undefined || !layer.scope.includes(receiver))) continue

    for (const target of layer.targets) {
      const properties = targets.get(target.name) ?? new Map<string, LayerProperty>()

      targets.set(target.name, properties)

      for (const property of target.properties) {
        cascadeProperty(properties, property.name, property, property.timing, declarationOrder)
      }
    }
  }

  return [...targets].map(([name, properties]) => ({ name, properties: [...properties.values()] }))
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
  /**
   * Settings for this resolved update, including its temporary directional timing.
   * These never enter CSS presentation/tracks; Runtime.layout reads persistent timing.
   */
  readonly layout?: readonly ResolvedLayoutConfiguration[]
  /** Ordinary declarations before controller CSS/fallback formatting; retained by reference. */
  readonly declarations?: LayerResolution['presentation']
  readonly composition: Composition
  readonly states: ReadonlyMap<string, string>
  readonly transitions: ReadonlyMap<string, GuardedTransition>
  readonly presentation: Omit<RenderedState, 'targets'> & {
    readonly targets: readonly Target<LayerProperty>[]
  }
}

export function layerTargets(definition: Definition): readonly Target<Property>[] {
  return declarationTargets(definition).map((target) => ({
    ...target,
    properties: target.properties.filter(isCssProperty),
  }))
}

/** Every potential authored receiver, including targets with only layout declarations. */
export function declarationTargets(definition: Definition): readonly Target<Declaration>[] {
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
  event?: RuntimeValue,
): LayerResolution {
  return resolveLayerSelection(definition, values, { kind: 'live', previous, advance, event })
}

/** Explicit selections carry their validated transient timing into the same resolution pass. */
type LayerSelectionMode =
  | {
      readonly kind: 'live'
      readonly previous: ReadonlyMap<string, string>
      readonly advance: boolean
      readonly event?: RuntimeValue
    }
  | {
      readonly kind: 'composition'
      readonly composition: Composition
      readonly transitions: ReadonlyMap<string, GuardedTransition>
    }

function resolveLayerSelection(
  definition: Definition,
  values: VariableValues,
  mode: LayerSelectionMode,
): LayerResolution {
  const activeLayers: Record<string, boolean> = Object.create(null)
  const states = new Map<string, string>()
  const transitions = new Map<string, GuardedTransition>(
    mode.kind === 'composition' ? mode.transitions : undefined,
  )

  function* selectLayers(): Generator<LayerSelection> {
    if (mode.kind === 'composition') {
      Object.assign(activeLayers, mode.composition.layers)

      for (const selected of compositionLayerSelection(definition, mode.composition)) {
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

      const current = mode.previous.get(layer.name) ?? layer.initialState
      const selected = mode.advance
        ? layer.transitions?.findLast(
            (transition) =>
              transition.from === current &&
              (!transition.event ||
                (mode.event !== undefined && evaluate(transition.event, values) === mode.event)) &&
              evaluate(transition.when, values) === true,
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

  const selectedLayers = [...selectLayers()]
  const evaluated = selectedLayers.map((selected): EvaluatedLayer => ({
    id: selected.layer.name,
    targets: resolveLayerCascade(
      [selected],
      ({ layer, property }) => ({ ...renderProperty(property, values), owner: layer.name }),
      // Timing is mapped only when the declaration supplies a timing value or expression.
      ({ declaration }) =>
        declaration.timingExpression
          ? timingValue(evaluate(declaration.timingExpression, values))
          : declaration.timing!,
    ).map((target) => ({
      name: target.name,
      properties: target.properties.map((property) => ({
        ...property.value,
        timing: property.timing,
      })),
    })),
  }))

  return {
    layout: resolveSelectedLayout(selectedLayers, values, transitions),
    composition: { layers: activeLayers, states: Object.fromEntries(states) },
    states,
    transitions,
    presentation: {
      name: '@layers',
      targets: composeEvaluatedLayers(evaluated, undefined, false),
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

  const transitions = compositionTransitions(definition, composition, from, selected)

  return resolveLayerSelection(definition, values, {
    kind: 'composition',
    composition,
    transitions,
  })
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

/** Authored target/property declarations absent from the next resolved presentation. */
export function removedLayerProperties(
  previous: LayerResolution,
  next: LayerResolution,
): Set<string> {
  const removed = new Set<string>()

  for (const target of previous.presentation.targets) {
    for (const property of target.properties) {
      if (
        !next.presentation.targets
          .find((item) => item.name === target.name)
          ?.properties.some((item) => item.name === property.name)
      )
        removed.add(layerPropertyKey(target.name, property.name))
    }
  }

  return removed
}

/** Logical declarations changed by values, ownership, timing, removal, or an explicit transition. */
export function changedLayerProperties(
  previous: LayerResolution,
  next: LayerResolution,
): Set<string> {
  const changed = new Set<string>()

  for (const target of next.presentation.targets) {
    for (const property of target.properties) {
      const transition = next.transitions.get(property.owner)?.transition
      const sources = transitionPropertySources(transition, target.name, property.name)

      if (
        layerPropertyChanged(previous, target.name, property) ||
        sources.property ||
        sources.timing
      )
        changed.add(layerPropertyKey(target.name, property.name))
    }
  }

  for (const key of removedLayerProperties(previous, next)) changed.add(key)

  return changed
}

/** A selected track whose omitted starting endpoint still requires a displayed observation. */
export interface LayerTrackTemplate extends Omit<ResolvedTrack, 'keyframes'> {
  readonly keyframes?: readonly RenderedFrame[]
}

/**
 * Selects and evaluates track instructions without observing receiving elements.
 * @yields Selected timing and authored frames, before omitted endpoints are completed.
 */
export function* layerTrackTemplates(
  previous: LayerResolution,
  next: LayerResolution,
  values: VariableValues,
  warn: (message: string) => void,
  retarget: (target: string, property: string) => boolean,
): Generator<LayerTrackTemplate> {
  for (const target of next.presentation.targets) {
    for (const property of target.properties) {
      const owner = property.owner
      const transition = next.transitions.get(owner)?.transition
      const { target: transitionTarget, property: instruction } = transitionPropertySources(
        transition,
        target.name,
        property.name,
      )
      const sharedTiming = targetTiming(transitionTarget, property.name)

      if (
        !layerPropertyChanged(previous, target.name, property) &&
        !instruction &&
        !transition?.timingExpression &&
        !transition?.timing &&
        !sharedTiming?.timingExpression &&
        !sharedTiming?.timing &&
        !retarget(target.name, property.name) &&
        !(property.sourceProperty && retarget(target.name, property.sourceProperty))
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

      if (!timing || property.binding) continue

      const explicit =
        override?.keyframes?.map((frame) => renderFrame(frame, values)) ?? property.keyframes
      const endpoint = explicit?.find((frame) => frame.offset === 1)

      if (endpoint && endpoint.value !== property.value) {
        warn(
          `Transition endpoint differs from resolved style: ${target.name}.${property.name}; completion restores ${property.value}`,
        )
      }

      yield {
        target: target.name,
        property: property.name,
        owner: property.owner,
        sourceProperty: property.sourceProperty,
        sourceDestination: property.sourceDestination,
        timing,
        destinationValue: property.value,
        implicitStart: !explicit?.some((frame) => frame.offset === 0),
        directionalOwner:
          instruction ||
          rendered?.timing ||
          targetTiming(rendered?.targets[0], property.name)?.timing
            ? owner
            : undefined,
        ownerState: next.states.get(owner),
        keyframes: explicit,
      }
    }
  }
}

/** Completes one selected track using a supplied displayed CSS value for an omitted 0% endpoint. */
export function completeLayerTrack(template: LayerTrackTemplate, displayed: string): ResolvedTrack {
  return {
    ...template,
    keyframes: normalizeFrames(
      displayed,
      template.destinationValue,
      template.keyframes,
      template.timing,
    ),
  }
}

/** Compatibility resolver retaining per-track observation and diagnostic ordering. */
export function resolveLayerTracks(
  previous: LayerResolution,
  next: LayerResolution,
  values: VariableValues,
  displayed: (target: string, property: string) => string,
  warn: (message: string) => void,
  retarget: (target: string, property: string) => boolean = () => false,
): ResolvedTrack[] {
  const tracks: ResolvedTrack[] = []

  for (const template of layerTrackTemplates(previous, next, values, warn, retarget)) {
    tracks.push(completeLayerTrack(template, displayed(template.target, template.property)))
  }

  return tracks
}
