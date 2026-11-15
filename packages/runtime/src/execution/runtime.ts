import { composeRuntimeLayers } from '../composition/runtime-layers.ts'
import { ownsCanonicalProperty } from './presentation-planner.ts'
import {
  coordinatePresencePresentation,
  reconcilePresencePresentation,
  completePresenceEffect,
  coordinateOperationEnd,
  coordinateOperationExclusions,
  coordinateMotionChange,
} from './presentation-coordinator.ts'
import {
  layerTargets,
  resolveLayers,
  resolveComposition,
  layerTrackTemplates,
  completeLayerTrack,
  type LayerResolution,
  type Composition,
  type CompositionTransition,
} from '../composition/layers.ts'
import { parameterValues, LetBindingGraph, targetValues } from '../evaluation/let-bindings.ts'
import { evaluate, renderTransition, type VariableValues } from '../evaluation/expression.ts'
import type { ReactiveNotification } from '../evaluation/events.ts'
import type { Definition } from '../model/definition.ts'
import {
  compositionSnapshot,
  type ExecutionPort,
  type RuntimeDiagnostic,
} from './execution-contracts.ts'

import {
  orderedResolution,
  planControllerBindings,
  planControllerPresentation,
  planTrackObservations,
  planTrack,
  trackTiming,
  planPreviewPresentation,
  planLifecycleSettlement,
  presentationWrites,
  layerPropertyKey,
  type PresentationFacts,
  type ReceiverAddresses,
  type TrackPlan,
  type PresentationPlan,
} from './presentation-planner.ts'
import { captureLifecycleDefinition, resolveLifecycleTracks } from './lifecycle.ts'
import type { ResolvedTrack } from '../composition/resolve.ts'

/**
 * Owns accepted inputs, evaluation/call lifetime, event and state-machine history,
 * and update ordering. Browser work is delegated through logical execution requests.
 * Candidate evaluation commits calls before events; event callbacks still observe
 * the previous composition, and may invalidate the binding before presentation.
 */
export class Runtime {
  definition: Definition
  onUpdate?: () => void
  onEvent?: (name: string) => void
  private values: VariableValues
  private graph: LetBindingGraph
  private resolution: LayerResolution
  private readonly events = new Map<string, boolean>()
  private revision = 0
  private applying = false
  private scheduled = false
  private disposed = false
  private readonly queue: { values: VariableValues; notification?: ReactiveNotification }[] = []

  private readonly execution: ExecutionPort
  private readonly report: (diagnostic: RuntimeDiagnostic) => void

  constructor(
    execution: ExecutionPort,
    definition: Definition,
    inputs: Readonly<Record<string, unknown>>,
    report: (diagnostic: RuntimeDiagnostic) => void,
  ) {
    this.execution = execution
    this.report = report

    const variables = parameterValues(definition.parameters ?? [], targetValues(definition), inputs)
    this.graph = new LetBindingGraph(
      definition.letBindings ?? [],
      variables,
      undefined,
      layerTargets(definition),
    )
    this.values = this.graph.evaluate(variables)
    this.definition = definition
    execution.configureControllers(definition, this.values)
    this.evaluateEvents(false)
    this.resolution = resolveLayers(definition, this.values)
    execution.initialize(this.resolution)
  }

  get composition() {
    return compositionSnapshot(this.resolution.composition)
  }

