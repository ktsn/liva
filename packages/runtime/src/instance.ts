import { propertyReference, propertyAddresses, canonicalTracks } from './property-codec.ts'
import { propertyRule } from './property-rules.ts'
import { propertyController, type PropertyController } from './controllers.ts'
import type { ReactiveNotification } from './events.ts'
import {
  layerPropertyChanged,
  layerTargets,
  resolveLayers,
  resolveLayerTracks,
  resolveComposition,
  type LayerResolution,
  type Composition,
  type CompositionTransition,
} from './layers.ts'
import { waapiProperty } from './animation.ts'
export { waapiProperty } from './animation.ts'
import { parameterValues, LetBindingGraph, targetValues } from './let-bindings.ts'
import { evaluate, renderTransition, type VariableValues } from './expression.ts'
import type { Definition } from './definition.ts'
import { type ResolvedTrack } from './resolve.ts'
import {
  resolveLifecycle,
  resolveLifecycleTracks,
  captureLifecycleDefinition,
  hasLifecycle,
  lifecycleTransitions,
  type LifecycleSession,
} from './lifecycle.ts'
import { sampleSpring } from './spring.ts'
import { trackLayoutAnimation } from './layout-scheduler.ts'
import { PropertyMotion, type MotionSample } from './property-motion.ts'

export interface RuntimeDiagnostic {
  readonly code: string
  readonly message: string
  readonly track?: ResolvedTrack
  readonly error?: unknown
}

type InlineValue = { value: string; priority: string }
type OwnedElement = {
  element: HTMLElement
  original: Map<string, InlineValue>
  originalCss: string
  pending: Map<string, { property: string; value: string; priority: string }>
  written: Map<string, InlineValue>
}

function inlineDeclarations(element: HTMLElement): Map<string, InlineValue> {
  return new Map(
    Array.from(element.style).map((property) => [
      property,
      {
        value: element.style.getPropertyValue(property),
        priority: element.style.getPropertyPriority(property),
      },
    ]),
  )
}

type ActiveTrack = {
  track: ResolvedTrack
  element: HTMLElement
  animation: Animation
  sourceProperty: string
  sourceDestination: string
  reference?: string
  trajectory?: (milliseconds: number) => MotionSample
}

const layerPropertyKey = (target: string, property: string) => `${target}\0${property}`

export class LivaInstance {
  definition: Definition
  private layerResolution: LayerResolution
  private values: VariableValues = {}
  private letBindings: LetBindingGraph
  private letBindingCleanups: (() => void)[] = []
  onUpdate?: () => void
  onEvent?: (name: string) => void
  private eventValues = new Map<string, boolean>()
  private targets = new Map<string, HTMLElement>()
  private targetElements = new Map<string, HTMLElement[]>()
  private active: ActiveTrack[] = []
  private bindingRevision = 0
  private readonly propertyMotion = new PropertyMotion()
  private readonly dirtyProperties = new Map<HTMLElement, Set<string>>()
  private referenceFrame?: number
  private readonly referenceRetargets = new Set<string>()
  private controllers = new Map<string, PropertyController>()
  private controllerInstances = new Set<PropertyController>()
  private applyingVariables = false
  private variableUpdateScheduled = false
  private readonly queuedVariableUpdates: {
    values: VariableValues
    notification?: ReactiveNotification
  }[] = []
  private enterSessions = new Set<LifecycleSession>()
  private leaveSessions = new Set<LifecycleSession>()
  private settledLifecycleSessions = new WeakSet<LifecycleSession>()
  private owned: OwnedElement[] = []
  private generation = 0
  private manuallyPaused = false
  private compositionPreview = false
  private disposed = false
  private suspended = true
  private duplicateBindings = false
  private readonly motion: MediaQueryList
  private readonly report: (diagnostic: RuntimeDiagnostic) => void

  constructor(
    definition: Definition,
    inputs: Readonly<Record<string, unknown>> = {},
    report: (diagnostic: RuntimeDiagnostic) => void = console.warn,
  ) {
    this.report = report
    const variables = parameterValues(definition.parameters ?? [], targetValues(definition), inputs)
    this.letBindings = new LetBindingGraph(
      definition.letBindings ?? [],
      variables,
      undefined,
      layerTargets(definition),
    )
    this.values = this.letBindings.evaluate(variables)
    this.definition = definition
    this.configureControllers(definition, this.values)
    this.evaluateEvents(false)
    this.layerResolution = resolveLayers(definition, this.values)
    this.motion = matchMedia('(prefers-reduced-motion: reduce)')
    this.motion.addEventListener('change', this.motionChanged)
  }

