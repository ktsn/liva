import type { Composition, CompositionTransition } from '../composition/layers.ts'
import type { Definition } from '../model/definition.ts'
import type { LifecycleSession } from './lifecycle.ts'
import type { RuntimeDiagnostic } from './execution-contracts.ts'
import { PresentationExecutor } from './presentation-executor.ts'
import { Runtime } from './runtime.ts'

export { waapiProperty } from '../motion/animation.ts'
export type { RuntimeDiagnostic } from './execution-contracts.ts'

/** Public compatibility facade: logical requests go to Runtime, browser requests to execution. */
export class LivaInstance {
  private readonly runtime: Runtime
  private readonly executor: PresentationExecutor
  onEvent?: (name: string) => void
  onUpdate?: () => void

  constructor(
    definition: Definition,
    inputs: Readonly<Record<string, unknown>> = {},
    report: (diagnostic: RuntimeDiagnostic) => void = console.warn,
  ) {
    const diagnose = (diagnostic: RuntimeDiagnostic) => report.call(this, diagnostic)
    this.executor = new PresentationExecutor(diagnose)
    this.runtime = new Runtime(this.executor, definition, inputs, diagnose)
    this.runtime.onEvent = (name) => this.onEvent?.(name)
    this.runtime.onUpdate = () => this.onUpdate?.()
    this.executor.attach(this.runtime.environment)
  }

  get definition() {
    return this.runtime.definition
  }

  set definition(value: Definition) {
    this.runtime.definition = value
  }

  get composition() {
    return this.runtime.composition
  }

  get animations() {
    return this.executor.animations
  }

  bind(entries: readonly (readonly [string, HTMLElement])[]) {
    this.executor.bind(entries)
  }

  retainLifecycle(phase: 'enter' | 'leave', session: LifecycleSession) {
    this.executor.retainLifecycle(phase, session)
  }

  captureLifecycle(phase: 'enter' | 'leave', names: readonly string[], element?: HTMLElement) {
    return this.executor.captureLifecycle(phase, names, element)
  }

  releaseLifecycle(names: readonly string[], element: HTMLElement, properties?: readonly string[]) {
    this.executor.releaseLifecycle(names, element, properties)
  }

  inspectLifecycle(
    phase: 'enter' | 'leave',
    composition: Composition,
    definition = this.definition,
  ) {
    return this.runtime.inspectLifecycle(phase, composition, definition)
  }

  inspectComposition(
    composition: Composition,
    from?: Composition,
    transitions: readonly CompositionTransition[] = [],
    definition = this.definition,
  ) {
    return this.runtime.inspectComposition(composition, from, transitions, definition)
  }

  replaceDefinition(definition: Definition) {
    this.runtime.replaceDefinition(definition)
  }

  previewComposition(
    from: Composition,
    to: Composition,
    transitions: readonly CompositionTransition[] = [],
    definition = this.definition,
  ): void {
    this.runtime.previewComposition(from, to, transitions, definition)
  }

  endCompositionPreview(): void {
    this.executor.endCompositionPreview()
  }

  previewLifecycle(
    phase: 'enter' | 'leave',
    composition = this.composition,
    definition = this.definition,
  ): void {
    this.runtime.previewLifecycle(phase, composition, definition)
  }

  updateParameters(inputs: Readonly<Record<string, unknown>>) {
    this.runtime.updateParameters(inputs)
  }

  dispose() {
    this.runtime.dispose()
    this.onEvent = undefined
    this.onUpdate = undefined
  }
}
