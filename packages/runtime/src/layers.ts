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

export interface LayerResolution {
  readonly states: ReadonlyMap<string, string>
  readonly transitions: ReadonlyMap<string, GuardedTransition>
  readonly presentation: Omit<State, 'targets'> & {
    readonly targets: readonly Target<LayerProperty>[]
  }
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
  const targets = new Map<string, Map<string, LayerProperty>>()
  const timings = new Map<string, Map<string, NonNullable<Property['timing']>>>()

  const contribute = (layerName: string, contribution: readonly Target<Property>[]) => {
    for (const target of contribution) {
      let properties = targets.get(target.name)

      if (!properties) {
        properties = new Map()
        targets.set(target.name, properties)
        timings.set(target.name, new Map())
      }

      for (const property of target.properties) {
        const timing = property.timingExpression
          ? timingValue(evaluate(property.timingExpression, values))
          : property.timing

        // Timing and property maps are initialized together for each target.
        if (timing) timings.get(target.name)!.set(property.name, timing)

        properties.set(property.name, {
          ...property,
          owner: layerName,
          value: renderValue(property, values),
          keyframes: property.keyframes?.map((frame) => renderFrame(frame, values)),
        })
      }
    }
  }

  for (const layer of definition.layers ?? []) {
    if (layer.when && evaluate(layer.when, values) !== true) continue

    contribute(layer.name, layer.targets)

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

    contribute(layer.name, state.targets)
  }

  return {
    states,
    transitions,
    presentation: {
      name: '@layers',
      targets: [...targets].map(([name, properties]) => ({
        name,
        properties: [...properties.values()].map((property) => ({
          ...property,
          timing: timings.get(name)?.get(property.name),
        })),
      })),
    },
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
      const instruction = transition?.targets
        .find((item) => item.name === target.name)
        ?.properties.find((item) => item.name === property.name)
      if (
        !layerPropertyChanged(previous, target.name, property) &&
        !instruction &&
        !retarget(target.name, property.name)
      )
        continue

      const override = instruction
        ? renderTransition({ targets: [{ name: target.name, properties: [instruction] }] }, values)
            .targets[0].properties[0]
        : undefined
      const timing =
        override?.timing ?? (instruction ? transition?.timing : undefined) ?? property.timing

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
        directionalOwner: instruction ? owner : undefined,
        ownerState: next.states.get(owner),
        keyframes: normalizeFrames(
          displayed(target.name, property.name),
          property.value,
          explicit,
          timing,
          true,
        ),
      })
    }
  }

  return tracks
}
