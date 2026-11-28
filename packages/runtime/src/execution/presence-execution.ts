import { layerPropertyKey, layerPropertyMatchesTarget } from '../model/presentation.ts'
import { presentationWrites } from './presentation-planner.ts'
import type { ReceiverAddresses } from './presentation-planner.ts'
import { propertyAddresses, canonicalTracks } from '../motion/property-codec.ts'
import {
  changedLayerProperties,
  type EvaluatedLayer,
  type LayerResolution,
} from '../composition/layers.ts'
import { type VariableValues } from '../evaluation/expression.ts'
import type { Definition } from '../model/definition.ts'
import { type ResolvedTrack } from '../composition/resolve.ts'
import {
  resolveLifecycleTracks,
  evaluateLifecycleTrack,
  captureLifecycleDefinition,
  hasLifecycle,
} from './lifecycle.ts'
import {
  createPresenceCapture,
  type PresenceCapture,
  type PresenceParticipant,
  type PresenceOperation,
} from './presence-operation.ts'
import {
  presencePropertyKey as receiverPropertyKey,
  presenceDeclarationNames,
  planPresenceExclusions,
  resolvePresenceTrack,
  normalizePresenceLayers,
} from './presence-calculation.ts'
import type { BrowserExecutor, Receiver, ActiveTrack } from './browser-executor.ts'
/** Browser-owned capture data; opaque handles never expose these fields. */
export type CapturedPresenceWork = {
  readonly element: HTMLElement
  readonly track: ResolvedTrack
  readonly rebased: boolean
  readonly capture: {
    readonly definition: Definition
    readonly environment: { values: VariableValues; presentation: LayerResolution['presentation'] }
  }
}

/** A scoped evaluated layer and its completion lifetime; native effects remain in active. */
export type PresenceState = {
  readonly id: number
  readonly phase: 'enter' | 'leave'
  readonly session: PresenceOperation
  readonly work: readonly CapturedPresenceWork[]
  /** One receiver/target binding for each work item, in the same order. */
  readonly receivers: readonly { readonly receiver: Receiver; readonly target: string }[]
  readonly interrupted: Set<string>
  playing: boolean
}

export class PresenceExecution {
  private readonly host: Pick<
    BrowserExecutor,
    | 'report'
    | 'representativeTargets'
    | 'withStyleSources'
    | 'definition'
    | 'values'
    | 'layerResolution'
    | 'disposed'
    | 'motion'
    | 'motionChanged'
    | 'receivers'
    | 'nextReceiverId'
    | 'environment'
    | 'write'
    | 'present'
    | 'active'
    | 'presentationMode'
    | 'retainMotion'
    | 'restore'
    | 'presentationFacts'
    | 'receiver'
    | 'applyWrites'
    | 'project'
    | 'dirtyProperties'
    | 'presented'
    | 'pruneReceivers'
    | 'clearReferenceFrame'
    | 'targetReceivers'
  >

  constructor(
    host: Pick<
      BrowserExecutor,
      | 'report'
      | 'representativeTargets'
      | 'withStyleSources'
      | 'definition'
      | 'values'
      | 'layerResolution'
      | 'disposed'
      | 'motion'
      | 'motionChanged'
      | 'receivers'
      | 'nextReceiverId'
      | 'environment'
      | 'write'
      | 'present'
      | 'active'
      | 'presentationMode'
      | 'retainMotion'
      | 'restore'
      | 'presentationFacts'
      | 'receiver'
      | 'applyWrites'
      | 'project'
      | 'dirtyProperties'
      | 'presented'
      | 'pruneReceivers'
      | 'clearReferenceFrame'
      | 'targetReceivers'
    >,
  ) {
    this.host = host
  }

  private readonly operations = new Map<PresenceOperation, PresenceState>()

  private readonly captureEnvironments = new WeakMap<
    Definition,
    { values: VariableValues; presentation: LayerResolution['presentation'] }
  >()

  private nextLifecycleId = 0

  supports(definition: Definition) {
    return hasLifecycle(definition)
  }

  get hasOperations() {
    return this.operations.size > 0
  }

  members() {
    return this.operations.values()
  }

  operation(session: PresenceOperation) {
    return this.operations.get(session)
  }

  freeze(
    definition: Definition,
    values: VariableValues,
    presentation: LayerResolution['presentation'],
  ) {
    const captured = this.captureEnvironments.get(definition)

    if (captured) {
      captured.values = values
      captured.presentation = presentation
    }
  }

