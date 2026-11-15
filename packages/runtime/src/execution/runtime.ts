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
  prepareLayerChange,
  layerObservationTargets,
  planLayerChange,
  planTrackObservations,
  planTrack,
  trackTiming,
  planPresentation,
  planPreviewPresentation,
  planEffectCompletion,
  planReconciliation,
  planMotionChange,
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
    motionChanged: () => this.applyObservedPlan(planMotionChange),
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
          resolution = resolveLayers(
            this.definition,
            snapshot,
            this.resolution.states,
            true,
            notification?.event,
          )

          for (const event of this.definition.events ?? []) evaluate(event.when, snapshot)
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

  /** Calculation surrounds explicit browser-operation phases; no elements enter Runtime. */
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
      if (live) this.execution.releaseControllers(time)

      return resolution
    }

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
    const receivers = this.execution.observeReceivers(resolution, targets)
    const bindings = planControllerBindings(resolution, receivers)
    const outputs = this.execution.applyControllers(bindings, values, time, live)

    return planControllerPresentation(resolution, normal, outputs, definition)
  }

  private applyPresentation(
    previous: LayerResolution,
    next: LayerResolution,
    retargets: ReadonlySet<string> = new Set(),
  ) {
    const facts = this.execution.presentationFacts(next)
    const preparation = prepareLayerChange({
      previous,
      next,
      values: this.values,
      active: facts.active,
      retargets,
    })
    const displayed = this.execution.observeLayerStarts(preparation.templates)
    const receivers = this.execution.observeReceivers(
      next,
      layerObservationTargets(preparation, next),
    )
    const change = planLayerChange(preparation, displayed, receivers)

    for (const message of change.diagnostics) this.report({ code: 'runtime.endpoint', message })

    const enabled = !facts.suspended && !facts.reduced
    const sources = enabled
      ? change.tracks.flatMap((source) => {
          change.changed.add(layerPropertyKey(source.target, source.property))

          return receivers
            .filter((receiver) => receiver.target === source.target)
            .map((receiver) => ({
              receiver: receiver.id,
              source,
              declarations: receiver.addresses,
            }))
        })
      : []
    const tracks = this.planTracks(sources, facts, true, 'both')

    for (const property of tracks.changed) change.changed.add(property)

    const plan = planPresentation(
      next,
      facts,
      change.changed,
      change.removedProperties,
      tracks.start,
    )
    this.execution.applyPlan(plan)
  }

  /** Numeric/displayed observations are requested only after canonical ownership is known. */
  private planTracks(
    sources: readonly {
      readonly receiver: number
      readonly source: ResolvedTrack
      readonly declarations?: ReceiverAddresses['addresses']
    }[],
    facts: PresentationFacts,
    live: boolean,
    fill: TrackPlan['fill'],
  ) {
    const timings = new Map<ResolvedTrack, ReturnType<typeof trackTiming>>()

    for (const { source } of sources) {
      if (!timings.has(source)) timings.set(source, trackTiming(source))
    }

    // Every source has a cached timing above. Manual previews also retain zero-duration effects.
    const candidates = this.execution.expandTracks(
      sources.filter(({ source }) => !live || timings.get(source)!.durationMs !== 0),
    )
    const observations = planTrackObservations(candidates, facts.active, live)
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
    if (this.execution.bindingFacts.suspended) return

    const facts = this.execution.presentationFacts(this.resolution)
    this.execution.applyPlan(planReconciliation(this.resolution, facts.receivers))
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
    const facts = this.execution.presentationFacts(this.resolution)
    // The executor sends completion only for a current effect. Metadata capture and
    // planning are synchronous, with no callbacks that can invalidate that effect.
    this.execution.applyPlan(planEffectCompletion(this.resolution, facts, id)!)
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
      const tracks = this.planTracks(
        sources.map((source) => ({
          ...source,
          declarations: addresses.find(
            (receiver) =>
              receiver.id === source.receiver && receiver.target === source.source.target,
          )?.addresses,
        })),
        facts,
        false,
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