  readonly environment = {
    definition: () => this.definition,
    values: () => this.values,
    controllerBaseline: (
      resolution: LayerResolution,
      values: VariableValues,
      definition: Definition,
    ) => this.controllerBaseline(resolution, values, definition),
    controllerResolution: (
      resolution: LayerResolution,
      values: VariableValues,
      time: number,
      definition?: Definition,
      live?: boolean,
    ) => this.controllerResolution(resolution, values, time, definition, live),
    invalidateBinding: () => this.invalidateBinding(),
    clearBindings: () => this.clearBindings(),
    rebound: (advance: boolean) => this.rebound(advance),
    acceptPresentation: (resolution: LayerResolution) => {
      this.resolution = resolution
    },
    // The executor requests retargeting only for current live effects.
    retarget: (properties: ReadonlySet<string>) =>
      this.applyPresentation(this.resolution, this.resolution, properties),
    completeEffect: (id: number) => this.completeEffect(id),
    reconcile: () => this.reconcilePresentation(),
    motionChanged: () =>
      coordinateMotionChange(this.execution, this.resolution, this.values, this.report),
    operationEnded: (id: number, result: import('./completion-group.ts').CompletionResult) =>
      coordinateOperationEnd(this.execution, this.resolution, this.values, id, result, (next) =>
        this.controllerResolution(next, this.values, performance.now()),
      ),
    operationExclusions: (
      operation: import('./execution-contracts.ts').OperationOwnership,
      next: LayerResolution,
    ) => coordinateOperationExclusions(this.execution, operation, next),
    lifecycleSettled: () => this.applyObservedPlan(planLifecycleSettlement),
  }

  private invalidateBinding() {
    this.revision++
    this.queue.length = 0
  }

  private snapshotValues(definition: Definition): VariableValues {
    const graph = new LetBindingGraph(
      definition.letBindings ?? [],
      this.values,
      this.graph,
      layerTargets(definition),
    )

    try {
      return graph.evaluate(this.values)
    } finally {
      graph.dispose(this.graph)
    }
  }

  private clearBindings() {
    this.execution.disconnectBindings()

    try {
      this.values = this.graph.evaluate(this.values)
    } catch (error) {
      this.report({ code: 'runtime.expression', message: String(error), error })
    }
  }

  private rebound(advance: boolean) {
    this.resolution = resolveLayers(this.definition, this.values, this.resolution.states, advance)
    this.execution.initialize(this.resolution)

    if (!this.execution.bindingFacts.suspended) this.connectBindings()
  }

  private connectBindings() {
    this.execution.connectBindings(this.graph, (notification) =>
      this.applyValues(this.values, notification),
    )
    this.values = this.graph.evaluate(this.values)
    this.evaluateEvents(false)
    this.resolution = resolveLayers(this.definition, this.values, this.resolution.states, false)
    this.resolution = this.controllerResolution(this.resolution, this.values, performance.now())
    this.execution.initialize(this.resolution)
  }

  replaceDefinition(definition: Definition) {
    if (this.disposed) return

    this.execution.endCompositionPreview()
    this.invalidateBinding()

    const inputs = Object.fromEntries(
      (definition.parameters ?? [])
        .filter((parameter) =>
          this.definition.parameters?.some((previous) => previous.name === parameter.name),
        )
        .map((parameter) => [parameter.name, this.values[parameter.name]]),
    )
    const variables = parameterValues(
      definition.parameters ?? [],
      targetValues(definition, this.values),
      inputs,
    )
    const graph = new LetBindingGraph(
      definition.letBindings ?? [],
      variables,
      this.graph,
      layerTargets(definition),
    )

    this.execution.retainEnvironment(this.values)
    this.execution.releaseControllers()
    this.clearBindings()
    this.execution.resetPresentation()
    this.graph.dispose(graph)
    this.graph = graph
    this.values = graph.evaluate(variables)
    this.definition = definition
    this.execution.configureControllers(definition, this.values)
    this.events.clear()
    this.evaluateEvents(false)
    this.resolution = resolveLayers(definition, this.values)
    this.execution.initialize(this.resolution)
    this.execution.refreshSuspension(definition)

    if (!this.execution.bindingFacts.suspended) this.connectBindings()

    this.reconcilePresentation()
  }

  updateParameters(inputs: Readonly<Record<string, unknown>>) {
    if (this.disposed) return

    try {
      this.applyValues(parameterValues(this.definition.parameters ?? [], this.values, inputs))
    } catch (error) {
      this.report({ code: 'runtime.parameter', message: String(error), error })
    }
  }