  replaceEffects(
    session: PresenceOperation,
    replaced: readonly ActiveTrack[],
    prepared: readonly ActiveTrack[],
  ) {
    session.completion.replace(
      replaced.filter((entry) => entry.session === session).map((entry) => entry.id),
      prepared.filter((entry) => entry.session === session).map((entry) => entry.id),
    )
  }

  private readonly captures = new WeakMap<
    PresenceCapture,
    {
      readonly work: readonly CapturedPresenceWork[]
      readonly receivers: readonly { readonly target: string; readonly element: HTMLElement }[]
    }
  >()

  private readonly presenceParticipant: PresenceParticipant = {
    release: (captures) => this.releasePresence(captures),
    initialize: (operation, phase, captures) => this.initializePresence(operation, phase, captures),
    play: (operation) => this.playPresence(operation),
    end: (operation) => {
      try {
        this.endPresence(operation)
      } catch (error) {
        this.host.report({ code: 'runtime.animation', message: String(error), error })

        throw error
      }
    },
  }

  /**
   * Captures this definition's accepted inputs and matching receivers behind an opaque
   * handle, including empty work. names selects logical targets; element selects one
   * repeated receiver (otherwise the last accepted receiver is used). properties
   * filters authored names after rendering the selected phase. Missing selections
   * produce an empty participant; expression failures throw without publishing a handle.
   * An interrupted capture rebases starts from displayed
   * CSS before the previous operation is cancelled. Capture itself does not write or
   * cancel effects. Detached leave remains usable after Runtime disposal/replacement.
   */
  capturePresence(
    phase: 'enter' | 'leave',
    names: readonly string[],
    options: {
      readonly element?: HTMLElement
      readonly interrupted?: boolean
      readonly properties?: readonly string[]
    } = {},
  ): PresenceCapture {
    const elements = [...this.host.representativeTargets()]
      .filter(([name]) => names.includes(name))
      .map(([, element]) => options.element ?? element)
    return this.host.withStyleSources(elements, () =>
      this.capturePresenceSource(phase, names, options),
    )
  }

  private capturePresenceSource(
    phase: 'enter' | 'leave',
    names: readonly string[],
    options: {
      readonly element?: HTMLElement
      readonly interrupted?: boolean
      readonly properties?: readonly string[]
    },
  ): PresenceCapture {
    const definition = this.host.definition
    const targets = new Map(
      [...this.host.representativeTargets()]
        .filter(([name]) => names.includes(name))
        .map(([name, element]) => [name, options.element ?? element]),
    )
    const styles = new Map<HTMLElement, CSSStyleDeclaration>()
    const read = (target: string, property: string) => {
      const element = targets.get(target)

      if (!element) return undefined

      let style = styles.get(element)

      if (!style) {
        style = element.isConnected ? getComputedStyle(element) : element.style
        styles.set(element, style)
      }

      return style.getPropertyValue(property)
    }
    const tracks = resolveLifecycleTracks(
      phase,
      captureLifecycleDefinition(definition, phase, this.host.values),
      this.host.layerResolution.presentation,
      read,
    )
    const environment = this.captureEnvironments.get(definition) ?? {
      values: this.host.values,
      presentation: this.host.layerResolution.presentation,
    }

    environment.values = this.host.values
    environment.presentation = this.host.layerResolution.presentation
    this.captureEnvironments.set(definition, environment)

    const work = tracks
      .filter((track) => !options.properties || options.properties.includes(track.property))
      .map((track): CapturedPresenceWork => ({
        // resolveLifecycleTracks only emits tracks whose receiver supplied a value.
        element: targets.get(track.target)!,
        track: options.interrupted
          ? {
              ...track,
              keyframes: track.keyframes.map((frame, index) =>
                index === 0 ? { ...frame, value: read(track.target, track.property)! } : frame,
              ),
            }
          : track,
        rebased: options.interrupted === true,
        capture: { definition, environment },
      }))
    const handle = createPresenceCapture(this.presenceParticipant, phase)

    const elements = new Set(work.map((item) => item.element))

    this.captures.set(handle, {
      work,
      receivers: [...targets]
        .filter(([, element]) => elements.has(element))
        .map(([target, element]) => ({ target, element })),
    })

    return handle
  }