  retainLifecycle(phase: 'enter' | 'leave', session: LifecycleSession) {
    const sessions = phase === 'enter' ? this.enterSessions : this.leaveSessions

    if (sessions.has(session)) return

    sessions.add(session)

    void session.finished.then(() => {
      if (this.settledLifecycleSessions.has(session)) return undefined

      this.settledLifecycleSessions.add(session)

      // Sessions mark themselves finished before their Promise callbacks run, so
      // several presence boundaries may already be done here. Remove them together
      // and mark their callbacks handled to avoid repeating restore/settle for each.
      for (const completed of sessions) {
        if (completed.isFinished) {
          sessions.delete(completed)
          this.settledLifecycleSessions.add(completed)
        }
      }

      if (phase === 'enter' && !this.disposed && !this.compositionPreview) {
        // Layers may change while enter plays toward its captured destination.
        // Restore first to clear styles absent from the latest presentation, then
        // apply that presentation. Preserve properties owned by remaining lifecycle
        // sessions; settle also skips those properties until their sessions finish.
        this.restore(this.enterSessions.size > 0 || this.leaveSessions.size > 0)
        this.settle()
      }

      return undefined
    })
  }

  captureLifecycle(phase: 'enter' | 'leave', names: readonly string[], element?: HTMLElement) {
    const definition = this.definition
    const targets = new Map(
      [...this.targets]
        .filter(([name]) => names.includes(name))
        .map(([name, target]) => [name, element ?? target]),
    )
    const work = resolveLifecycle(
      phase,
      captureLifecycleDefinition(definition, phase, this.values),
      this.layerResolution.presentation,
      targets,
    )

    return phase === 'enter' ? work.map((item) => ({ ...item, restoreOnCompletion: true })) : work
  }

  releaseLifecycle(names: readonly string[], element: HTMLElement, properties?: readonly string[]) {
    const interrupted = this.active.filter(
      (entry) =>
        names.includes(entry.track.target) &&
        entry.element === element &&
        (properties === undefined || properties.includes(entry.track.property)),
    )
    this.active = this.active.filter((entry) => !interrupted.includes(entry))
    for (const entry of interrupted) entry.animation.cancel()
  }

  get composition(): Composition {
    const composition = this.layerResolution.composition
    return { layers: { ...composition.layers }, states: { ...composition.states } }
  }

  get animations(): readonly Animation[] {
    return this.active.map((a) => a.animation)
  }

  private configureControllers(definition: Definition, values: VariableValues) {
    this.controllerInstances.clear()
    for (const target of layerTargets(definition)) {
      for (const property of target.properties) {
        if (property.value.kind !== 'binding') continue

        const controller = propertyController(evaluate(property.value.expression, values))
        this.controllerInstances.add(controller)
        controller.configure({
          target: target.name,
          property: property.name,
          motion: this.propertyMotion,
          report: (message) => this.report({ code: 'runtime.controller', message }),
        })
      }
    }
  }

  private optionalControllerTargets(definition: Definition): ReadonlySet<string> {
    return new Set(
      layerTargets(definition)
        .filter((target) => target.properties.some((property) => property.value.kind === 'binding'))
        .map((target) => target.name),
    )
  }

  private releaseControllers(time = performance.now()) {
    for (const controller of this.controllers.values()) controller.release(time)
    this.controllers.clear()
  }

