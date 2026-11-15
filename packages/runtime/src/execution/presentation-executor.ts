import {
  replacedEffects,
  orderedResolution,
  ownsCanonicalProperty,
  prepareLayerChange,
  planLayerChange,
  layerPropertyKey,
  type DeclarationAddresses,
} from './presentation-planner.ts'
import type { RuntimeDiagnostic } from './execution-contracts.ts'
import type { BindingFacts, ExecutionEnvironment } from './execution-contracts.ts'
import { propertyReference, propertyAddresses, canonicalTracks } from '../motion/property-codec.ts'
import { propertyRule } from '../motion/property-rules.ts'
import { propertyController, type PropertyController } from '../motion/controllers.ts'
import type { ReactiveNotification } from '../evaluation/events.ts'
import {
  layerTargets,
  resolveLayerTracks,
  resolveComposition,
  type LayerResolution,
  type Composition,
  type CompositionTransition,
} from '../composition/layers.ts'
import { waapiProperty } from '../motion/animation.ts'
export { waapiProperty } from '../motion/animation.ts'
import { LetBindingGraph } from '../evaluation/let-bindings.ts'
import { evaluate, renderTransition, type VariableValues } from '../evaluation/expression.ts'
import type { Definition } from '../model/definition.ts'
import { type ResolvedTrack } from '../composition/resolve.ts'
import {
  resolveLifecycle,
  resolveLifecycleTracks,
  captureLifecycleDefinition,
  hasLifecycle,
  lifecycleTransitions,
  type LifecycleSession,
} from './lifecycle.ts'
import { sampleSpring } from '../motion/spring.ts'
import { trackLayoutAnimation } from '../layout/layout-scheduler.ts'
import { PropertyMotion, type MotionSample } from '../motion/property-motion.ts'

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

/** Binding validity is retained until rebinding or an explicit definition refresh. */
type BindingStatus = 'unbound' | 'ready' | 'missing' | 'duplicate'

/** Preparing previews suppress live restoration; completed previews also survive reduced-motion changes. */
type PresentationMode = 'live' | 'preparing-preview' | 'preview'

/** Each registered name retains its receiving elements in accepted binding order. */
type TargetElements = [HTMLElement, ...HTMLElement[]]

export class PresentationExecutor {
  private layerResolution!: LayerResolution
  private environment!: ExecutionEnvironment
  private letBindingCleanups: (() => void)[] = []

  get definition() {
    return this.environment.definition()
  }
  private get values() {
    return this.environment.values()
  }

  attach(environment: ExecutionEnvironment) {
    this.environment = environment
    this.motion = matchMedia('(prefers-reduced-motion: reduce)')
    this.motion.addEventListener('change', this.motionChanged)
  }

  initialize(resolution: LayerResolution) {
    this.layerResolution = resolution
  }

  get bindingFacts(): BindingFacts {
    return {
      suspended: this.suspended,
    }
  }

  private targetElements = new Map<string, TargetElements>()
  private active: ActiveTrack[] = []
  private readonly propertyMotion = new PropertyMotion()
  private readonly dirtyProperties = new Map<HTMLElement, Set<string>>()
  private referenceFrame?: number
  private controllers = new Map<string, PropertyController>()
  private controllerInstances = new Set<PropertyController>()
  private enterSessions = new Set<LifecycleSession>()
  private leaveSessions = new Set<LifecycleSession>()
  private owned: OwnedElement[] = []
  private presentationMode: PresentationMode = 'live'
  private bindingStatus: BindingStatus = 'unbound'
  private disposed = false
  private motion!: MediaQueryList
  private readonly report: (diagnostic: RuntimeDiagnostic) => void

  constructor(report: (diagnostic: RuntimeDiagnostic) => void) {
    this.report = report
  }

  private get suspended() {
    return this.bindingStatus !== 'ready'
  }

  snapshotValues(definition: Definition): VariableValues {
    return this.environment.snapshotValues(definition)
  }

