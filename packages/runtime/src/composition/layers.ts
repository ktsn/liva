import type { RuntimeValue } from '../evaluation/reactive-value.ts'
import {
  compositionLayerSelection,
  resolveLayerCascade,
  targetTiming,
  transitionPropertySources,
  type LayerSelection,
} from './layer-cascade.ts'
import { timingValue } from '../evaluation/timing-values.ts'
import { normalizeFrames, type ResolvedTrack } from './resolve.ts'
import type { Definition, GuardedTransition, Property, Target } from '../model/definition.ts'
import {
  evaluate,
  renderProperty,
  renderFrame,
  renderTransition,
  type VariableValues,
} from '../evaluation/expression.ts'

import type { RenderedProperty, RenderedState, RenderedFrame } from '../model/presentation.ts'

export interface LayerProperty extends RenderedProperty {
  readonly owner: string
  /** Authored observations/reference source when this declaration was expanded into a canonical CSS field. */
  readonly authored?: ResolvedTrack
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
  readonly presentation: Omit<RenderedState, 'targets'> & {
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
  event?: RuntimeValue,
): LayerResolution {
  return resolveLayerSelection(definition, values, previous, advance, undefined, event)
}

function resolveLayerSelection(
  definition: Definition,
  values: VariableValues,
  previous: ReadonlyMap<string, string>,
  advance: boolean,
  selection?: Composition,
  event?: RuntimeValue,
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
              transition.from === current &&
              (!transition.event ||
                (event !== undefined && evaluate(transition.event, values) === event)) &&
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

  const targets = resolveLayerCascade(
    selectLayers(),
    ({ layer, property }) => ({
      ...renderProperty(property, values),
      owner: layer.name,
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

  return layerPropertyDiffers(before, property)
}

/** Compares plain evaluated declarations, also used to reuse unchanged normalized source data. */
export function layerPropertyDiffers(
  before: LayerProperty | undefined,
  property: LayerProperty,
): boolean {
  return (
    before?.value !== property.value ||
    before?.completionValue !== property.completionValue ||
    before?.owner !== property.owner ||
    JSON.stringify(before?.timing) !== JSON.stringify(property.timing) ||
    JSON.stringify(before?.keyframes) !== JSON.stringify(property.keyframes)
  )
}

/** Stable identity for one authored target/property declaration. */
export const layerPropertyKey = (target: string, property: string) => `${target}\0${property}`

/** Finds changed authored declarations using the same value/owner/timing/frame comparison as track selection. */
export function changedLayerProperties(
  previous: LayerResolution,
  next: LayerResolution,
): ReadonlySet<string> {
  return new Set(
    next.presentation.targets.flatMap((target) =>
      target.properties
        .filter((property) => layerPropertyChanged(previous, target.name, property))
        .map((property) => layerPropertyKey(target.name, property.name)),
    ),
  )
}

/** Finds declarations removed by the supplied resolved selection, without reevaluating conditions or guards. */
export function removedLayerProperties(
  previous: LayerResolution,
  next: LayerResolution,
): ReadonlySet<string> {
  return new Set(
    previous.presentation.targets.flatMap((target) =>
      target.properties
        .filter(
          (property) =>
            !next.presentation.targets
              .find((item) => item.name === target.name)
              ?.properties.some((item) => item.name === property.name),
        )
        .map((property) => layerPropertyKey(target.name, property.name)),
    ),
  )
}

/** Detects explicit transition instructions without evaluating their timing/frame expressions. */
export function layerTransitionApplies(
  transition: import('../model/definition.ts').Transition | undefined,
  target: string,
  property: string,
): boolean {
  const sources = transitionPropertySources(transition, target, property)

  return sources.property !== undefined || sources.timing !== undefined
}

/** Identifies new ordinary changes before receiver observations; state/guard selection is already supplied. */
export function prepareLayerTakeovers(
  previous: LayerResolution,
  next: LayerResolution,
): readonly { target: string; property: string }[] {
  const changed = new Set([
    ...changedLayerProperties(previous, next),
    ...removedLayerProperties(previous, next),
  ])

  if (previous.transitions !== next.transitions) {
    for (const target of next.presentation.targets) {
      for (const property of target.properties) {
        if (
          layerTransitionApplies(
            next.transitions.get(property.owner)?.transition,
            target.name,
            property.name,
          )
        )
          changed.add(layerPropertyKey(target.name, property.name))
      }
    }
  }

  const properties = new Map<string, { target: string; property: string }>()

  for (const target of [...previous.presentation.targets, ...next.presentation.targets]) {
    for (const property of target.properties) {
      const key = layerPropertyKey(target.name, property.name)

      if (changed.has(key)) properties.set(key, { target: target.name, property: property.name })
    }
  }

  return [...properties.values()]
}

/** A selected playback unit optionally retaining its authored observation/reference source. */
export interface LayerTrack extends ResolvedTrack {
  readonly authored?: ResolvedTrack
}

/** A selected track whose omitted starting endpoint still requires a displayed observation. */
export interface LayerTrackTemplate extends Omit<LayerTrack, 'keyframes'> {
  readonly keyframes?: readonly RenderedFrame[]
  readonly animationDestinationValue?: string
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
      if (
        !layerPropertyChanged(previous, target.name, property) &&
        !layerTransitionApplies(transition, target.name, property.name) &&
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
        timing,
        destinationValue: property.completionValue ?? property.value,
        ...(property.completionValue !== undefined
          ? { animationDestinationValue: property.value }
          : {}),
        implicitStart: !explicit?.some((frame) => frame.offset === 0),
        directionalOwner:
          instruction ||
          rendered?.timing ||
          targetTiming(rendered?.targets[0], property.name)?.timing
            ? owner
            : undefined,
        ownerState: next.states.get(owner),
        keyframes: explicit,
        ...(property.authored ? { authored: property.authored } : {}),
      }
    }
  }
}

/** Completes one selected track using a supplied displayed CSS value for an omitted 0% endpoint. */
export function completeLayerTrack(template: LayerTrackTemplate, displayed: string): LayerTrack {
  return {
    ...template,
    keyframes: normalizeFrames(
      displayed,
      template.animationDestinationValue ?? template.destinationValue,
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