  private orderedResolution(resolution: LayerResolution, definition: Definition): LayerResolution {
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

  private ownsCanonicalProperty(
    resolution: LayerResolution,
    element: HTMLElement,
    target: string,
    sourceProperty: string,
    canonicalProperty: string,
  ): boolean {
    if (!propertyAddresses(element, sourceProperty).includes(canonicalProperty)) return true
    const declarations = resolution.presentation.targets
      .filter((candidate) => candidate.name === target)
      .flatMap((candidate) => candidate.properties)
      .filter((property) => propertyAddresses(element, property.name).includes(canonicalProperty))
    // The source declaration that produced this canonical track is itself a candidate.
    const winner = declarations[declarations.length - 1]

    return winner.name === sourceProperty
  }

  /**
   * Resolves effective controller bindings into CSS values and, in live mode,
   * reconciles controller ownership for the next presentation. Bindings obscured
   * by other declarations are omitted. If a controller cannot supply a value, the
   * same composition is resolved without bindings to recover a normal declaration;
   * properties without a fallback are omitted.
   *
   * @param resolution - Layer selection and presentation resolved from definition.
   * @param values - Expression values used to resolve bindings and fallback styles.
   * @param time - Acquisition/release time in performance.now()-compatible milliseconds.
   * @param definition - Source definition matching the resolution's layer owners.
   * @param live - Acquires effective controllers and releases previous owners when
   * true; false renders snapshots for inspection/preview without changing ownership.
   * @returns A new resolution with properties in declaration order. The caller
   * applies its CSS values to the DOM.
   * @throws If expression evaluation fails or a binding lacks a controller capability.
   */
  private controllerResolution(
    resolution: LayerResolution,
    values: VariableValues,
    time: number,
    definition = this.definition,
    live = true,
  ): LayerResolution {
    // Declaration order determines ownership, including overlapping shorthand,
    // longhand, and logical properties that address the same physical CSS property.
    resolution = this.orderedResolution(resolution, definition)

    if (
      !resolution.presentation.targets.some((target) =>
        target.properties.some((property) => property.binding),
      )
    ) {
      // Without effective bindings, live control ends for every previous owner.
      if (live) this.releaseControllers(time)

      return this.orderedResolution(resolution, definition)
    }

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

    const controllers = new Map<string, PropertyController>()
    const targets = resolution.presentation.targets.map((target) => ({
      ...target,
      properties: target.properties.flatMap((property) => {
        if (!property.binding) return [property]

        // A binding must own every physical property it affects on each receiver;
        // otherwise omit it so it cannot overwrite a winning declaration.
        const elements = this.targetElements.get(target.name) ?? []
        const obscured = elements.some((element) =>
          propertyAddresses(element, property.name).some(
            (address) =>
              !this.ownsCanonicalProperty(resolution, element, target.name, property.name, address),
          ),
        )

        if (obscured) return []

        // Live control acquires from the displayed pose. Inspection and preview
        // only format the supplied snapshot, leaving live ownership unchanged.
        const snapshot = evaluate(property.binding, values)
        const controller = propertyController(snapshot)
        const key = layerPropertyKey(target.name, property.name)
        controllers.set(key, controller)

        if (live) controller.acquire(time)

        const value = live
          ? controller.control()?.value
          : controller.render(property.name, snapshot)

        if (value !== undefined) return [{ ...property, value }]

        // Missing controller output falls back to the same property's normal
        // declaration; omit the property if no such declaration exists.
        const fallback = normal.presentation.targets
          .find((candidate) => candidate.name === target.name)
          ?.properties.find((candidate) => candidate.name === property.name)

        return fallback ? [fallback] : []
      }),
    }))

    // Release replaced or obscured owners before the caller prepares transitions,
    // allowing their input velocity to be handed to the next spring.
    if (live) {
      for (const [key, controller] of this.controllers) {
        if (controllers.get(key) !== controller) controller.release(time)
      }

      this.controllers = controllers
    }

    // A fallback can belong to an earlier declaration, so restore cascade order
    // before the caller applies styles or checks physical property ownership.
    return this.orderedResolution(
      { ...resolution, presentation: { ...resolution.presentation, targets } },
      definition,
    )
  }

  private snapshotValues(definition: Definition): VariableValues {
    const graph = new LetBindingGraph(
      definition.letBindings ?? [],
      this.values,
      this.letBindings,
      layerTargets(definition),
    )

    try {
      return graph.evaluate(this.values)
    } finally {
      graph.dispose(this.letBindings)
    }
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

  private clearReferenceFrame() {
    if (this.referenceFrame !== undefined) cancelAnimationFrame(this.referenceFrame)
    this.referenceFrame = undefined
  }

  private refreshReferences = () => {
    this.clearReferenceFrame()
    /* v8 ignore if -- @preserve: cancel() removes the RAF and active effects before disposal/preview; finished callbacks check active membership. */
    if (this.disposed || this.compositionPreview) return

    for (const entry of this.active) {
      if (entry.reference === undefined || entry.animation.playState === 'paused') continue
      const next = propertyReference(
        entry.element,
        entry.track.property,
        entry.track.destinationValue,
      )

      if (next !== entry.reference)
        this.referenceRetargets.add(layerPropertyKey(entry.track.target, entry.sourceProperty))
    }

    if (this.referenceRetargets.size > 0) {
      try {
        this.applyLayerResolution(this.layerResolution, this.layerResolution)
      } catch (error) {
        this.report({ code: 'runtime.animation', message: String(error), error })
      } finally {
        this.referenceRetargets.clear()
      }
    }

    this.scheduleReferences()
  }

  private scheduleReferences() {
    if (
      this.referenceFrame !== undefined ||
      !this.active.some((entry) => entry.reference !== undefined)
    )
      return
    this.referenceFrame = requestAnimationFrame(this.refreshReferences)
  }

  private motionChanged = () => {
    if (this.motion.matches && !this.manuallyPaused) {
      this.cancel()
      this.settle()
    }
  }

  private cancel(cancelEnter = true, preserveControllerSnapshot = false) {
    this.compositionPreview = false
    this.clearReferenceFrame()
    this.referenceRetargets.clear()
    if (!preserveControllerSnapshot) {
      for (const controller of this.controllerInstances) controller.setPreview(false)
    }
    this.propertyMotion.reset()
    this.dirtyProperties.clear()
    if (cancelEnter) {
      for (const session of this.enterSessions) session.cancel('superseded')
      this.enterSessions.clear()
    }
    this.generation++
    this.manuallyPaused = false

    for (const { animation } of this.active) {
      animation.cancel()
    }

    this.active = []
  }

  private write(element: HTMLElement, property: string, value: string) {
    const before = inlineDeclarations(element)
    let owned = this.owned.find((o) => o.element === element)

    if (!owned) {
      owned = {
        element,
        original: before,
        originalCss: element.style.cssText,
        pending: new Map(),
        written: new Map(),
      }
      this.owned.push(owned)
    }

    const beforeCss = element.style.cssText
    if (propertyRule(property)?.kind === 'length') {
      // Keep CSS logical/physical aliases in the same order as the resolved cascade.
      element.style.removeProperty(property)
    }

    element.style.setProperty(property, value)
    const after = inlineDeclarations(element)

    const pending = document.createElement('div')
    if (beforeCss !== element.style.cssText) {
      pending.style.setProperty(property, value)
    }
    const pendingNames = new Set(
      Array.from(pending.style).filter((name) => pending.style.getPropertyValue(name) === ''),
    )

    // CSSOM enumerates the affected longhands, including shorthand side effects.
    for (const name of new Set([...before.keys(), ...after.keys()])) {
      const previous = before.get(name)
      const next = after.get(name)

      if (
        pendingNames.has(name) ||
        previous?.value !== next?.value ||
        previous?.priority !== next?.priority
      ) {
        owned.written.set(name, next ?? { value: '', priority: '' })

        if (pendingNames.has(name)) {
          owned.pending.set(name, {
            property,
            value: element.style.getPropertyValue(property),
            priority: element.style.getPropertyPriority(property),
          })
        } else {
          owned.pending.delete(name)
        }
      }
    }
    const dirty = this.dirtyProperties.get(element) ?? new Set<string>()
    dirty.add(property)
    this.dirtyProperties.set(element, dirty)
  }

  private lifecycleOwns(element: HTMLElement, property: string): boolean {
    return [...this.enterSessions, ...this.leaveSessions].some((session) =>
      session.owns(element, property),
    )
  }

  private flushMotionSamples(time = performance.now()) {
    const pending = new Map(this.dirtyProperties)
    this.dirtyProperties.clear()

    for (const [element, properties] of pending) {
      const protectedAddresses = new Set(
        this.active
          .filter((entry) => entry.element === element)
          .flatMap((entry) => [...propertyAddresses(element, entry.track.property)]),
      )

      for (const property of properties)
        this.propertyMotion.record(element, property, time, protectedAddresses)
    }
  }

  private restore(preserveLifecycle = false) {
    const protectedValues = preserveLifecycle
      ? this.owned.flatMap(({ element }) =>
          [
            ...new Set(
              (['enter', 'leave'] as const).flatMap((phase) =>
                lifecycleTransitions(this.definition, phase).flatMap((transition) =>
                  transition.targets.flatMap((target) =>
                    target.properties.map((property) => property.name),
                  ),
                ),
              ),
            ),
          ]
            .filter((property) => this.lifecycleOwns(element, property))
            .map((property) => ({
              element,
              property,
              value: element.style.getPropertyValue(property),
              priority: element.style.getPropertyPriority(property),
            })),
        )
      : []

    for (const { element, original, originalCss, pending, written } of this.owned) {
      const dirty = this.dirtyProperties.get(element) ?? new Set<string>()
      for (const property of written.keys()) dirty.add(property)
      this.dirtyProperties.set(element, dirty)

      const current = inlineDeclarations(element)
      const baseline = document.createElement('div')
      const external = document.createElement('div')
      baseline.style.cssText = originalCss
      external.style.cssText = element.style.cssText
      const stillOwned = new Set<string>()

      for (const [property, last] of written) {
        const value = current.get(property) ?? { value: '', priority: '' }
        const signature = pending.get(property)
        const pendingChanged =
          signature !== undefined &&
          (element.style.getPropertyValue(signature.property) !== signature.value ||
            element.style.getPropertyPriority(signature.property) !== signature.priority)

        if (!pendingChanged && value.value === last.value && value.priority === last.priority) {
          stillOwned.add(property)
          external.style.removeProperty(property)
        }
      }

      for (const property of original.keys()) {
        if (!stillOwned.has(property) && !current.has(property)) {
          baseline.style.removeProperty(property)
        }
      }

      for (const property of Array.from(external.style)) {
        baseline.style.removeProperty(property)
      }

      // Restore the intact original serialization, then overlay external writes.
      // This retains var()-valued shorthands that CSSOM cannot expose as longhands.
      element.style.cssText = baseline.style.cssText + ';' + external.style.cssText
    }

    for (const { element, property, value, priority } of protectedValues)
      element.style.setProperty(property, value, priority)

    if (!preserveLifecycle) this.owned = []
  }

  /** Reconciles presentation, optionally restricting writes to one receiving element. */
  private settle(receivingElement?: HTMLElement) {
    if (this.suspended || this.disposed) return

    for (const target of this.layerResolution.presentation.targets) {
      for (const element of this.targetElements.get(target.name) ?? []) {
        if (receivingElement && element !== receivingElement) continue

        for (const property of target.properties) {
          if (this.lifecycleOwns(element, property.name)) continue

          this.write(element, property.name, property.value)
        }
      }
    }
    this.flushMotionSamples()
  }

  bind(entries: readonly (readonly [string, HTMLElement])[]) {
    if (this.disposed) return

    const next = new Map(entries)
    const duplicate = next.size !== entries.length && !hasLifecycle(this.definition)
    const optional = this.optionalControllerTargets(this.definition)
    const missing = layerTargets(this.definition).some(
      (target) =>
        target.properties.length > 0 && !optional.has(target.name) && !next.has(target.name),
    )
    const unchanged =
      !duplicate &&
      (!missing || hasLifecycle(this.definition)) &&
      !this.suspended &&
      entries.length === [...this.targetElements.values()].flat().length &&
      entries.every(([key, value]) => this.targetElements.get(key)?.includes(value))

    if (unchanged) return

    this.endCompositionPreview()
    this.bindingRevision++
    this.queuedVariableUpdates.length = 0

    const previousInputs = JSON.stringify(this.values)

    this.releaseControllers()
    this.clearLetBindings()
    this.propertyMotion.reset()
    this.dirtyProperties.clear()
    this.cancel(false)
    this.restore(this.enterSessions.size > 0)
    this.targets = next
    this.targetElements.clear()
    for (const [name, element] of entries) {
      const elements = this.targetElements.get(name) ?? []
      elements.push(element)
      this.targetElements.set(name, elements)
    }
    this.duplicateBindings = duplicate
    this.suspended = duplicate || (missing && !hasLifecycle(this.definition))

    this.layerResolution = resolveLayers(
      this.definition,
      this.values,
      this.layerResolution.states,
      // Subscription cleanup can publish a new logical input, such as ending a drag.
      previousInputs !== JSON.stringify(this.values),
    )

    if (this.suspended) {
      this.report({
        code: 'runtime.targets',
        message: duplicate ? 'Duplicate target binding' : 'Missing target binding',
      })
    } else {
      this.bindLetBindings()
      this.settle()
    }
  }

  replaceDefinition(definition: Definition) {
    if (this.disposed) return
    this.endCompositionPreview()
    this.bindingRevision++
    this.queuedVariableUpdates.length = 0

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
    const letBindings = new LetBindingGraph(
      definition.letBindings ?? [],
      variables,
      this.letBindings,
      layerTargets(definition),
    )

    this.releaseControllers()
    this.clearLetBindings()
    this.cancel()
    this.restore()

    this.letBindings.dispose(letBindings)
    this.letBindings = letBindings
    this.values = letBindings.evaluate(variables)
    this.definition = definition
    this.propertyMotion.reset()
    this.dirtyProperties.clear()
    this.configureControllers(definition, this.values)
    this.eventValues.clear()
    this.evaluateEvents(false)
    this.layerResolution = resolveLayers(definition, this.values)
    this.suspended =
      this.duplicateBindings ||
      (!hasLifecycle(definition) &&
        layerTargets(definition).some(
          (t) =>
            t.properties.length > 0 &&
            !this.optionalControllerTargets(definition).has(t.name) &&
            !this.targets.has(t.name),
        ))
    if (!this.suspended) this.bindLetBindings()
    this.settle()
  }

  /** Preview explicit selections while retaining the application's definition and machine history. */
  previewComposition(
    from: Composition,
    to: Composition,
    transitions: readonly CompositionTransition[] = [],
    definition = this.definition,
  ): void {
    this.prepareCompositionPreview(from, to, transitions, definition)
  }

  private prepareCompositionPreview(
    from: Composition,
    to: Composition,
    transitions: readonly CompositionTransition[],
    definition: Definition,
    phase?: 'enter' | 'leave',
  ): void {
    if (this.disposed || this.suspended) {
      throw new Error('Composition preview requires a mounted layer instance')
    }

    const prepared: ActiveTrack[] = []

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

      for (const controller of this.controllerInstances) controller.setPreview(true)
      this.cancel(true, true)
      this.restore()
      this.propertyMotion.reset()
      this.dirtyProperties.clear()
      this.compositionPreview = true

      const present = (resolution: LayerResolution) => {
        for (const target of resolution.presentation.targets) {
          for (const element of this.targetElements.get(target.name) ?? []) {
            for (const property of target.properties) {
              this.write(element, property.name, property.value)
            }
          }
        }
      }

      present(previous)

      for (const [target, elements] of this.targetElements) {
        const targetResolution = {
          ...next,
          presentation: {
            ...next.presentation,
            targets: next.presentation.targets.filter((item) => item.name === target),
          },
        }

        for (const element of elements) {
          const tracks = phase
            ? resolveLifecycleTracks(phase, lifecycle, next.presentation, (name, property) =>
                name === target ? getComputedStyle(element).getPropertyValue(property) : undefined,
              )
            : resolveLayerTracks(
                previous,
                targetResolution,
                values,
                (_name, property) => getComputedStyle(element).getPropertyValue(property),
                (message) => this.report({ code: 'runtime.endpoint', message }),
                () => true,
              )

          for (const track of tracks) {
            const timing =
              track.timing.kind === 'tween'
                ? { durationMs: track.timing.durationMs, easing: 'linear' }
                : sampleSpring(track.timing)
            const animation = new Animation(
              new KeyframeEffect(
                element,
                track.keyframes.map((frame) => ({
                  [waapiProperty(track.property)]: frame.value,
                  offset: frame.offset,
                  easing: frame.easing,
                })),
                {
                  duration: timing.durationMs,
                  easing: timing.easing,
                  fill: phase === 'leave' ? 'both' : 'backwards',
                },
              ),
              document.timeline,
            )

            prepared.push({
              track,
              element,
              animation,
              sourceProperty: track.property,
              sourceDestination: track.destinationValue,
            })
          }
        }
      }

      this.restore()
      present(next)
      this.active = prepared
      this.manuallyPaused = true

      for (const { animation } of prepared) {
        animation.pause()
        animation.currentTime = 0
      }
    } catch (cause) {
      for (const { animation } of prepared) animation.cancel()

      this.cancel()
      this.restore()
      this.settle()
      const error = new Error('Could not prepare composition preview', { cause })
      this.report({ code: 'runtime.preview', message: error.message, error })
      throw error
    }
  }

  endCompositionPreview(): void {
    if (!this.compositionPreview) return

    this.cancel()
    this.restore()
    this.settle()
  }

  /** Prepare scrub-ready lifecycle effects without invoking presence removal callbacks. */
  previewLifecycle(
    phase: 'enter' | 'leave',
    composition = this.composition,
    definition = this.definition,
  ): void {
    this.prepareCompositionPreview(composition, composition, [], definition, phase)
  }

  updateParameters(inputs: Readonly<Record<string, unknown>>) {
    if (this.disposed) return

    try {
      this.applyVariableValues(
        parameterValues(this.definition.parameters ?? [], this.values, inputs),
      )
    } catch (error) {
      this.report({ code: 'runtime.parameter', message: String(error), error })
    }
  }

  private evaluateEvents(emit = true) {
    const pending: string[] = []

    for (const event of this.definition.events ?? []) {
      const next = evaluate(event.when, this.values) === true
      if (emit && next && this.eventValues.get(event.name) === false) pending.push(event.name)
      this.eventValues.set(event.name, next)
    }

    for (const name of pending) this.onEvent?.(name)
  }

  private applyVariableValues(values: VariableValues, notification?: ReactiveNotification) {
    /* v8 ignore if -- @preserve: Public updates guard disposal; graph subscriptions and queued updates are cleared before disposal completes. */
    if (this.disposed) return

    if (this.applyingVariables || this.variableUpdateScheduled) {
      this.queuedVariableUpdates.push({ values, notification })
      return
    }

    this.runVariableUpdate(values, notification)
  }

  /** Runs one accepted update; later arrivals join the pending queue until it drains. */
  private runVariableUpdate(values: VariableValues, notification?: ReactiveNotification) {
    this.applyingVariables = true

    try {
      this.applyVariableTransaction(values, notification)
    } finally {
      this.applyingVariables = false

      if (this.queuedVariableUpdates.length > 0 && !this.variableUpdateScheduled) {
        this.variableUpdateScheduled = true
        queueMicrotask(() => {
          this.variableUpdateScheduled = false
          const next = this.queuedVariableUpdates.shift()
          if (next)
            this.runVariableUpdate(next.notification ? this.values : next.values, next.notification)
        })
      }
    }
  }

  private applyVariableTransaction(values: VariableValues, notification?: ReactiveNotification) {
    this.endCompositionPreview()
    const previous = this.values
    const revision = this.bindingRevision

    try {
      let resolution: LayerResolution | undefined
      values = this.letBindings.evaluate(
        values,
        (snapshot) => {
          resolution = resolveLayers(
            this.definition,
            snapshot,
            this.layerResolution.states,
            true,
            notification?.event,
          )

          for (const event of this.definition.events ?? []) evaluate(event.when, snapshot)
        },
        notification,
      )
      this.values = values
      this.evaluateEvents()
      if (this.disposed || revision !== this.bindingRevision) return

      const time = notification?.time ?? performance.now()

      const terminalControls = [...this.controllers.values()].map((controller) =>
        controller.control(),
      )

      for (const controlled of terminalControls) {
        if (controlled) this.write(controlled.element, controlled.property, controlled.value)
      }

      this.flushMotionSamples(time)

      // Validation above always resolves the complete presentation before committing calls.
      const next = this.controllerResolution(resolution!, values, time)
      this.applyLayerResolution(this.layerResolution, next)
      this.onUpdate?.()
    } catch (error) {
      this.values = previous
      this.report({ code: 'runtime.expression', message: String(error), error })
    }
  }

  private applyLayerResolution(previous: LayerResolution, next: LayerResolution) {
    const prepared: ActiveTrack[] = []
    const changed = new Set<string>(this.referenceRetargets)
    for (const entry of this.active) {
      if (
        entry.track.directionalOwner !== undefined &&
        next.states.get(entry.track.directionalOwner) !== entry.track.ownerState
      ) {
        changed.add(layerPropertyKey(entry.track.target, entry.track.property))
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
    const removed = removedProperties.size > 0

    const tracks = resolveLayerTracks(
      previous,
      next,
      this.values,
      (target, property) => {
        const element = this.targets.get(target)
        return element ? getComputedStyle(element).getPropertyValue(property) : ''
      },
      (message) => this.report({ code: 'runtime.endpoint', message }),
      (target, property) => changed.has(layerPropertyKey(target, property)),
    )

    for (const target of next.presentation.targets) {
      for (const property of target.properties) {
        if (layerPropertyChanged(previous, target.name, property)) {
          changed.add(layerPropertyKey(target.name, property.name))

          for (const element of this.targetElements.get(target.name) ?? []) {
            for (const address of propertyAddresses(element, property.name))
              changed.add(layerPropertyKey(target.name, address))
          }
        }
      }
    }

    try {
      if (!this.suspended && !this.motion.matches) {
        for (const sourceTrack of tracks) {
          changed.add(layerPropertyKey(sourceTrack.target, sourceTrack.property))
          const timing =
            sourceTrack.timing.kind === 'tween'
              ? { durationMs: sourceTrack.timing.durationMs, easing: 'linear' }
              : sampleSpring(sourceTrack.timing)

          if (timing.durationMs === 0) continue

          for (const element of this.targetElements.get(sourceTrack.target) ?? []) {
            for (const track of canonicalTracks(element, sourceTrack)) {
              if (
                !this.ownsCanonicalProperty(
                  next,
                  element,
                  sourceTrack.target,
                  sourceTrack.property,
                  track.property,
                )
              )
                continue
              changed.add(layerPropertyKey(track.target, track.property))
              if (this.lifecycleOwns(element, track.property)) continue

              const interrupted = this.active.some(
                (entry) => entry.element === element && entry.track.property === track.property,
              )
              const frames = track.keyframes.map((frame, index) => ({
                [waapiProperty(track.property)]:
                  index === 0 && (track.implicitStart || interrupted)
                    ? getComputedStyle(element).getPropertyValue(track.property)
                    : frame.value,
                offset: frame.offset,
                easing: frame.easing,
              }))
              const handoff =
                track.timing.kind !== 'tween'
                  ? this.propertyMotion.prepareSpring(
                      element,
                      track.property,
                      track.destinationValue,
                      track.timing,
                      track.keyframes.every((frame) => frame.offset === 0 || frame.offset === 1),
                    )
                  : undefined
              const animation = new Animation(
                new KeyframeEffect(element, handoff?.frames ?? frames, {
                  duration: handoff?.durationMs ?? timing.durationMs,
                  easing: handoff ? 'linear' : timing.easing,
                  fill: 'both',
                }),
                document.timeline,
              )
              prepared.push({
                track,
                element,
                animation,
                trajectory: handoff?.sample,
                sourceProperty: sourceTrack.property,
                sourceDestination: sourceTrack.destinationValue,
                reference: propertyReference(
                  element,
                  sourceTrack.property,
                  sourceTrack.destinationValue,
                ),
              })
            }
          }
        }
      }
    } catch (error) {
      for (const entry of prepared) entry.animation.cancel()
      throw error
    }

    const replaced = this.active.filter(
      (entry) =>
        removedProperties.has(layerPropertyKey(entry.track.target, entry.sourceProperty)) ||
        changed.has(layerPropertyKey(entry.track.target, entry.sourceProperty)) ||
        changed.has(layerPropertyKey(entry.track.target, entry.track.property)),
    )
    this.active = this.active.filter((entry) => !replaced.includes(entry))

    for (const entry of replaced) entry.animation.cancel()

    this.layerResolution = next

    if (this.suspended) return

    if (removed) this.restore(this.enterSessions.size > 0 || this.leaveSessions.size > 0)

    for (const target of next.presentation.targets) {
      for (const property of target.properties) {
        if (!removed && !changed.has(layerPropertyKey(target.name, property.name))) continue

        for (const element of this.targetElements.get(target.name) ?? []) {
          if (!this.lifecycleOwns(element, property.name))
            this.write(element, property.name, property.value)
        }
      }
    }

    this.active.push(...prepared)
    this.flushMotionSamples()

    for (const entry of prepared) {
      entry.animation.play()
      trackLayoutAnimation(entry.element, entry.track.property, entry.animation)
      this.propertyMotion.register(
        entry.element,
        entry.track.property,
        entry.animation,
        entry.trajectory,
      )
      void entry.animation.finished
        .then(() => {
          if (!this.active.includes(entry)) return undefined

          if (
            entry.reference !== undefined &&
            propertyReference(entry.element, entry.sourceProperty, entry.sourceDestination) !==
              entry.reference
          ) {
            this.refreshReferences()
            return undefined
          }

          this.write(entry.element, entry.sourceProperty, entry.sourceDestination)
          entry.animation.cancel()
          this.active = this.active.filter((item) => item !== entry)
          // Cancelling a finished shorthand/logical effect can reveal another
          // declaration, including opaque CSS shorthands outside numeric codecs.
          // Restore the receiving element's complete cascade locally;
          // unrelated receiving elements must not be rewritten for every track.
          this.settle(entry.element)
          this.propertyMotion.beginControl(entry.element, entry.track.property, performance.now())
          return undefined
        })
        .catch((error) => {
          if (this.active.includes(entry)) {
            this.active = this.active.filter((item) => item !== entry)
            this.report({ code: 'runtime.animation', message: String(error), error })
          }
        })
    }
    this.scheduleReferences()
  }

  private clearLetBindings() {
    const cleanups = this.letBindingCleanups
    this.letBindingCleanups = []
    for (const cleanup of cleanups) cleanup()

    try {
      this.values = this.letBindings.evaluate(this.values)
    } catch (error) {
      this.report({ code: 'runtime.expression', message: String(error), error })
    }
  }

  private bindLetBindings() {
    this.letBindingCleanups.push(
      ...this.letBindings.bind(this.targets, (notification) =>
        this.applyVariableValues(this.values, notification),
      ),
    )

    // Inputs can initialize from the bound DOM, before the initial presentation settles.
    this.values = this.letBindings.evaluate(this.values)
    this.evaluateEvents(false)
    this.layerResolution = resolveLayers(
      this.definition,
      this.values,
      this.layerResolution.states,
      false,
    )
    this.layerResolution = this.controllerResolution(
      this.layerResolution,
      this.values,
      performance.now(),
    )
  }

  dispose() {
    if (this.disposed) return
    this.queuedVariableUpdates.length = 0
    this.releaseControllers()
    this.leaveSessions.clear()
    for (const session of this.enterSessions) session.cancel('owner-teardown')
    this.enterSessions.clear()
    this.clearLetBindings()
    this.letBindings.dispose()
    this.propertyMotion.reset()
    this.dirtyProperties.clear()
    this.cancel()
    this.restore()
    this.motion.removeEventListener('change', this.motionChanged)
    this.targets.clear()
    this.targetElements.clear()
    this.eventValues.clear()
    this.onEvent = undefined
    this.onUpdate = undefined
    this.disposed = true
  }
}