  /** Captures browser address facts; pure calculation decides which declarations take over. */
  enterExclusions(previous: LayerResolution, next: LayerResolution) {
    const operations = [...this.operations.values()]
    const addresses = new Map<string, ReceiverAddresses['addresses']>()
    const exclusions = planPresenceExclusions(
      previous,
      next,
      operations.map((operation) => ({
        id: operation.id,
        phase: operation.phase,
        playing: operation.playing,
        interrupted: operation.interrupted,
        receivers:
          operation.phase === 'enter' && operation.playing
            ? operation.receivers.map(({ receiver, target }) => {
                const key = layerPropertyKey(String(receiver.id), target)
                let facts = addresses.get(key)

                if (!facts) {
                  facts = presenceDeclarationNames(previous, next, target).map((name) => ({
                    name,
                    addresses: propertyAddresses(receiver.element, name),
                  }))
                  addresses.set(key, facts)
                }

                return { id: receiver.id, target, addresses: facts }
              })
            : [],
      })),
    )

    return operations.map((operation) => ({ operation, excluded: exclusions.get(operation.id)! }))
  }

  /** Observes/canonicalizes browser values around DOM-free presence evaluation and normalization. */
  presenceLayers(
    resolution: LayerResolution,
    values: VariableValues,
    exclusions: readonly {
      readonly operation: PresenceState
      readonly excluded: ReadonlySet<string>
    }[],
    expand = true,
  ): EvaluatedLayer[] {
    return exclusions.flatMap(({ operation, excluded }) =>
      operation.work.flatMap((item, index) => {
        const { track, capture } = item
        const binding = operation.receivers[index]
        const rendered = resolvePresenceTrack({
          receiver: binding.receiver.id,
          phase: operation.phase,
          track,
          rebased: item.rebased,
          definition: capture.definition,
          values: capture.definition === this.host.definition ? values : capture.environment.values,
          presentation:
            capture.definition === this.host.definition
              ? resolution.presentation
              : capture.environment.presentation,
          addresses: propertyAddresses(binding.receiver.element, track.property),
          excluded,
        })

        if (!rendered) return []

        const components = expand ? canonicalTracks(binding.receiver.element, rendered) : [rendered]

        return normalizePresenceLayers({
          operation: operation.id,
          index,
          receiver: binding.receiver.id,
          source: rendered,
          components: components.map((component) => ({
            track: component,
            addresses: propertyAddresses(binding.receiver.element, component.property),
          })),
          excluded,
        })
      }),
    )
  }

  validatePresence(previous: LayerResolution, next: LayerResolution, values: VariableValues) {
    this.presenceLayers(next, values, this.enterExclusions(previous, next), false)
  }

  /** Resolves only executor-owned captures; the boundary receives numeric membership and results. */
  private initializePresence(
    session: PresenceOperation,
    phase: 'enter' | 'leave',
    captures: readonly PresenceCapture[],
  ) {
    // The operation registry dispatches each capture only to its registered owner.
    // Every handle was stored in this WeakMap before publication and is never deleted.
    const work = captures.flatMap((capture) => this.captures.get(capture)!.work)

    if (this.host.disposed) this.host.motion.addEventListener('change', this.host.motionChanged)

    const receivers = work.map(({ element, track }) => {
      let receiver = [...this.host.receivers.values()].find((item) => item.element === element)

      if (!receiver) {
        receiver = { id: this.host.nextReceiverId++, element }
        this.host.receivers.set(receiver.id, receiver)
      }

      return { receiver, target: track.target }
    })
    const operation: PresenceState = {
      id: this.nextLifecycleId++,
      phase,
      session,
      work,
      receivers,
      interrupted: new Set(),
      playing: false,
    }

    this.operations.set(session, operation)

    if (!this.host.disposed) this.host.environment?.refreshOwnership()

    if (session.isFinished) return

    for (const item of work) {
      const { element, track, capture } = item
      const rendered = evaluateLifecycleTrack(
        phase,
        capture.definition[phase],
        capture.definition === this.host.definition
          ? this.host.layerResolution.presentation
          : capture.environment.presentation,
        capture.definition === this.host.definition ? this.host.values : capture.environment.values,
        track,
        item.rebased,
      )

      this.host.write(element, track.property, rendered.keyframes[0].value)
    }
  }

  private playPresence(session: PresenceOperation) {
    // PresenceOperation starts playback only after this participant initialized successfully.
    const operation = this.operations.get(session)!

    operation.playing = true
    this.host.present(this.host.layerResolution, this.host.layerResolution, this.host.values)
  }

  sessionFor(receiver: number, property: string): PresenceOperation | undefined {
    return [...this.operations.values()].findLast((operation) =>
      operation.receivers.some(
        (binding, index) =>
          binding.receiver.id === receiver &&
          (operation.work[index].track.property === property ||
            propertyAddresses(
              binding.receiver.element,
              operation.work[index].track.property,
            ).includes(property)),
      ),
    )?.session
  }

