import type { LayerResolution, EvaluatedLayer } from '../composition/layers.ts'
import type { ResolvedTrack } from '../composition/resolve.ts'
import type { Definition } from '../model/definition.ts'
import type { VariableValues } from '../evaluation/expression.ts'
import type { RenderedState } from '../model/presentation.ts'
import { layerPropertyKey } from '../model/presentation.ts'
import { evaluateLifecycleTrack } from './lifecycle.ts'
import { planDeclarationTakeovers, type ReceiverAddresses } from './presentation-planner.ts'
import type { PresencePhase } from './presence-operation.ts'

/** Authored target and canonical property address within one physical receiver. */
export function presencePropertyKey(receiver: number, target: string, property: string): string {
  return layerPropertyKey(layerPropertyKey(String(receiver), target), property)
}

/** Declaration names whose receiver-context canonical addresses may change ownership. */
export function presenceDeclarationNames(
  previous: LayerResolution,
  next: LayerResolution,
  target: string,
): readonly string[] {
  return [
    ...new Set(
      [
        previous.declarations ?? previous.presentation,
        next.declarations ?? next.presentation,
      ].flatMap((presentation) =>
        presentation.targets
          .filter((item) => item.name === target)
          .flatMap((item) => item.properties.map((property) => property.name)),
      ),
    ),
  ]
}

export interface PresenceOwnership {
  readonly id: number
  readonly phase: PresencePhase
  readonly playing: boolean
  readonly interrupted: ReadonlySet<string>
  readonly receivers: readonly Pick<ReceiverAddresses, 'id' | 'target' | 'addresses'>[]
}

/**
 * Returns one copied exclusion set per executor-local operation ID. Canonical
 * address facts must cover both ordered presentations. Does not observe receivers
 * or mutate accepted interruption state; caller commits exclusions with its plan.
 */
export function planPresenceExclusions(
  previous: LayerResolution,
  next: LayerResolution,
  operations: readonly PresenceOwnership[],
): ReadonlyMap<number, ReadonlySet<string>> {
  const takeovers = new Map<string, readonly string[]>()

  return new Map(
    operations.map((operation) => {
      const excluded = new Set(operation.interrupted)

      if (operation.phase === 'enter' && operation.playing) {
        for (const receiver of operation.receivers) {
          const key = layerPropertyKey(String(receiver.id), receiver.target)
          let changed = takeovers.get(key)

          if (!changed) {
            changed = planDeclarationTakeovers(previous, next, receiver.target, receiver.addresses)
            takeovers.set(key, changed)
          }

          for (const address of changed)
            excluded.add(presencePropertyKey(receiver.id, receiver.target, address))
        }
      }

      return [operation.id, excluded]
    }),
  )
}

/** Evaluates only a declaration that still owns at least one supplied canonical address. */
export function resolvePresenceTrack(input: {
  readonly receiver: number
  readonly phase: PresencePhase
  readonly track: ResolvedTrack
  readonly rebased: boolean
  readonly definition: Definition
  readonly values: VariableValues
  readonly presentation: RenderedState
  readonly addresses: readonly string[]
  readonly excluded: ReadonlySet<string>
}): ResolvedTrack | undefined {
  if (
    input.addresses.every((address) =>
      input.excluded.has(presencePropertyKey(input.receiver, input.track.target, address)),
    )
  )
    return undefined

  return evaluateLifecycleTrack(
    input.phase,
    input.definition[input.phase],
    input.presentation,
    input.values,
    input.track,
    input.rebased,
  )
}

/**
 * Normalizes canonical components, in expansion order, into ordinary evaluated
 * layers. operation/index identify the captured authored track; receiver is its
 * physical receiver ID. source retains authored property/destination CSS while
 * components supply physical addresses and endpoints. Excluded keys use
 * presencePropertyKey. No expression evaluation or browser observation occurs.
 */
export function normalizePresenceLayers(input: {
  readonly operation: number
  readonly index: number
  readonly receiver: number
  readonly source: ResolvedTrack
  readonly components: readonly {
    readonly track: ResolvedTrack
    readonly addresses: readonly string[]
  }[]
  readonly excluded: ReadonlySet<string>
}): EvaluatedLayer[] {
  return input.components.flatMap(({ track, addresses }) => {
    if (
      addresses.every((address) =>
        input.excluded.has(presencePropertyKey(input.receiver, track.target, address)),
      )
    )
      return []

    const owner = `@presence:${input.operation}:${input.index}`

    return [
      {
        id: owner,
        scope: [input.receiver],
        targets: [
          {
            name: track.target,
            properties: [
              {
                name: track.property,
                owner,
                sourceProperty: input.source.property,
                sourceDestination: input.source.destinationValue,
                value: track.destinationValue,
                timing: track.timing,
                keyframes: track.implicitStart ? track.keyframes.slice(1) : track.keyframes,
              },
            ],
          },
        ],
      },
    ]
  })
}
