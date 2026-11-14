import {
  layerPropertyChanged,
  resolveLayerTracks,
  type LayerResolution,
} from '../composition/layers.ts'
import type { ResolvedTrack } from '../composition/resolve.ts'
import type { Definition } from '../model/definition.ts'
import type { VariableValues } from '../evaluation/expression.ts'

export const layerPropertyKey = (target: string, property: string) => `${target}\0${property}`

export function orderedResolution(
  resolution: LayerResolution,
  definition: Definition,
): LayerResolution {
  const priority = (
    target: string,
    property: LayerResolution['presentation']['targets'][number]['properties'][number],
  ): readonly number[] => {
    const layerIndex = definition.layers.findIndex((layer) => layer.name === property.owner)
    // Presentation owners are emitted by resolveLayers from this definition.
    const layer = definition.layers[layerIndex]
    const state = layer.states?.find(
      (candidate) => candidate.name === resolution.states.get(layer.name),
    )
    const stateProperty =
      state?.targets
        .find((candidate) => candidate.name === target)
        ?.properties.findIndex(
          (candidate) =>
            candidate.name === property.name &&
            (candidate.value.kind !== 'binding' || property.binding !== undefined),
        ) ?? -1
    const commonProperty =
      layer.targets
        .find((candidate) => candidate.name === target)
        ?.properties.findIndex((candidate) => candidate.name === property.name) ?? -1

    return [
      layerIndex,
      stateProperty >= 0 ? 1 : 0,
      stateProperty >= 0 ? stateProperty : commonProperty,
    ]
  }

  return {
    ...resolution,
    presentation: {
      ...resolution.presentation,
      targets: resolution.presentation.targets.map((target) => ({
        ...target,
        properties: target.properties.toSorted((left, right) => {
          const a = priority(target.name, left)
          const b = priority(target.name, right)

          return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
        }),
      })),
    },
  }
}

/** Canonical addresses captured for declarations on one receiving element. */
export type DeclarationAddresses = readonly {
  readonly name: string
  readonly addresses: readonly string[]
}[]

/** Tests the target-wide cascade using receiver-specific writing-context facts. */
export function ownsCanonicalProperty(
  declarations: DeclarationAddresses,
  sourceProperty: string,
  canonicalProperty: string,
): boolean {
  const candidates = declarations.filter((declaration) =>
    declaration.addresses.includes(canonicalProperty),
  )

  if (!candidates.some((declaration) => declaration.name === sourceProperty)) return true

  // The source declaration is a candidate, so the filtered list is nonempty.
  return candidates[candidates.length - 1].name === sourceProperty
}

export interface LayerPlanningSnapshot {
  readonly previous: LayerResolution
  readonly next: LayerResolution
  readonly values: VariableValues
  readonly displayed: ReadonlyMap<string, string>
  readonly receivers: readonly {
    readonly target: string
    readonly addresses: DeclarationAddresses
  }[]
  readonly active: readonly { readonly track: ResolvedTrack }[]
  readonly retargets: ReadonlySet<string>
}

/**
 * Plans logical property changes using immutable phase-specific observations.
 * Reuses layer track resolution for timing, explicit frames, endpoint completion,
 * and declaration identity. Canonical address facts include every receiver for a
 * target; callers must not substitute one receiver's writing context for the others.
 * The returned sets are owned by the caller and may accumulate expanded track names.
 */
export function planLayerChange(snapshot: LayerPlanningSnapshot) {
  const { previous, next } = snapshot
  const changed = new Set(snapshot.retargets)

  for (const { track } of snapshot.active) {
    if (
      track.directionalOwner !== undefined &&
      next.states.get(track.directionalOwner) !== track.ownerState
    ) {
      changed.add(layerPropertyKey(track.target, track.property))
    }
  }

  const removedProperties = new Set(
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
  const diagnostics: string[] = []
  const tracks = resolveLayerTracks(
    previous,
    next,
    snapshot.values,
    (target, property) => {
      const value = snapshot.displayed.get(layerPropertyKey(target, property))

      if (value === undefined) throw new Error(`Missing displayed snapshot: ${target}.${property}`)

      return value
    },
    (message) => diagnostics.push(message),
    (target, property) => changed.has(layerPropertyKey(target, property)),
  )

  for (const target of next.presentation.targets) {
    for (const property of target.properties) {
      if (!layerPropertyChanged(previous, target.name, property)) continue

      changed.add(layerPropertyKey(target.name, property.name))

      for (const receiver of snapshot.receivers.filter((item) => item.target === target.name)) {
        for (const declaration of receiver.addresses) {
          if (declaration.name !== property.name) continue

          for (const address of declaration.addresses)
            changed.add(layerPropertyKey(target.name, address))
        }
      }
    }
  }

  return { changed, removedProperties, tracks, diagnostics }
}

export interface ActiveEffectMetadata {
  readonly id: number
  readonly target: string
  readonly sourceProperty: string
  readonly property: string
}

/** Selects affected effect identities after receiver-specific track expansion. */
export function replacedEffects(
  active: readonly ActiveEffectMetadata[],
  changed: ReadonlySet<string>,
  removed: ReadonlySet<string>,
): readonly number[] {
  return active
    .filter(
      (effect) =>
        removed.has(layerPropertyKey(effect.target, effect.sourceProperty)) ||
        changed.has(layerPropertyKey(effect.target, effect.sourceProperty)) ||
        changed.has(layerPropertyKey(effect.target, effect.property)),
    )
    .map((effect) => effect.id)
}
