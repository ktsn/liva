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
import type { Definition, Expression } from '../model/definition.ts'
import type { VariableValues } from '../evaluation/expression.ts'

import { layerPropertyKey } from './execution-contracts.ts'
export { layerPropertyKey } from './execution-contracts.ts'

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

/** Receiver identities and lifecycle protection; no browser objects cross this boundary. */
export interface ReceiverFacts {
  readonly id: number
  readonly target: string
  /** Authored declarations protected by live lifecycle sessions on this receiver. */
  readonly protected: readonly string[]
}

export interface ReceiverAddresses extends ReceiverFacts {
  readonly addresses: DeclarationAddresses
}

/** Lifecycle resource identities and observed ownership; native sessions stay in the executor. */
export interface LifecycleFacts {
  readonly id: number
  readonly phase: 'enter' | 'leave'
  readonly finished: boolean
  readonly protected: readonly { readonly receiver: number; readonly property: string }[]
}

export interface PresentationFacts {
  readonly mode: 'live' | 'preparing-preview' | 'preview'
  readonly lifecycle: readonly LifecycleFacts[]
  readonly suspended: boolean
  readonly reduced: boolean
  readonly preserveLifecycle: boolean
  readonly receivers: readonly ReceiverFacts[]
  readonly active: readonly (ActiveEffectMetadata & {
    readonly receiver: number
    readonly sourceDestination: string
    readonly track: ResolvedTrack
  })[]
}

export interface ControllerBinding {
  readonly target: string
  readonly property: string
  readonly expression: Expression
}

/** Selects target-wide bindings before any live controller operation is requested. */
export function planControllerBindings(
  resolution: LayerResolution,
  receivers: readonly ReceiverAddresses[],
): ControllerBinding[] {
  return resolution.presentation.targets.flatMap((target) =>
    target.properties.flatMap((property) => {
      if (!property.binding) return []

      const obscured = receivers.some(
        (receiver) =>
          receiver.target === target.name &&
          receiver.addresses.some(
            (declaration) =>
              declaration.name === property.name &&
              declaration.addresses.some(
                (address) => !ownsCanonicalProperty(receiver.addresses, property.name, address),
              ),
          ),
      )

      return obscured
        ? []
        : [{ target: target.name, property: property.name, expression: property.binding }]
    }),
  )
}

/** Applies supplied controller CSS values, preserving normal fallback and source order. */
export function planControllerPresentation(
  resolution: LayerResolution,
  normal: LayerResolution,
  outputs: ReadonlyMap<string, string | undefined>,
  definition: Definition,
): LayerResolution {
  const targets = resolution.presentation.targets.map((target) => ({
    ...target,
    properties: target.properties.flatMap((property) => {
      if (!property.binding) return [property]

      const key = layerPropertyKey(target.name, property.name)

      if (!outputs.has(key)) return []

      const value = outputs.get(key)

      if (value !== undefined) return [{ ...property, value }]

      const fallback = normal.presentation.targets
        .find((item) => item.name === target.name)
        ?.properties.find((item) => item.name === property.name)

      return fallback ? [fallback] : []
    }),
  }))

  return orderedResolution(
    { ...resolution, presentation: { ...resolution.presentation, targets } },
    definition,
  )
}

/** Selects affected targets before requesting receiver-specific CSSOM addresses. */
export function layerObservationTargets(
  preparation: LayerChangePreparation,
  next: LayerResolution,
) {
  return new Set([
    ...preparation.templates.map((track) => track.target),
    ...next.presentation.targets
      .filter((target) =>
        target.properties.some((property) =>
          preparation.changed.has(layerPropertyKey(target.name, property.name)),
        ),
      )
      .map((target) => target.name),
  ])
}

export interface TrackCandidate {
  readonly receiver: number
  readonly source: ResolvedTrack
  readonly track: ResolvedTrack
  readonly declarations: DeclarationAddresses
  /** Whether a live lifecycle session owns this canonical property. */
  readonly protected: boolean
}