  private evaluateEvents(emit = true) {
    const pending: string[] = []

    for (const event of this.definition.events ?? []) {
      const next = evaluate(event.when, this.values) === true

      if (emit && next && this.events.get(event.name) === false) pending.push(event.name)

      this.events.set(event.name, next)
    }

    for (const name of pending) this.onEvent?.(name)
  }

  private applyValues(values: VariableValues, notification?: ReactiveNotification) {
    /* v8 ignore if -- @preserve: Public updates guard disposal; graph subscriptions and queued updates are cleared before disposal completes. */
    if (this.disposed) return

    if (this.applying || this.scheduled) {
      this.queue.push({ values, notification })

      return
    }

    this.runUpdate(values, notification)
  }

  private runUpdate(values: VariableValues, notification?: ReactiveNotification) {
    this.applying = true

    try {
      this.applyTransaction(values, notification)
    } finally {
      this.applying = false

      if (this.queue.length > 0 && !this.scheduled) {
        this.scheduled = true

        queueMicrotask(() => {
          this.scheduled = false
          const next = this.queue.shift()

          if (next) this.runUpdate(next.notification ? this.values : next.values, next.notification)
        })
      }
    }
  }

  private applyTransaction(values: VariableValues, notification?: ReactiveNotification) {
    this.execution.endCompositionPreview()
    const previous = this.values
    const revision = this.revision

    try {
      let resolution: LayerResolution | undefined
      values = this.graph.evaluate(
        values,
        (snapshot) => {
          const candidate = resolveLayers(
            this.definition,
            snapshot,
            this.resolution.states,
            true,
            notification?.event,
          )

          resolution = candidate

          for (const event of this.definition.events ?? []) evaluate(event.when, snapshot)

          this.execution.validatePresentation(snapshot, candidate)
        },
        notification,
      )
      this.values = values
      this.evaluateEvents()

      if (this.disposed || revision !== this.revision) return

      const time = notification?.time ?? performance.now()
      this.execution.terminalControls(time)
      // Validation resolves presentation synchronously before accepting reactive calls.
      const next = this.controllerResolution(resolution!, values, time)
      this.applyPresentation(this.resolution, next)
      this.onUpdate?.()
    } catch (error) {
      this.values = previous
      this.report({ code: 'runtime.expression', message: String(error), error })
    }
  }

  private controllerBaseline(
    resolution: LayerResolution,
    values: VariableValues,
    definition: Definition,
  ) {
    // Re-resolve the selected composition without bindings so an unreadable
    // controller can reveal the normal declaration hidden beneath it.
    const normal = resolveComposition(
      {
        ...definition,
        layers: definition.layers.map((layer) => ({
          ...layer,
          targets: layer.targets.map((target) => ({
            ...target,
            properties: target.properties.filter((property) => property.value.kind !== 'binding'),
          })),
          states: layer.states?.map((state) => ({
            ...state,
            targets: state.targets.map((target) => ({
              ...target,
              properties: target.properties.filter((property) => property.value.kind !== 'binding'),
            })),
          })),
        })),
      },
      values,
      resolution.composition,
    )

    const bindings = resolution.presentation.targets.flatMap((target) =>
      target.properties.flatMap((property) =>
        property.binding
          ? [{ target: target.name, property: property.name, expression: property.binding }]
          : [],
      ),
    )
    const formatted = this.execution.applyControllers(bindings, values, 0, false)

    // Occluded controllers retain their last logical baseline while input records
    // remain live for expressions. Reacquisition later rebases from displayed CSS.
    const provisional = {
      ...resolution,
      presentation: {
        ...resolution.presentation,
        targets: resolution.presentation.targets.map((target) => ({
          ...target,
          properties: target.properties.flatMap((property) => {
            if (!property.binding) return [property]

            const previous = this.resolution.presentation.targets
              .find((item) => item.name === target.name)
              ?.properties.find(
                (item) =>
                  item.name === property.name && item.owner === property.owner && item.binding,
              )
            const value =
              previous?.value ?? formatted.get(layerPropertyKey(target.name, property.name))
            const fallback = normal.presentation.targets
              .find((item) => item.name === target.name)
              ?.properties.find((item) => item.name === property.name)

            return value !== undefined ? [{ ...property, value }] : fallback ? [fallback] : []
          }),
        })),
      },
    }

    // A fallback may belong to an earlier declaration than the unavailable
    // binding. Both candidate applicability and accepted exclusions need the
    // substituted owner's source order before deciding effective components.
    return { normal, provisional: orderedResolution(provisional, definition) }
  }

