import { prepareLayerTakeovers } from '../composition/layers.ts'
import type {
  ExecutionPort,
  PresencePreparation,
  RuntimeDiagnostic,
} from './execution-contracts.ts'
import type { LayerResolution } from '../composition/layers.ts'
import { composeRuntimeLayers } from '../composition/runtime-layers.ts'
import type { VariableValues } from '../evaluation/expression.ts'
import {
  prepareLayerChange,
  planLayerChange,
  layerObservationTargets,
  planTrackObservations,
  planTrack,
  trackTiming,
  planEffectChanges,
  presentationWrites,
  planReconciliation,
  planEffectCompletion,
  planMotionRetargets,
  planMotionHandoff,
  planLayerTakeovers,
  type PresentationPlan,
  type TrackPlan,
} from './presentation-planner.ts'

type ReceiverSnapshot = PresencePreparation['receivers'][number]

/** Reconstructs the accepted and candidate receiver cascades from immutable evaluated layers. */
function receiverChange(snapshot: ReceiverSnapshot) {
  const old = composeRuntimeLayers(snapshot.from, snapshot.id)
  const next = composeRuntimeLayers(snapshot.to, snapshot.id)

  return {
    previous: {
      ...snapshot.previous,
      presentation: {
        ...old,
        targets: old.targets.filter((target) =>
          snapshot.previous.presentation.targets.some((item) => item.name === target.name),
        ),
      },
    },
    next: {
      ...snapshot.normal,
      presentation: {
        ...next,
        targets: next.targets.filter((target) => snapshot.names.includes(target.name)),
      },
    },
  }
}

/** Shared synchronous planning coordination for live Runtime updates and retained detached presence. */
export function coordinatePresencePresentation(
  execution: ExecutionPort,
  next: LayerResolution,
  values: VariableValues,
  retargets: ReadonlySet<string>,
  report: (diagnostic: RuntimeDiagnostic) => void,
) {
  const facts = execution.preparePresence(next, values, retargets)
  const start: TrackPlan[] = []
  const cancel: number[] = []
  const writes: PresentationPlan['writes'][number][] = []
  const presentations: NonNullable<PresentationPlan['presentations']>[number][] = []

  try {
    for (const receiver of facts.receivers) {
      const change = receiverChange(receiver)
      const active = facts.active.filter((effect) => effect.receiver === receiver.id)
      const preparation = prepareLayerChange({ ...change, values, active, retargets })
      const displayed = execution.observeReceiverStarts(receiver.id, preparation.templates)
      const addresses = execution.observeReceiverAddresses(
        receiver.id,
        change.next,
        layerObservationTargets(preparation, change.next),
      )
      const plan = planLayerChange(preparation, displayed, addresses)

      for (const message of plan.diagnostics) report({ code: 'runtime.endpoint', message })

      if (!facts.reduced) {
        for (const source of plan.tracks) {
          const timing = trackTiming(source)

          if (timing.durationMs === 0) continue

          const declarations = addresses.find((item) => item.target === source.target)!.addresses
          const candidates = execution.expandTracks([
            { receiver: receiver.id, source, declarations },
          ])
          const observations = planTrackObservations(candidates, active, true)
          const snapshots = execution.observeTracks(observations.requests)

          for (const snapshot of snapshots) {
            const owner = change.next.presentation.targets
              .find((target) => target.name === source.target)
              ?.properties.find((property) => property.name === source.property)?.owner
            const operation =
              facts.operations.find((candidate) => candidate.layers.includes(owner!)) ??
              active.findLast(
                (effect) => effect.property === snapshot.track.property && !effect.finished,
              )?.operation ??
              facts.operations.findLast(
                (candidate) =>
                  !candidate.finished &&
                  candidate.bindings.some(
                    (binding) =>
                      binding.receiver === receiver.id &&
                      (binding.properties.includes(source.property) ||
                        binding.properties.includes(snapshot.track.property)),
                  ),
              )
            // Observation requests already passed canonical ownership, and retain their source identity.
            const motion =
              snapshot.motion && snapshot.handoff
                ? planMotionHandoff(
                    snapshot.motion,
                    snapshot.handoff.captured,
                    snapshot.handoff.time,
                  )
                : snapshot.motion
            const track = planTrack({ ...snapshot, motion }, timing, 'both')!
            start.push({
              ...track,
              operation: typeof operation === 'number' ? operation : operation?.id,
            })
          }
        }
      }

      cancel.push(...planEffectChanges(change.previous, change.next, active, retargets, addresses))
      writes.push(
        ...presentationWrites(
          change.next,
          receiver.names.map((target) => ({ id: receiver.id, target, protected: [] })),
          plan.removedProperties.size > 0 ? undefined : plan.writes,
        ),
      )
      presentations.push({
        receiver: receiver.id,
        resolution: change.next,
        layers: receiver.to,
        restore: plan.removedProperties.size > 0,
        preserveLifecycle: facts.preserve,
      })
    }

    execution.applyPlan({
      resolution: next,
      mode: 'live',
      cancel,
      restore: false,
      preserveLifecycle: false,
      writes,
      start,
      presentations,
    })
  } catch (error) {
    execution.abortPresencePlanning()

    throw error
  }
}