  private endPresence(session: PresenceOperation) {
    const operation = this.operations.get(session)

    // A sibling can fail before this participant has begun initialization.
    if (!operation) return

    const effects = this.host.active.filter((entry) => entry.session === session)

    try {
      this.operations.delete(session)

      const previous = this.host.layerResolution
      const elements = new Set(operation.receivers.map(({ receiver }) => receiver.element))

      if (!this.host.disposed && this.host.presentationMode === 'live')
        this.host.environment?.refreshOwnership()

      const cancelled = this.host.active.filter((entry) => entry.session === session)

      this.host.active = this.host.active.filter((entry) => entry.session !== session)

      for (const entry of cancelled) {
        this.host.retainMotion(entry)
        entry.animation.cancel()
      }

      if (this.host.presentationMode !== 'live') return

      this.host.restore(this.operations.size > 0, elements)

      const facts = this.host.presentationFacts()
      const changed = changedLayerProperties(previous, this.host.layerResolution)
      const presence = this.presenceLayers(
        this.host.layerResolution,
        this.host.values,
        this.enterExclusions(this.host.layerResolution, this.host.layerResolution),
      )

      if (!this.host.disposed) {
        for (const receiver of facts.receivers) {
          if (
            !elements.has(this.host.receiver(receiver.id).element) &&
            ![...changed].some((key) => layerPropertyMatchesTarget(key, receiver.target))
          )
            continue

          this.host.applyWrites(
            presentationWrites(
              this.host.project(this.host.layerResolution, receiver.id, presence),
              [receiver],
            ),
          )
        }
      }

      // Restoration is a temporary ownership change, not a fresh input sample.
      // Keep the outgoing trajectory derivative available to immediate re-entry.
      for (const element of elements) this.host.dirtyProperties.delete(element)
    } finally {
      this.host.active = this.host.active.filter((entry) => entry.session !== session)

      for (const entry of effects) entry.animation.cancel()

      for (const { receiver, target } of operation.receivers)
        this.host.presented.delete(layerPropertyKey(String(receiver.id), target))

      this.host.pruneReceivers()

      if (this.host.disposed && this.operations.size === 0) {
        this.host.clearReferenceFrame()
        this.host.motion.removeEventListener('change', this.host.motionChanged)
        this.host.targetReceivers.clear()
        this.host.receivers.clear()
      }
    }
  }

  /** Releases only captured canonical addresses across their selected logical aliases. */
  private releasePresence(captures: readonly PresenceCapture[]) {
    const selected = new Map<HTMLElement, Map<string, Set<string>>>()

    for (const capture of captures) {
      // The registry dispatches only this participant's stored captures.
      const data = this.captures.get(capture)!

      const observed = new Map<HTMLElement, Set<string>>()

      for (const item of data.work) {
        let addresses = observed.get(item.element)

        if (!addresses) {
          addresses = new Set()
          observed.set(item.element, addresses)
        }

        addresses.add(item.track.property)

        for (const address of propertyAddresses(item.element, item.track.property))
          addresses.add(address)
      }

      for (const { target, element } of data.receivers) {
        let targets = selected.get(element)

        if (!targets) {
          targets = new Map()
          selected.set(element, targets)
        }

        const addresses = targets.get(target) ?? new Set<string>()

        // Captures retain receiver aliases only for elements represented in their work.
        for (const address of observed.get(element)!) addresses.add(address)

        targets.set(target, addresses)
      }
    }

    const interrupted = this.host.active.filter((entry) =>
      selected.get(entry.receiver.element)?.get(entry.track.target)?.has(entry.track.property),
    )
    this.host.active = this.host.active.filter((entry) => !interrupted.includes(entry))

    for (const entry of interrupted) {
      this.host.retainMotion(entry)
      entry.animation.cancel()
    }
  }

  /** Detaches registrations before cancellation so queued completion cannot publish stale work. */
  cancelEnterSessions(reason: 'superseded' | 'owner-teardown') {
    const sessions = [...this.operations.values()].filter((entry) => entry.phase === 'enter')

    for (const { session } of sessions) {
      session.cancel(reason)
      this.operations.delete(session)
    }
  }

  lifecycleOwns(element: HTMLElement, property: string): boolean {
    return [...this.operations.values()].some((operation) => {
      return operation.work.some((item, index) => {
        if (item.element !== element) return false

        const addresses = propertyAddresses(element, item.track.property)
        const receiver = operation.receivers[index].receiver.id
        const active = addresses.filter(
          (address) =>
            !operation.interrupted.has(receiverPropertyKey(receiver, item.track.target, address)),
        )

        return (item.track.property === property && active.length > 0) || active.includes(property)
      })
    })
  }
}
