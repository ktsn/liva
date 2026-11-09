import type { RuntimeValue } from './reactive-value.ts'
import type { PropertyMotion } from './property-motion.ts'

export interface ControllerAddress {
  readonly target: string
  readonly property: string
  readonly motion: PropertyMotion
  readonly report: (message: string) => void
}

export interface PropertyController {
  configure(address: ControllerAddress): void
  acquire(time: number): void
  release(): void
  setPreview(active: boolean): void
  render(property: string, snapshot: RuntimeValue): string | undefined
  control():
    | { readonly element: HTMLElement; readonly property: string; readonly value: string }
    | undefined
}

const controllers = new WeakMap<object, PropertyController>()

export function controllerSnapshot(
  controller: PropertyController,
  value: RuntimeValue,
): RuntimeValue {
  if (typeof value !== 'object')
    throw new Error('Controller snapshots must expose readable records')
  controllers.set(value, controller)

  return value
}

export function propertyController(value: RuntimeValue): PropertyController {
  const controller = typeof value === 'object' ? controllers.get(value) : undefined
  if (!controller) throw new Error('Property attachment requires a controller capability')

  return controller
}
