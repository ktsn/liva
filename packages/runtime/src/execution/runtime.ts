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
import { ReactiveCallStore } from '../evaluation/reactive-call-store.ts'
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
  private calls: ReactiveCallStore
  private bindingCleanups: (() => void)[] = []
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
    this.graph = new LetBindingGraph(definition.letBindings ?? [], layerTargets(definition))
    this.calls = new ReactiveCallStore()
    this.values = this.evaluateValues(variables, (values) => {
      resolveLayers(definition, values)

      for (const event of definition.events ?? []) evaluate(event.when, values)
    })
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
    reconcile: () => this.reconcilePresentation(),
    motionChanged: () => this.applyObservedPlan(planMotionChange),
    lifecycleSettled: () => this.applyObservedPlan(planLifecycleSettlement),
    refreshOwnership: () => this.refreshOwnership(),
  }

  private invalidateBinding() {
    this.revision++
    this.queue.length = 0
  }

  private evaluateValues(
    variables: VariableValues,
    afterEvaluate: (values: VariableValues) => void = () => {},
    notification?: ReactiveNotification,
  ): VariableValues {
    return this.calls.evaluate(
      (operations) =>
        this.graph.evaluate(variables, operations, (values) => {
          afterEvaluate(values)

          return values
        }),
      notification,
    )
  }

  private snapshotValues(definition: Definition): VariableValues {
    const graph = new LetBindingGraph(definition.letBindings ?? [], layerTargets(definition))
    const calls = new ReactiveCallStore(this.calls, graph.compatibleBindings(this.graph))

    try {
      return calls.evaluate((operations) => graph.evaluate(this.values, operations))
    } finally {
      calls.dispose(this.calls)
    }
  }

  private disconnectBindings() {
    for (const cleanup of this.bindingCleanups) cleanup()

    this.bindingCleanups = []
  }

  private clearBindings() {
    this.disconnectBindings()

    try {
      this.values = this.evaluateValues(this.values)
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
    this.bindingCleanups = this.calls.bind(this.execution.connectSource, (notification) =>
      this.applyValues(this.values, notification),
    )
    this.values = this.evaluateValues(this.values)
    this.evaluateEvents(false)
    this.resolution = resolveLayers(this.definition, this.values, this.resolution.states, false)
    this.resolution = this.controllerResolution(this.resolution, this.values, performance.now())
    this.execution.initialize(this.resolution)
  }

  replaceDefinition(definition: Definition) {
    if (this.disposed) return

    this.execution.endCompositionPreview()
    this.invalidateBinding()
    this.execution.freezeEnvironment()

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
    const graph = new LetBindingGraph(definition.letBindings ?? [], layerTargets(definition))

    const calls = new ReactiveCallStore(this.calls, graph.compatibleBindings(this.graph))

    try {
      calls.evaluate((operations) =>
        graph.evaluate(variables, operations, (values) => {
          resolveLayers(definition, values)

          for (const event of definition.events ?? []) evaluate(event.when, values)

          return values
        }),
      )
    } catch (error) {
      calls.dispose(this.calls)

      throw error
    }

    this.execution.releaseControllers()
    // The candidate can borrow live calls. Resampling the retiring store after
    // disconnection could retire a call that the candidate still holds.
    this.disconnectBindings()
    this.execution.resetPresentation()
    this.calls.dispose(calls)
    this.graph = graph
    this.calls = calls
    this.values = this.evaluateValues(variables)
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
    const previous = this.values
    const revision = this.revision

    try {
      this.execution.endCompositionPreview()

      let resolution: LayerResolution | undefined
      values = this.evaluateValues(
        values,
        (snapshot) => {
          resolution = resolveLayers(
            this.definition,
            snapshot,
            this.resolution.states,
            true,
            notification?.event,
          )

          this.execution.validatePresence(
            this.resolution,
            orderedResolution(resolution, this.definition),
            snapshot,
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
    const receivers = this.execution.observeReceivers(resolution, targets, live)
    const bindings = planControllerBindings(resolution, receivers)
    const outputs = new Map(this.execution.applyControllers(bindings, values, time, live))

    for (const receiver of receivers) {
      for (const property of receiver.fallbacks)
        outputs.set(layerPropertyKey(receiver.target, property), undefined)
    }

    return planControllerPresentation(resolution, normal, outputs, definition)
  }

  private applyPresentation(previous: LayerResolution, next: LayerResolution) {
    this.execution.present(previous, next, this.values)
  }

  /** Numeric/displayed observations are requested only after canonical ownership is known. */
  private planTracks(
    sources: readonly {
      readonly receiver: number
      readonly source: ResolvedTrack
      readonly declarations?: ReceiverAddresses['addresses']
    }[],
    facts: PresentationFacts,
    fill: TrackPlan['fill'],
  ) {
    const timings = new Map(sources.map(({ source }) => [source, trackTiming(source)]))
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

  /** Presence ownership changes can reacquire a controller without waiting for another input. */
  private refreshOwnership() {
    const time = performance.now()

    this.execution.terminalControls(time)
    this.resolution = this.controllerResolution(
      resolveLayers(this.definition, this.values, this.resolution.states, false),
      this.values,
      time,
    )
    // Reacquisition uses accepted call capabilities and their committed input baseline.
    // Sampling the graph here could consume a pending source notification before its
    // candidate validation and event callbacks in applyTransaction.
    this.execution.initialize(this.resolution)
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

        return tracks.map((source) => ({
          receiver: receiver.id,
          source: phase ? { ...source, implicitStart: false } : source,
        }))
      })
      // Lifecycle declarations have their own ownership. Ordinary previews share the application cascade.
      const addresses = phase
        ? []
        : this.execution.observeReceivers(
            next,
            new Set(sources.map(({ source }) => source.target)),
            false,
          )
      const tracks = this.planTracks(
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
    this.execution.freezeEnvironment(true)
    this.execution.releaseControllers()
    this.clearBindings()
    this.calls.dispose()
    this.execution.dispose()
    this.events.clear()
    this.onEvent = undefined
    this.onUpdate = undefined
    this.disposed = true
  }
}
