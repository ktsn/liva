import type { RuntimeValue } from '../evaluation/reactive-value.ts'
import type { MotionHistory } from './motion-history.ts'

/**
 * One receiving target/property and its owner's motion history/diagnostic channel.
 * The owner validates adapter/property compatibility before configuration and uses
 * the same performance.now()-compatible millisecond clock for acquisition and writes.
 */
export interface ControllerAddress {
  readonly target: string
  readonly property: string
  readonly motion: MotionHistory
  readonly report: (message: string) => void
}

/**
 * Capability behind readable controller snapshots; copying a record does not copy
 * ownership. Configure one address before binding its reactive call, then acquire
 * when it becomes the effective owner. The host applies control() writes and records
 * them through the configured MotionHistory, releasing when ownership ends.
 * Receiving-element cleanup belongs to the ReactiveCall's bind/dispose API.
 */
export interface PropertyController {
  /** Assigns the receiving address; a different target/property after configuration throws. */
  configure(address: ControllerAddress): void

  /** Captures a readable displayed origin at time in milliseconds; repeated acquisition is inert. */
  acquire(time: number): void

  /** Ends direct ownership and hands fresh input velocity to motion history at time in ms. */
  release(time?: number): void

  /** Toggles on-demand snapshot freezing for manual preview. */
  setPreview(active: boolean): void

  /** Formats an attached compatible preview snapshot, or undefined for fallback observations. */
  render(property: string, snapshot: RuntimeValue): string | undefined

  /** Proposes a write while control is active/readable; the host owns applying and recording it. */
  control():
    | { readonly element: HTMLElement; readonly property: string; readonly value: string }
    | undefined
}

const controllers = new WeakMap<object, PropertyController>()

/**
 * Associates a readable record with a controller without exposing the capability
 * in its fields. Returns the same record; its producer owns immutability. Scalar
 * observations throw because they cannot carry this record-based capability.
 */
export function controllerSnapshot(
  controller: PropertyController,
  value: RuntimeValue,
): RuntimeValue {
  if (typeof value !== 'object')
    throw new Error('Controller snapshots must expose readable records')

  controllers.set(value, controller)

  return value
}

/** Returns a registered snapshot's capability; ordinary, copied, or forged values throw. */
export function propertyController(value: RuntimeValue): PropertyController {
  const controller = typeof value === 'object' ? controllers.get(value) : undefined
  if (!controller) throw new Error('Property attachment requires a controller capability')

  return controller
}