export interface TrackObservationRequest extends TrackCandidate {
  readonly interrupted: boolean
  readonly needs: ReturnType<typeof trackObservationNeeds>
  readonly reference: boolean
}

/** Filters canonical owners and requests only observations used by the final planner. */
export function planTrackObservations(
  candidates: readonly TrackCandidate[],
  active: PresentationFacts['active'],
  live: boolean,
) {
  const changed = new Set<string>()
  const requests: TrackObservationRequest[] = []

  for (const candidate of candidates) {
    const { source, track, receiver, declarations } = candidate

    if (!ownsCanonicalProperty(declarations, source.property, track.property)) continue

    changed.add(layerPropertyKey(track.target, track.property))

    if (live && candidate.protected) continue

    const interrupted =
      live &&
      active.some((effect) => effect.receiver === receiver && effect.property === track.property)

    requests.push({
      ...candidate,
      interrupted,
      needs: trackObservationNeeds(track, interrupted, live),
      reference: live,
    })
  }

  return { changed, requests }
}

export interface StyleWrite {
  readonly receiver: number
  readonly property: string
  readonly value: string
}

/** Source-ordered writes; omitted changed means a complete presentation, including previews. */
export function presentationWrites(
  resolution: LayerResolution,
  receivers: readonly ReceiverFacts[],
  changed?: ReadonlySet<string>,
  protectLifecycle = true,
): StyleWrite[] {
  return resolution.presentation.targets.flatMap((target) =>
    target.properties.flatMap((property) => {
      if (changed && !changed.has(layerPropertyKey(target.name, property.name))) return []

      return receivers
        .filter(
          (receiver) =>
            receiver.target === target.name &&
            (!protectLifecycle || !receiver.protected.includes(property.name)),
        )
        .map((receiver) => ({
          receiver: receiver.id,
          property: property.name,
          value: property.value,
        }))
    }),
  )
}

/** Complete application instructions. The executor materializes effects without replanning. */
export interface PresentationPlan {
  readonly resolution: LayerResolution
  readonly mode: 'live' | 'preview' | 'maintenance'
  readonly cancel: readonly number[]
  /** Restore owned inline declarations before applying writes, preserving external edits. */
  readonly restore: boolean
  readonly preserveLifecycle: boolean
  readonly writes: readonly StyleWrite[]
  readonly start: readonly TrackPlan[]
  /** Release settled registrations and cancel explicitly selected live sessions as superseded. */
  readonly lifecycle?: { readonly release: readonly number[]; readonly cancel: readonly number[] }
  /** Clear motion/reference history and frozen controller state before applying planned writes. */
  readonly resetMotion?: boolean
}

/**
 * Combines changed/removed target-property keys and completed tracks into a live plan.
 * Removing a declaration restores the owned presentation, then reapplies the full
 * cascade. Other updates write only changed declarations. Callers omit start tracks
 * when suspended or reduced motion is active; suspended plans still accept resolution.
 */
export function planPresentation(
  resolution: LayerResolution,
  facts: PresentationFacts,
  changed: ReadonlySet<string>,
  removed: ReadonlySet<string>,
  start: readonly TrackPlan[],
): PresentationPlan {
  return {
    resolution,
    mode: 'live',
    cancel: replacedEffects(facts.active, changed, removed),
    restore: !facts.suspended && removed.size > 0,
    preserveLifecycle: facts.preserveLifecycle,
    writes: facts.suspended
      ? []
      : presentationWrites(resolution, facts.receivers, removed.size > 0 ? undefined : changed),
    start,
  }
}

/** Preview acceptance is isolated from application composition and always supports manual seeking. */
export function planPreviewPresentation(
  resolution: LayerResolution,
  receivers: readonly ReceiverFacts[],
  start: readonly TrackPlan[],
): PresentationPlan {
  return {
    resolution,
    mode: 'preview',
    cancel: [],
    restore: true,
    preserveLifecycle: false,
    writes: presentationWrites(resolution, receivers, undefined, false),
    start,
  }
}