  disconnectBindings() {
    const cleanups = this.letBindingCleanups
    this.letBindingCleanups = []

    for (const cleanup of cleanups) cleanup()
  }

  connectBindings(graph: LetBindingGraph, notify: (notification?: ReactiveNotification) => void) {
    this.letBindingCleanups.push(...graph.bind(new Map(this.representativeTargets()), notify))
  }

  /**
   * Single-receiver consumers use the last entry, matching Map construction from bind entries.
   * @yields Logical target names paired with their last accepted receiving element.
   */
  private *representativeTargets() {
    for (const [name, elements] of this.targetElements) {
      // bind creates each group with its first element, so every tuple is nonempty.
      yield [name, elements[elements.length - 1]] as const
    }
  }

  resetPresentation() {
    this.endCompositionPreview()
    this.releaseControllers()
    this.cancel()
    this.restore()
    this.propertyMotion.reset()
    this.dirtyProperties.clear()
  }

  terminalControls(time: number) {
    const controlled = [...this.controllers.values()].map((controller) => controller.control())

    for (const value of controlled) {
      if (value) this.write(value.element, value.property, value.value)
    }

    this.flushMotionSamples(time)
  }

  refreshSuspension(definition: Definition) {
    // A definition replacement does not validate previously rejected duplicate entries.
    this.bindingStatus = this.resolveBindingStatus(
      definition,
      this.targetElements,
      this.bindingStatus === 'duplicate',
    )
  }

  private resolveBindingStatus(
    definition: Definition,
    targets: ReadonlyMap<string, TargetElements>,
    duplicate: boolean,
  ): BindingStatus {
    if (duplicate) return 'duplicate'
    if (hasLifecycle(definition)) return 'ready'

    const optional = this.optionalControllerTargets(definition)
    const missing = layerTargets(definition).some(
      (target) =>
        target.properties.length > 0 && !optional.has(target.name) && !targets.has(target.name),
    )

    return missing ? 'missing' : 'ready'
  }