  private controllerResolution(
    resolution: LayerResolution,
    values: VariableValues,
    time: number,
    definition = this.definition,
    live = true,
  ): LayerResolution {
    resolution = orderedResolution(resolution, definition)
    const targets = new Set(
      resolution.presentation.targets
        .filter((target) => target.properties.some((property) => property.binding))
        .map((target) => target.name),
    )

    if (targets.size === 0) {
      if (live) {
        this.execution.releaseControllers(time)
        this.execution.updatePresence(resolution, values)
      }

      return resolution
    }

    const { normal, provisional } = this.controllerBaseline(resolution, values, definition)
    const presence = live
      ? this.execution.preparePresence(provisional, values, new Set())
      : undefined
    const receivers = this.execution.observeReceivers(resolution, targets)
    const bindings = planControllerBindings(resolution, receivers)
    const obscured = new Set<string>()

    if (presence && presence.operations.length > 0) {
      for (const binding of bindings) {
        const property = resolution.presentation.targets
          .find((target) => target.name === binding.target)!
          .properties.find((candidate) => candidate.name === binding.property)!

        for (const receiver of presence.receivers.filter((candidate) =>
          candidate.names.includes(binding.target),
        )) {
          const effective = composeRuntimeLayers(receiver.to, receiver.id)
          const effectiveResolution = { ...provisional, presentation: effective }
          const owner = effective.targets
            .find((target) => target.name === binding.target)
            ?.properties.find((candidate) => candidate.name === binding.property)?.owner
          const facts = this.execution.observeReceiverAddresses(
            receiver.id,
            effectiveResolution,
            new Set([binding.target]),
          )
          const addresses = receivers
            .find((item) => item.id === receiver.id && item.target === binding.target)!
            .addresses.find((item) => item.name === binding.property)!.addresses

          // Matching ownership guarantees the effective target declaration and its address facts.
          if (
            owner !== property.owner ||
            addresses.some(
              (address) => !ownsCanonicalProperty(facts[0].addresses, binding.property, address),
            )
          )
            obscured.add(layerPropertyKey(binding.target, binding.property))
        }
      }
    }

    const outputs = this.execution.applyControllers(
      bindings.filter(
        (binding) => !obscured.has(layerPropertyKey(binding.target, binding.property)),
      ),
      values,
      time,
      live,
    )

    return planControllerPresentation(
      resolution,
      normal,
      outputs,
      definition,
      provisional,
      obscured,
    )
  }

  private applyPresentation(
    previous: LayerResolution,
    next: LayerResolution,
    retargets: ReadonlySet<string> = new Set(),
  ) {
    coordinatePresencePresentation(this.execution, next, this.values, retargets, this.report)
  }

