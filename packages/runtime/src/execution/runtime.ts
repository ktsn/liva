import { layerTargets, resolveLayers, type LayerResolution } from '../composition/layers.ts'
import { parameterValues, LetBindingGraph, targetValues } from '../evaluation/let-bindings.ts'
import { evaluate, type VariableValues } from '../evaluation/expression.ts'
import type { ReactiveNotification } from '../evaluation/events.ts'
import type { Definition } from '../model/definition.ts'
import {
  compositionSnapshot,
  type ExecutionPort,
  type RuntimeDiagnostic,
} from './execution-contracts.ts'

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
    snapshotValues: (definition: Definition) => this.snapshotValues(definition),
    invalidateBinding: () => this.invalidateBinding(),
    clearBindings: () => this.clearBindings(),
    rebound: (advance: boolean) => this.rebound(advance),
    acceptPresentation: (resolution: LayerResolution) => {
      this.resolution = resolution
    },
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
    this.resolution = this.execution.controllerResolution(
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

    this.execution.settle()
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
      const next = this.execution.controllerResolution(resolution!, values, time)
      this.execution.applyLayerResolution(this.resolution, next)
      this.onUpdate?.()
    } catch (error) {
      this.values = previous
      this.report({ code: 'runtime.expression', message: String(error), error })
    }
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