/** Reconciliation applies current receiver cascades without replaying entry or ordinary transitions. */
export function reconcilePresencePresentation(
  execution: ExecutionPort,
  next: LayerResolution,
  values: VariableValues,
) {
  const facts = execution.preparePresence(next, values, new Set())
  const writes = facts.receivers.flatMap((receiver) => {
    const { next: resolution } = receiverChange(receiver)

    return planReconciliation(
      resolution,
      receiver.names.map((target) => ({ id: receiver.id, target, protected: [] })),
    ).writes
  })
  const presentations = facts.receivers.map((receiver) => ({
    receiver: receiver.id,
    resolution: receiverChange(receiver).next,
    layers: receiver.to,
    restore: false,
    preserveLifecycle: facts.preserve,
  }))
  execution.applyPlan({
    resolution: next,
    mode: 'live',
    cancel: [],
    restore: false,
    preserveLifecycle: false,
    writes,
    start: [],
    presentations,
  })
}

/** Applies ordinary completion using the currently effective receiver cascade, including presence. */
export function completePresenceEffect(
  execution: ExecutionPort,
  next: LayerResolution,
  values: VariableValues,
  id: number,
) {
  const preparation = execution.preparePresence(next, values, new Set())
  const effect = preparation.active.find((entry) => entry.id === id)!
  const receiver = preparation.receivers.find((entry) => entry.id === effect.receiver)!
  const resolution = receiverChange(receiver).next
  const facts = execution.presentationFacts(next)
  const plan = planEffectCompletion(
    resolution,
    {
      ...facts,
      receivers: receiver.names.map((target) => ({ id: receiver.id, target, protected: [] })),
    },
    id,
  )!
  execution.applyPlan({ ...plan, resolution: next })
}

/** A media observation requests replanning; no application guards or events advance. */
export function coordinateMotionChange(
  execution: ExecutionPort,
  next: LayerResolution,
  values: VariableValues,
  report: (diagnostic: RuntimeDiagnostic) => void,
) {
  const facts = execution.presentationFacts(next)
  const retargets = planMotionRetargets(facts)

  if (retargets) coordinatePresencePresentation(execution, next, values, retargets, report)
}

/** Finishes an explicitly identified presence operation, then restores only its physical receivers. */
export function coordinateOperationEnd(
  execution: ExecutionPort,
  next: LayerResolution,
  values: VariableValues,
  id: number,
  result: import('./completion-group.ts').CompletionResult,
  controllers?: (resolution: LayerResolution) => LayerResolution,
) {
  const released = execution.releasePresence(id)

  try {
    if (controllers && execution.presentationFacts(next).mode === 'live') next = controllers(next)

    const preparation = execution.preparePresence(next, values, new Set())
    const snapshots = released.receivers.map(
      (previous) =>
        preparation.receivers.find((receiver) => receiver.id === previous.id) ??
        execution.observeReleasedReceiver(previous.id, previous.names, next),
    )
    const writes = snapshots.flatMap((receiver) => {
      const resolution = receiverChange(receiver).next

      return presentationWrites(
        resolution,
        receiver.names.map((target) => ({ id: receiver.id, target, protected: [] })),
      )
    })

    if (result === 'completed' && released.phase === 'enter') {
      for (const work of released.work) {
        if (!work.restoreOnCompletion)
          writes.push({ receiver: work.receiver, property: work.property, value: work.destination })
      }
    }

    execution.applyPlan({
      resolution: next,
      mode: 'live',
      cancel: preparation.active
        .filter((effect) => effect.operation === id)
        .map((effect) => effect.id),
      restore: false,
      preserveLifecycle: false,
      writes,
      start: [],
      presentations: snapshots.map((receiver) => ({
        receiver: receiver.id,
        resolution: receiverChange(receiver).next,
        layers: receiver.to,
        restore: true,
        preserveLifecycle: preparation.preserve,
      })),
    })
  } finally {
    execution.finishPresenceRelease()
  }
}

/** Ownership changes are planned after the executor supplies shared writing-context observations. */
export function coordinateOperationExclusions(
  execution: ExecutionPort,
  operation: import('./execution-contracts.ts').OperationOwnership,
  next: LayerResolution,
): ReadonlySet<string> {
  if (operation.phase !== 'enter' || !operation.started) return operation.excluded

  const changes = prepareLayerTakeovers(operation.previous, next)

  if (changes.length === 0) return operation.excluded

  const targets = new Set(changes.map((change) => change.target))
  const sources = operation.sources.filter((source) => targets.has(source.target))
  const facts = execution.observeTakeoverAddresses(operation.previous, next, sources)

  return new Set([...operation.excluded, ...planLayerTakeovers(changes, facts)])
}