  /** Numeric/displayed observations are requested only after canonical ownership is known. */
  private planPreviewTracks(
    sources: readonly {
      readonly receiver: number
      readonly source: ResolvedTrack
      readonly declarations?: ReceiverAddresses['addresses']
    }[],
    facts: PresentationFacts,
    fill: TrackPlan['fill'],
  ) {
    const timings = new Map<ResolvedTrack, ReturnType<typeof trackTiming>>()

    for (const source of new Set(sources.map((entry) => entry.source)))
      timings.set(source, trackTiming(source))

    // Every source has a cached timing above. Manual previews also retain zero-duration effects.
    const candidates = this.execution.expandTracks(sources)
    const observations = planTrackObservations(candidates, facts.active, false)
    const snapshots = this.execution.observeTracks(observations.requests)
    const start: TrackPlan[] = []

    for (const snapshot of snapshots) {
      // The executor preserves each request's source and ownership facts. All requests
      // passed the ownership filter, so these plans cannot be omitted; timings are cached above.
      start.push(planTrack(snapshot, timings.get(snapshot.source)!, fill)!)
    }

    return { changed: observations.changed, start }
  }

  private reconcilePresentation() {
    reconcilePresencePresentation(this.execution, this.resolution, this.values)
  }

  /** Browser notifications do not advance expressions, guards, or application events. */
  private applyObservedPlan(
    planner: (
      resolution: LayerResolution,
      facts: PresentationFacts,
    ) => PresentationPlan | undefined,
  ) {
    const facts = this.execution.presentationFacts(this.resolution)
    const plan = planner(this.resolution, facts)

    if (plan) this.execution.applyPlan(plan)
  }

  private completeEffect(id: number) {
    completePresenceEffect(this.execution, this.resolution, this.values, id)
  }

  inspectLifecycle(
    phase: 'enter' | 'leave',
    composition: Composition,
    definition = this.definition,
  ) {
    const values = this.snapshotValues(definition)

    return {
      presentation: this.controllerResolution(
        resolveComposition(definition, values, composition),
        values,
        performance.now(),
        definition,
        false,
      ).presentation,
      transition: captureLifecycleDefinition(definition, phase, values),
    }
  }

  inspectComposition(
    composition: Composition,
    from?: Composition,
    transitions: readonly CompositionTransition[] = [],
    definition = this.definition,
  ): LayerResolution {
    try {
      const values = this.snapshotValues(definition)

      const resolution = this.controllerResolution(
        resolveComposition(definition, values, composition, from, transitions),
        values,
        performance.now(),
        definition,
        false,
      )

      return {
        ...resolution,
        transitions: new Map(
          [...resolution.transitions].flatMap(([name, transition]) => {
            const targets = transition.transition.targets.flatMap((target) => {
              const properties = target.properties.filter((property) =>
                resolution.presentation.targets
                  .find((item) => item.name === target.name)
                  ?.properties.some((item) => item.name === property.name && item.owner === name),
              )

              return resolution.presentation.targets.some(
                (item) =>
                  item.name === target.name &&
                  item.properties.some((property) => property.owner === name),
              )
                ? [{ ...target, properties }]
                : []
            })

            if (
              !resolution.presentation.targets.some((target) =>
                target.properties.some((property) => property.owner === name),
              )
            )
              return []

            const rendered = renderTransition({ ...transition.transition, targets }, values)

            return [
              [
                name,
                {
                  ...transition,
                  transition: {
                    timing: rendered.timing,
                    targets: rendered.targets.map((target) => ({
                      name: target.name,
                      timingProperties: target.timingProperties,
                      timing: target.timing,
                      properties: target.properties.map((property) => ({
                        name: property.name,
                        timing: property.timing,
                        keyframes: property.keyframes?.map((frame) => ({
                          offset: frame.offset,
                          value: frame.value,
                          easing: frame.easing,
                        })),
                      })),
                    })),
                  },
                },
              ] as const,
            ]
          }),
        ),
      }
    } catch (error) {
      this.report({ code: 'runtime.inspection', message: String(error), error })
      throw error
    }
  }