  /** Retains live ownership; already finished sessions and duplicate registrations are ignored. */
  retainLifecycle(phase: 'enter' | 'leave', session: LifecycleSession) {
    const sessions = phase === 'enter' ? this.enterSessions : this.leaveSessions

    if (session.isFinished || sessions.has(session)) return

    sessions.add(session)

    void session.finished.then(() => {
      // Removal also invalidates callbacks queued before cancellation or disposal.
      if (!sessions.has(session)) return undefined

      // Sessions mark themselves finished before their Promise callbacks run, so
      // several presence boundaries may already be done here. Remove them together;
      // later callbacks observe their removal and skip repeated restoration.
      for (const completed of sessions) {
        if (completed.isFinished) sessions.delete(completed)
      }

      if (phase === 'enter' && !this.disposed && this.presentationMode === 'live') {
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
      [...this.representativeTargets()]
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

  get animations(): readonly Animation[] {
    return this.active.map((a) => a.animation)
  }

  configureControllers(definition: Definition, values: VariableValues) {
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

  releaseControllers(time = performance.now()) {
    for (const controller of this.controllers.values()) controller.release(time)
    this.controllers.clear()
  }

  /** Captures only canonical identities, without retaining the receiving element in plans. */
  private declarationAddresses(
    resolution: LayerResolution,
    element: HTMLElement,
    target: string,
    source?: string,
  ): DeclarationAddresses {
    const names = resolution.presentation.targets
      .filter((item) => item.name === target)
      .flatMap((item) => item.properties.map((property) => property.name))

    if (source) names.push(source)

    return [...new Set(names)].map((name) => ({
      name,
      addresses: propertyAddresses(element, name),
    }))
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
  controllerResolution(
    resolution: LayerResolution,
    values: VariableValues,
    time: number,
    definition = this.definition,
    live = true,
  ): LayerResolution {
    // Declaration order determines ownership, including overlapping shorthand,
    // longhand, and logical properties that address the same physical CSS property.
    resolution = orderedResolution(resolution, definition)

    if (
      !resolution.presentation.targets.some((target) =>
        target.properties.some((property) => property.binding),
      )
    ) {
      // Without effective bindings, live control ends for every previous owner.
      if (live) this.releaseControllers(time)

      return orderedResolution(resolution, definition)
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
              !ownsCanonicalProperty(
                this.declarationAddresses(resolution, element, target.name, property.name),
                property.name,
                address,
              ),
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
    return orderedResolution(
      { ...resolution, presentation: { ...resolution.presentation, targets } },
      definition,
    )
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
    if (this.disposed || this.presentationMode !== 'live') return

    const retargets = new Set<string>()

    for (const entry of this.active) {
      if (entry.reference === undefined || entry.animation.playState === 'paused') continue
      const next = propertyReference(
        entry.element,
        entry.track.property,
        entry.track.destinationValue,
      )

      if (next !== entry.reference)
        retargets.add(layerPropertyKey(entry.track.target, entry.sourceProperty))
    }

    if (retargets.size > 0) {
      try {
        this.applyLayerChange(this.layerResolution, this.layerResolution, retargets)
      } catch (error) {
        this.report({ code: 'runtime.animation', message: String(error), error })
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
    if (this.motion.matches && this.presentationMode !== 'preview') {
      this.cancel()
      // Cancelled enters no longer restore from a later completion callback.
      // Remove stale declarations now, preserving independently running leaves.
      this.restore(this.leaveSessions.size > 0)
      this.settle()
    }
  }

  /** Detaches owners before ending sessions so their queued callbacks cannot restore styles again. */
  private cancelEnterSessions(reason: 'superseded' | 'owner-teardown') {
    const sessions = [...this.enterSessions]
    this.enterSessions.clear()

    for (const session of sessions) session.cancel(reason)
  }

  private cancel(cancelEnter = true, preserveControllerSnapshot = false) {
    this.presentationMode = 'live'
    this.clearReferenceFrame()
    if (!preserveControllerSnapshot) {
      for (const controller of this.controllerInstances) controller.setPreview(false)
    }
    this.propertyMotion.reset()
    this.dirtyProperties.clear()
    if (cancelEnter) this.cancelEnterSessions('superseded')

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
  settle(receivingElement?: HTMLElement) {
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

    const next = new Map<string, TargetElements>()

    for (const [name, element] of entries) {
      const elements = next.get(name)

      if (elements) {
        elements.push(element)
      } else {
        next.set(name, [element])
      }
    }

    const duplicate = next.size !== entries.length && !hasLifecycle(this.definition)
    const status = this.resolveBindingStatus(this.definition, next, duplicate)
    const unchanged =
      status === 'ready' &&
      !this.suspended &&
      entries.length === [...this.targetElements.values()].flat().length &&
      entries.every(([key, value]) => this.targetElements.get(key)?.includes(value))

    if (unchanged) return

    this.endCompositionPreview()
    this.environment.invalidateBinding()

    const previousInputs = JSON.stringify(this.values)

    this.releaseControllers()
    this.environment.clearBindings()
    this.propertyMotion.reset()
    this.dirtyProperties.clear()
    this.cancel(false)
    this.restore(this.enterSessions.size > 0)
    this.targetElements = next
    this.bindingStatus = status

    this.environment.rebound(previousInputs !== JSON.stringify(this.values))

    if (this.suspended) {
      this.report({
        code: 'runtime.targets',
        message: status === 'duplicate' ? 'Duplicate target binding' : 'Missing target binding',
      })
    } else {
      this.settle()
    }
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
      this.presentationMode = 'preparing-preview'

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
      this.presentationMode = 'preview'

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
    if (this.presentationMode === 'live') return

    this.cancel()
    this.restore()
    this.settle()
  }

  /** Prepare scrub-ready lifecycle effects without invoking presence removal callbacks. */
  previewLifecycle(
    phase: 'enter' | 'leave',
    composition = this.layerResolution.composition,
    definition = this.definition,
  ): void {
    this.prepareCompositionPreview(composition, composition, [], definition, phase)
  }

  applyLayerResolution(previous: LayerResolution, next: LayerResolution) {
    this.applyLayerChange(previous, next, new Set())
  }

  private applyLayerChange(
    previous: LayerResolution,
    next: LayerResolution,
    retargets: ReadonlySet<string>,
  ) {
    const prepared: ActiveTrack[] = []
    const preparation = prepareLayerChange({
      previous,
      next,
      values: this.values,
      active: this.active.map((entry) => ({ track: entry.track })),
      retargets,
    })
    const affectedTargets = new Set(preparation.templates.map((track) => track.target))

    for (const target of next.presentation.targets) {
      if (
        target.properties.some((property) =>
          preparation.changed.has(layerPropertyKey(target.name, property.name)),
        )
      )
        affectedTargets.add(target.name)
    }

    // Candidate selection needs no DOM. Read only the selected endpoints after
    // terminal writes/releases, and share each target's computed-style observation.
    const displayed = new Map<string, string>()

    for (const target of next.presentation.targets) {
      const implicit = preparation.templates.filter(
        (track) => track.target === target.name && track.implicitStart,
      )

      if (implicit.length === 0) continue

      const element = this.targetElements.get(target.name)?.at(-1)
      const style = element ? getComputedStyle(element) : undefined

      for (const track of implicit)
        displayed.set(
          layerPropertyKey(track.target, track.property),
          style ? style.getPropertyValue(track.property) : '',
        )
    }

    const receivers = [...this.targetElements]
      .filter(([target]) => affectedTargets.has(target))
      .flatMap(([target, elements]) =>
        elements.map((element) => ({
          element,
          target,
          addresses: this.declarationAddresses(next, element, target),
        })),
      )
    const plan = planLayerChange(
      preparation,
      displayed,
      receivers.map(({ target, addresses }) => ({ target, addresses })),
    )
    const { changed, removedProperties, tracks } = plan
    const removed = removedProperties.size > 0

    for (const message of plan.diagnostics) this.report({ code: 'runtime.endpoint', message })

    try {
      if (!this.suspended && !this.motion.matches) {
        for (const sourceTrack of tracks) {
          changed.add(layerPropertyKey(sourceTrack.target, sourceTrack.property))
          const timing =
            sourceTrack.timing.kind === 'tween'
              ? { durationMs: sourceTrack.timing.durationMs, easing: 'linear' }
              : sampleSpring(sourceTrack.timing)

          if (timing.durationMs === 0) continue

          for (const receiver of receivers.filter((item) => item.target === sourceTrack.target)) {
            const { element, addresses } = receiver

            for (const track of canonicalTracks(element, sourceTrack)) {
              if (!ownsCanonicalProperty(addresses, sourceTrack.property, track.property)) continue
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

    const replacementIds = new Set(
      replacedEffects(
        this.active.map((entry, id) => ({
          id,
          target: entry.track.target,
          sourceProperty: entry.sourceProperty,
          property: entry.track.property,
        })),
        changed,
        removedProperties,
      ),
    )
    const replaced = this.active.filter((_entry, id) => replacementIds.has(id))
    this.active = this.active.filter((entry) => !replaced.includes(entry))

    for (const entry of replaced) entry.animation.cancel()

    this.layerResolution = next
    this.environment.acceptPresentation(next)

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

  dispose() {
    this.releaseControllers()
    this.leaveSessions.clear()

    this.cancelEnterSessions('owner-teardown')
    this.disconnectBindings()
    this.propertyMotion.reset()
    this.dirtyProperties.clear()
    this.cancel()
    this.restore()
    this.motion.removeEventListener('change', this.motionChanged)
    this.targetElements.clear()
    this.disposed = true
  }
}
