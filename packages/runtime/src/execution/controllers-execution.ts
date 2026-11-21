import type { ControllerBinding } from './controller-planning.ts'
import { layerPropertyKey } from '../model/presentation.ts'
import type { ReceiverAddresses } from './presentation-planner.ts'
import { propertyAddresses } from '../motion/property-codec.ts'
import { propertyController, type PropertyController } from '../motion/controllers.ts'
import { layerTargets, type LayerResolution } from '../composition/layers.ts'
import { evaluate, type VariableValues } from '../evaluation/expression.ts'
import type { Definition } from '../model/definition.ts'
import type { BrowserExecutor } from './browser-executor.ts'
/** Configured instances remain registered while another controller/declaration owns their address. */
export type ControllerState = {
  /** Logical target/property identity used to compare selected owners. */
  readonly key: string

  /** Selected for live control, including controllers currently using an unreadable-value fallback. */
  active: boolean
}

export class ControllersExecution {
  private readonly host: Pick<
    BrowserExecutor,
    | 'write'
    | 'propertyMotion'
    | 'report'
    | 'presentationFacts'
    | 'presenceLayers'
    | 'values'
    | 'enterExclusions'
    | 'layerResolution'
    | 'receiver'
    | 'project'
  >

  constructor(
    host: Pick<
      BrowserExecutor,
      | 'write'
      | 'propertyMotion'
      | 'report'
      | 'presentationFacts'
      | 'presenceLayers'
      | 'values'
      | 'enterExclusions'
      | 'layerResolution'
      | 'receiver'
      | 'project'
    >,
  ) {
    this.host = host
  }

  private readonly controllers = new Map<PropertyController, ControllerState>()

  clear() {
    this.controllers.clear()
  }

  setPreview(enabled: boolean) {
    for (const controller of this.controllers.keys()) controller.setPreview(enabled)
  }

  terminalControls() {
    const controlled = [...this.controllers]
      .filter(([, state]) => state.active)
      .map(([controller]) => controller.control())

    for (const value of controlled) {
      if (value) this.host.write(value.element, value.property, value.value)
    }
  }

  configureControllers(definition: Definition, values: VariableValues) {
    this.controllers.clear()

    for (const target of layerTargets(definition)) {
      for (const property of target.properties) {
        if (property.value.kind !== 'binding') continue

        const controller = propertyController(evaluate(property.value.expression, values))
        this.controllers.set(controller, {
          key: layerPropertyKey(target.name, property.name),
          active: false,
        })
        controller.configure({
          target: target.name,
          property: property.name,
          motion: this.host.propertyMotion,
          report: (message) => this.host.report({ code: 'runtime.controller', message }),
        })
      }
    }
  }

  optionalControllerTargets(definition: Definition): ReadonlySet<string> {
    return new Set(
      layerTargets(definition)
        .filter((target) => target.properties.some((property) => property.value.kind === 'binding'))
        .map((target) => target.name),
    )
  }

  releaseControllers(time = performance.now()) {
    for (const [controller, state] of this.controllers) {
      if (!state.active) continue

      controller.release(time)
      state.active = false
    }
  }

  observeReceivers(
    resolution: LayerResolution,
    targets: ReadonlySet<string>,
    live: boolean,
  ): readonly ReceiverAddresses[] {
    const receivers = this.host.presentationFacts().receivers
    const presence = live
      ? this.host.presenceLayers(
          resolution,
          this.host.values,
          this.host.enterExclusions(this.host.layerResolution, resolution),
        )
      : []

    return resolution.presentation.targets
      .filter((target) => targets.has(target.name))
      .flatMap((target) => {
        return receivers
          .filter((receiver) => receiver.target === target.name)
          .map((receiver) => {
            const element = this.host.receiver(receiver.id).element
            // Composing scoped overrides retains every ordinary target/name.
            const properties = this.host
              .project(resolution, receiver.id, presence)
              .presentation.targets.find((item) => item.name === target.name)!.properties

            const addresses = properties.map(({ name }) => ({
              name,
              addresses: propertyAddresses(element, name),
            }))
            const scoped = new Set(
              properties
                .filter((property) => property.sourceProperty !== undefined)
                .map((property) => property.name),
            )
            const fallbacks = target.properties
              .filter(
                (property) =>
                  property.binding &&
                  addresses.some(
                    (declaration) =>
                      scoped.has(declaration.name) &&
                      declaration.addresses.some((address) =>
                        addresses
                          .find((candidate) => candidate.name === property.name)
                          ?.addresses.includes(address),
                      ),
                  ),
              )
              .map((property) => property.name)

            return {
              ...receiver,
              bindings: properties
                .filter((property) => property.binding)
                .map((property) => property.name),
              fallbacks,
              addresses,
            }
          })
      })
  }

  /** Runtime passes only selected bindings; capability objects remain within existing controller APIs. */
  applyControllers(
    bindings: readonly ControllerBinding[],
    values: VariableValues,
    time: number,
    live: boolean,
  ): ReadonlyMap<string, string | undefined> {
    const nextOwners = new Map<string, PropertyController>()
    const outputs = new Map<string, string | undefined>()

    for (const binding of bindings) {
      const snapshot = evaluate(binding.expression, values)
      const controller = propertyController(snapshot)
      const key = layerPropertyKey(binding.target, binding.property)
      nextOwners.set(key, controller)

      if (live) controller.acquire(time)

      outputs.set(
        key,
        live ? controller.control()?.value : controller.render(binding.property, snapshot),
      )
    }

    if (live) {
      for (const [controller, state] of this.controllers) {
        const selected = nextOwners.get(state.key) === controller

        if (state.active && !selected) controller.release(time)

        state.active = selected
      }
    }

    return outputs
  }
}