  /** Frozen preview evaluation uses the same final planner without accepting application state. */
  previewComposition(
    from: Composition,
    to: Composition,
    transitions: readonly CompositionTransition[] = [],
    definition = this.definition,
    phase?: 'enter' | 'leave',
  ): void {
    if (this.disposed || this.execution.bindingFacts.suspended) {
      throw new Error('Composition preview requires a mounted layer instance')
    }

    try {
      const values = this.snapshotValues(definition)
      const previous = this.controllerResolution(
        resolveComposition(definition, values, from),
        values,
        performance.now(),
        definition,
        false,
      )
      const next = this.controllerResolution(
        resolveComposition(definition, values, to, from, transitions),
        values,
        performance.now(),
        definition,
        false,
      )
      const lifecycle = phase ? captureLifecycleDefinition(definition, phase, values) : undefined
      const facts = this.execution.presentationFacts(next)
      this.execution.beginPreview(presentationWrites(previous, facts.receivers, undefined, false))

      const templates = new Map(
        facts.receivers.map((receiver) => {
          const targetResolution = {
            ...next,
            presentation: {
              ...next.presentation,
              targets: next.presentation.targets.filter(
                (target) => target.name === receiver.target,
              ),
            },
          }
          const tracks = phase
            ? []
            : [
                ...layerTrackTemplates(
                  previous,
                  targetResolution,
                  values,
                  (message) => this.report({ code: 'runtime.endpoint', message }),
                  () => true,
                ),
              ]

          return [receiver.target, tracks] as const
        }),
      )
      const requests = facts.receivers.flatMap((receiver) => {
        const properties = phase
          ? (lifecycle?.targets
              .filter((target) => target.name === receiver.target)
              .flatMap((target) => target.properties.map((property) => property.name)) ?? [])
          : // Every logical target was assigned its templates above.
            templates
              .get(receiver.target)!
              .filter((track) => track.implicitStart)
              .map((track) => track.property)

        return properties.map((property) => ({ receiver: receiver.id, property }))
      })
      const displayed = new Map(
        this.execution
          .observeDisplayed(requests)
          .map((value) => [layerPropertyKey(String(value.receiver), value.property), value.value]),
      )
      const sources = facts.receivers.flatMap((receiver) => {
        const read = (property: string) =>
          displayed.get(layerPropertyKey(String(receiver.id), property))
        const tracks = phase
          ? resolveLifecycleTracks(phase, lifecycle, next.presentation, (target, property) =>
              target === receiver.target ? read(property) : undefined,
            )
          : // Explicit starts need no displayed value; every implicit start was requested above.
            templates
              .get(receiver.target)!
              .map((template) =>
                completeLayerTrack(
                  template,
                  template.implicitStart ? read(template.property)! : '',
                ),
              )

        return tracks.map((source) => ({ receiver: receiver.id, source }))
      })
      // Lifecycle declarations have their own ownership. Ordinary previews share the application cascade.
      const addresses = phase
        ? []
        : this.execution.observeReceivers(next, new Set(sources.map(({ source }) => source.target)))
      const tracks = this.planPreviewTracks(
        sources.map((source) => ({
          ...source,
          declarations: addresses.find(
            (receiver) =>
              receiver.id === source.receiver && receiver.target === source.source.target,
          )?.addresses,
        })),
        facts,
        phase === 'leave' ? 'both' : 'backwards',
      )
      this.execution.applyPlan(planPreviewPresentation(next, facts.receivers, tracks.start))
    } catch (cause) {
      this.execution.abortPreview()
      const error = new Error('Could not prepare composition preview', { cause })
      this.report({ code: 'runtime.preview', message: error.message, error })

      throw error
    }
  }

  previewLifecycle(
    phase: 'enter' | 'leave',
    composition = this.resolution.composition,
    definition = this.definition,
  ): void {
    this.previewComposition(composition, composition, [], definition, phase)
  }

  dispose() {
    if (this.disposed) return

    this.queue.length = 0
    this.execution.retainEnvironment(this.values)
    this.execution.releaseControllers()
    this.clearBindings()
    this.graph.dispose()
    this.execution.dispose()
    this.events.clear()
    this.onEvent = undefined
    this.onUpdate = undefined
    this.disposed = true
  }
}
