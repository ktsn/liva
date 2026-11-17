import { resolveLayoutConfigurations } from '../composition/layout.ts'
import { releaseResources } from '../evaluation/resource-cleanup.ts'
import { layerTargets, resolveLayers, type LayerResolution } from '../composition/layers.ts'
import { parameterValues, LetBindingGraph, targetValues } from '../evaluation/let-bindings.ts'
import { evaluate, type VariableValues } from '../evaluation/expression.ts'
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
  planReconciliation,
  planMotionChange,
  type PresentationFacts,
  type PresentationPlan,
} from './presentation-planner.ts'
import { resolveControllerPresentation } from './controller-presentation.ts'

/**
 * Owns accepted inputs, evaluation/call lifetime, event and state-machine history,
 * and update ordering. Browser work is delegated through logical execution requests.
 * Candidate evaluation commits calls before events; event callbacks still observe
 * the previous composition, and may invalidate the binding before presentation.
 */
export class Runtime {
  private currentDefinition: Definition
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

    try {
      this.values = this.evaluateValues(variables, (values) => {
        resolveLayers(definition, values)

        for (const event of definition.events ?? []) evaluate(event.when, values)
      })
      this.currentDefinition = definition
      execution.configureControllers(definition, this.values)
      this.evaluateEvents(false)
      this.resolution = resolveLayers(definition, this.values)
      execution.initialize(this.resolution)
    } catch (error) {
      try {
        this.calls.dispose()
      } catch (cleanupError) {
        this.report({
          code: 'runtime.initialization-cleanup',
          message: String(cleanupError),
          error: cleanupError,
        })
      }

      throw error
    }
  }

  get definition(): Definition {
    return this.currentDefinition
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  get composition() {
    return compositionSnapshot(this.resolution.composition)
  }

  /**
   * Persistent settings for a fresh geometry transaction, without advancing state/events.
   * Excludes past directional overrides; an input/state update's transient selection is
   * supplied separately through ExecutionPort.present's next.layout configuration.
   */
  get layout() {
    return resolveLayoutConfigurations(this.definition, this.values, this.resolution.composition)
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

  /**
   * Evaluates a candidate with compatible borrowed calls and accepted parameters.
   * The synchronous transform runs before candidate subscription/call acceptance;
   * it must not publish events or presentation. All candidate-only calls are disposed,
   * including when evaluation/validation throws; borrowed live calls remain owned.
   */
  evaluateCandidate<T>(definition: Definition, transform: (values: VariableValues) => T): T {
    const graph = new LetBindingGraph(definition.letBindings ?? [], layerTargets(definition))
    const calls = new ReactiveCallStore(this.calls, graph.compatibleBindings(this.graph))
    try {
      return calls.evaluate((operations) => graph.evaluate(this.values, operations, transform))
    } finally {
      // A rejected evaluation already discards its newly created calls. Any cache
      // left here is either accepted candidate ownership or a borrowed live call.
      calls.dispose(this.calls)
    }
  }

  private disconnectBindings() {
    const cleanups = this.bindingCleanups
    this.bindingCleanups = []

    releaseResources(cleanups)
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
    this.resolution = resolveControllerPresentation(
      this.execution,
      this.definition,
      this.resolution,
      this.values,
      performance.now(),
    )
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
    this.currentDefinition = definition
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
      const next = resolveControllerPresentation(
        this.execution,
        this.definition,
        resolution!,
        values,
        time,
      )
      this.applyPresentation(this.resolution, next)
      this.onUpdate?.()
    } catch (error) {
      this.values = previous
      this.report({ code: 'runtime.expression', message: String(error), error })
    }
  }

  private applyPresentation(previous: LayerResolution, next: LayerResolution) {
    this.execution.present(previous, next, this.values)
  }

  /** Presence ownership changes can reacquire a controller without waiting for another input. */
  private refreshOwnership() {
    const time = performance.now()

    this.execution.terminalControls(time)
    this.resolution = resolveControllerPresentation(
      this.execution,
      this.definition,
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

    const facts = this.execution.presentationFacts()
    this.execution.applyPlan(planReconciliation(this.resolution, facts.receivers))
  }

  /** Browser notifications do not advance expressions, guards, or application events. */
  private applyObservedPlan(
    planner: (
      resolution: LayerResolution,
      facts: PresentationFacts,
    ) => PresentationPlan | undefined,
  ) {
    const facts = this.execution.presentationFacts()
    const plan = planner(this.resolution, facts)

    if (plan) this.execution.applyPlan(plan)
  }

  /**
   * Freezes accepted data for retained leave, disconnects calls and releases live
   * browser resources in order. Teardown attempts every independent owner, clears
   * callbacks/history even on failure, and throws cleanup errors to the caller.
   * Further disposal/parameter updates are inert.
   */
  dispose() {
    if (this.disposed) return

    this.disposed = true
    this.queue.length = 0

    try {
      // Keep normal phase order while allowing independent teardown to finish
      // after a disposer fails. Freeze detached leave before disconnecting inputs.
      releaseResources([
        () => this.execution.freezeEnvironment(true),
        () => this.execution.releaseControllers(),
        () => this.clearBindings(),
        () => this.calls.dispose(),
        () => this.execution.dispose(),
      ])
    } finally {
      this.events.clear()
      this.onEvent = undefined
      this.onUpdate = undefined
    }
  }
}
