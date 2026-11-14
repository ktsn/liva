import { sampleSpring } from '../motion/spring.ts'
import {
  prepareSpringMotion,
  type SpringObservation,
  type MotionSample,
} from '../motion/property-motion.ts'
import type { RenderedFrame } from '../model/presentation.ts'
import {
  layerPropertyChanged,
  layerTrackTemplates,
  completeLayerTrack,
  type LayerTrackTemplate,
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
  readonly active: readonly { readonly track: ResolvedTrack }[]
  readonly retargets: ReadonlySet<string>
}

/**
 * Selects changed declarations and track instructions before browser observation.
 * Reuses layer resolution for timing, explicit frames, and declaration identity.
 * Returned templates identify the omitted endpoints that need displayed snapshots;
 * unchanged declarations need no observation.
 */
export function prepareLayerChange(snapshot: LayerPlanningSnapshot) {
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
  const templates = [
    ...layerTrackTemplates(
      previous,
      next,
      snapshot.values,
      (message) => diagnostics.push(message),
      (target, property) => changed.has(layerPropertyKey(target, property)),
    ),
  ]

  for (const target of next.presentation.targets) {
    for (const property of target.properties) {
      if (!layerPropertyChanged(previous, target.name, property)) continue

      changed.add(layerPropertyKey(target.name, property.name))
    }
  }

  return { changed, removedProperties, templates, diagnostics }
}

export interface LayerChangePreparation {
  readonly changed: ReadonlySet<string>
  readonly removedProperties: ReadonlySet<string>
  readonly templates: readonly LayerTrackTemplate[]
  readonly diagnostics: readonly string[]
}

/**
 * Completes a prepared change with post-controller displayed/canonical facts.
 * Only implicit starting endpoints require displayed observations. Receiver facts
 * cover affected targets and include all their declarations in cascade order.
 */
export function planLayerChange(
  preparation: LayerChangePreparation,
  displayed: ReadonlyMap<string, string>,
  receivers: readonly { readonly target: string; readonly addresses: DeclarationAddresses }[],
) {
  const changed = new Set(preparation.changed)
  const tracks = preparation.templates.map((template) => {
    const source = template.implicitStart
      ? displayed.get(layerPropertyKey(template.target, template.property))
      : ''

    if (source === undefined)
      throw new Error(`Missing displayed snapshot: ${template.target}.${template.property}`)

    return completeLayerTrack(template, source)
  })

  for (const receiver of receivers) {
    for (const declaration of receiver.addresses) {
      if (!preparation.changed.has(layerPropertyKey(receiver.target, declaration.name))) continue

      for (const address of declaration.addresses)
        changed.add(layerPropertyKey(receiver.target, address))
    }
  }

  return {
    changed,
    removedProperties: preparation.removedProperties,
    tracks,
    diagnostics: preparation.diagnostics,
  }
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

/** Final, browser-independent playback instructions for one canonical property. */
export interface TrackPlan {
  readonly id: number
  readonly receiver: number
  readonly track: ResolvedTrack
  readonly sourceProperty: string
  readonly sourceDestination: string
  readonly frames: readonly RenderedFrame[]
  readonly durationMs: number
  readonly easing: string
  readonly fill: 'both' | 'backwards'
  readonly reference?: string
  /** Pure analytic sampler using effect-local milliseconds and canonical units/ms. */
  readonly trajectory?: (milliseconds: number) => MotionSample
}

export interface TrackSnapshot {
  readonly id: number
  readonly receiver: number
  readonly source: ResolvedTrack
  readonly track: ResolvedTrack
  readonly declarations: DeclarationAddresses
  readonly displayed?: string
  readonly interrupted: boolean
  readonly motion?: SpringObservation
  readonly reference?: string
}

/** Scalar timing, shared by ordinary playback and manually scrubbed previews. */
export function trackTiming(track: ResolvedTrack) {
  return track.timing.kind === 'tween'
    ? { durationMs: track.timing.durationMs, easing: 'linear' }
    : sampleSpring(track.timing)
}

/** Determines observation needs before the executor reads displayed/numeric values. */
export function trackObservationNeeds(
  track: ResolvedTrack,
  interrupted: boolean,
  handoff: boolean,
) {
  return {
    displayed: track.implicitStart === true || interrupted,
    motion:
      handoff &&
      track.timing.kind !== 'tween' &&
      track.keyframes.every((frame) => frame.offset === 0 || frame.offset === 1),
  }
}

/**
 * Plans ownership, displayed-start interruption, scalar or supported numeric spring
 * playback from supplied facts. No clock, browser state, or native effect is read.
 * Returns undefined when a later declaration owns the canonical property. Missing
 * requested displayed observations reject planning before effect replacement.
 */
export function planTrack(
  snapshot: TrackSnapshot,
  timing: ReturnType<typeof trackTiming>,
  fill: TrackPlan['fill'],
): TrackPlan | undefined {
  const { source, track } = snapshot

  if (!ownsCanonicalProperty(snapshot.declarations, source.property, track.property))
    return undefined

  const needs = trackObservationNeeds(track, snapshot.interrupted, snapshot.motion !== undefined)

  let frames = track.keyframes

  if (needs.displayed) {
    const displayed = snapshot.displayed

    if (displayed === undefined)
      throw new Error(`Missing displayed track snapshot: ${track.target}.${track.property}`)

    frames = frames.map((frame, index) => (index === 0 ? { ...frame, value: displayed } : frame))
  }

  const handoff =
    track.timing.kind !== 'tween' && snapshot.motion
      ? prepareSpringMotion(track.property, track.timing, needs.motion, snapshot.motion)
      : undefined

  return {
    id: snapshot.id,
    receiver: snapshot.receiver,
    track,
    sourceProperty: source.property,
    sourceDestination: source.destinationValue,
    frames: handoff?.frames ?? frames,
    durationMs: handoff?.durationMs ?? timing.durationMs,
    easing: handoff ? 'linear' : timing.easing,
    fill,
    reference: snapshot.reference,
    trajectory: handoff?.sample,
  }
}