/** Reconciles only the completed receiver; stale effect IDs have no presentation work. */
export function planEffectCompletion(
  resolution: LayerResolution,
  facts: PresentationFacts,
  id: number,
): PresentationPlan | undefined {
  const effect = facts.active.find((entry) => entry.id === id)

  if (!effect) return undefined

  return {
    resolution,
    mode: 'live',
    cancel: [id],
    restore: false,
    preserveLifecycle: false,
    writes: [
      {
        receiver: effect.receiver,
        property: effect.sourceProperty,
        value: effect.sourceDestination,
      },
      ...presentationWrites(
        resolution,
        facts.receivers.filter((receiver) => receiver.id === effect.receiver),
      ),
    ],
    start: [],
  }
}

/** Reapplies the accepted cascade after restoration. Runtime requests this only for ready bindings. */
export function planReconciliation(
  resolution: LayerResolution,
  receivers: readonly ReceiverFacts[],
): PresentationPlan {
  return {
    resolution,
    mode: 'live',
    cancel: [],
    restore: false,
    preserveLifecycle: false,
    writes: presentationWrites(resolution, receivers),
    start: [],
  }
}

/** Ownership after lifecycle cleanup, including aliases of the same physical receiver. */
function remainingLifecycleReceivers(
  facts: PresentationFacts,
  sessions: readonly LifecycleFacts[],
): ReceiverFacts[] {
  return facts.receivers.map((receiver) => ({
    ...receiver,
    protected: receiver.protected.filter((property) =>
      sessions.some((session) =>
        session.protected.some(
          (address) => address.receiver === receiver.id && address.property === property,
        ),
      ),
    ),
  }))
}

/**
 * Settles live playback when reduced motion becomes active. Manual previews remain
 * seekable, ordinary effects and enter sessions stop, and active leaves retain ownership.
 * No expression evaluation or guard advancement is part of this plan.
 */
export function planMotionChange(
  resolution: LayerResolution,
  facts: PresentationFacts,
): PresentationPlan | undefined {
  if (!facts.reduced || facts.mode === 'preview') return undefined

  const remaining = facts.lifecycle.filter(
    (session) => session.phase === 'leave' && !session.finished,
  )

  return {
    resolution,
    mode: 'live',
    cancel: facts.active.map((effect) => effect.id),
    restore: true,
    preserveLifecycle: remaining.length > 0,
    writes: facts.suspended
      ? []
      : presentationWrites(resolution, remainingLifecycleReceivers(facts, remaining)),
    start: [],
    resetMotion: true,
    lifecycle: {
      release: facts.lifecycle.filter((session) => session.finished).map((session) => session.id),
      cancel: facts.lifecycle
        .filter((session) => session.phase === 'enter' && !session.finished)
        .map((session) => session.id),
    },
  }
}

/**
 * Releases all settled registrations together. A finished enter restores the current
 * application cascade only during live playback; other active sessions stay protected.
 * Cleanup during a manual preview leaves its presentation and native seeking untouched.
 */
export function planLifecycleSettlement(
  resolution: LayerResolution,
  facts: PresentationFacts,
): PresentationPlan | undefined {
  const finished = facts.lifecycle.filter((session) => session.finished)

  if (finished.length === 0) return undefined

  const remaining = facts.lifecycle.filter((session) => !session.finished)
  const restore = facts.mode === 'live' && finished.some((session) => session.phase === 'enter')

  return {
    resolution,
    mode: restore ? 'live' : 'maintenance',
    cancel: [],
    restore,
    preserveLifecycle: remaining.length > 0,
    writes:
      restore && !facts.suspended
        ? presentationWrites(resolution, remainingLifecycleReceivers(facts, remaining))
        : [],
    start: [],
    lifecycle: { release: finished.map((session) => session.id), cancel: [] },
  }
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
