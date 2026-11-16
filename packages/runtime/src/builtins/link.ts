import type {
  FunctionArguments,
  PreparedUpdate,
  ReactiveCall,
  RuntimeValue,
} from '../evaluation/reactive-value.ts'
import {
  controllerSnapshot,
  type ControllerAddress,
  type PropertyController,
} from '../motion/controllers.ts'
import { decodeProperty, encodeProperty } from '../motion/property-codec.ts'
import { DIRECT_SAMPLE_WINDOW_MS } from '../motion/property-motion.ts'

/** Validated input mapping; scalar/vector shape and selected component stay fixed per call. */
type Configuration = {
  readonly input: readonly number[]
  readonly sensitivity: number
  readonly component?: 'x' | 'y'
  readonly vector: boolean
}

/** Displayed origin and raw input captured when relative control starts or sensitivity rebases. */
type Session = { readonly origin: readonly number[]; readonly input: readonly number[] }

/** One mapped input component sampled on the performance.now() millisecond clock. */
type Sample = { readonly value: number; readonly time: number }

/** Bounded per-component movement history; unchanged axes retain their own sampling times. */
type History = { readonly last: Sample; readonly previous?: Sample }

/** Reads a finite scalar or exact X/Y input record; invalid shapes and options throw. */
function configuration(args: FunctionArguments): Configuration {
  const sensitivity = args.sensitivity ?? 1
  const component = args.component

  if (typeof sensitivity !== 'number' || !Number.isFinite(sensitivity))
    throw new Error('link sensitivity must be finite')
  if (component !== undefined && component !== 'x' && component !== 'y')
    throw new Error('link component must be x or y')

  const input = args.input
  let values: number[]
  let vector = component !== undefined

  if (typeof input === 'number') {
    values = [input]
  } else if (
    typeof input === 'object' &&
    typeof input.x === 'number' &&
    typeof input.y === 'number' &&
    Object.keys(input).length === 2 &&
    component === undefined
  ) {
    values = [input.x, input.y]
    vector = true
  } else {
    throw new Error('link input must be a number or an X/Y numeric record')
  }

  if (!values.every(Number.isFinite)) throw new Error('link input must be finite')

  return { input: values, sensitivity, component, vector }
}

/** Applies sensitivity and axis selection, retaining zero unmapped axes and rejecting overflow. */
function mapped(config: Configuration, sensitivity = config.sensitivity): readonly number[] {
  const result =
    config.component === 'x'
      ? [config.input[0] * sensitivity, 0, 0]
      : config.component === 'y'
        ? [0, config.input[0] * sensitivity, 0]
        : config.vector
          ? [config.input[0] * sensitivity, config.input[1] * sensitivity, 0]
          : [config.input[0] * sensitivity]

  if (!result.every(Number.isFinite)) throw new Error('link mapped input must be finite')

  return result.map((value) => (value === 0 ? 0 : value))
}

/** Exposes canonical scalar values or an immutable X/Y/Z record in component order. */
function readable(values: readonly number[], vector: boolean): RuntimeValue {
  return vector ? Object.freeze({ x: values[0], y: values[1], z: values[2] }) : values[0]
}

/**
 * Owns one link call's mapping, relative-control session, and committed input history.
 * Velocity is derived from input updates, never from frame polling or other owners'
 * animations. Displayed positions are read on demand. Prepared updates leave live
 * state intact until accepted. The receiving owner applies proposed CSS writes;
 * release transfers input velocity to PropertyMotion for the next spring.
 */
class Link implements ReactiveCall, PropertyController {
  private current: Configuration
  private address?: ControllerAddress
  private element?: HTMLElement
  private session?: Session
  private preview = false
  private published: RuntimeValue
  private history: readonly History[]
  private cleanup?: () => void
  private readonly warnings = new Set<string>()

  /** Creates an unbound mapped-input observation; invalid or overflowing inputs throw. */
  constructor(args: FunctionArguments) {
    this.current = configuration(args)
    this.history = this.restHistory(performance.now())
    this.published = this.capture(this.current, performance.now())
  }

  /** Last published immutable observation, carrying this call's controller capability. */
  get value(): RuntimeValue {
    return this.published
  }

  /** Assigns one receiving address; repeated configuration may refresh its motion/report owner. */
  configure(address: ControllerAddress) {
    if (
      this.address &&
      (this.address.target !== address.target || this.address.property !== address.property)
    ) {
      throw new Error('A controller may attach to exactly one target/property address')
    }

    this.address = address
  }

  /** Reads the receiving property's canonical components, or undefined while unreadable/unbound. */
  private actual() {
    const element = this.element
    const address = this.address
    if (!element || !address) return undefined

    const decoded = decodeProperty(element, address.property)

    return decoded
  }

  /** Reports a visible undecodable property once; missing or non-rendered targets are normal. */
  private diagnose() {
    const element = this.element
    const address = this.address
    if (
      !element ||
      !address ||
      decodeProperty(element, address.property) ||
      !element.isConnected ||
      element.getClientRects().length === 0
    )
      return

    const message = `Cannot observe controller property: ${address.target}.${address.property}`

    if (!this.warnings.has(message)) {
      this.warnings.add(message)
      address.report(message)
    }
  }

  /** Projects input deltas from a captured origin, preserving unselected physical axes. */
  private projection(config: Configuration, session = this.session): readonly number[] | undefined {
    if (!session) return undefined

    const input = mapped(config, 1)
    const baseline = mapped({ ...config, input: session.input }, 1)
    const indices = config.component
      ? [config.component === 'x' ? 0 : 1]
      : config.vector
        ? [0, 1]
        : [0]

    return session.origin.map((value, index) =>
      indices.includes(index)
        ? value + (input[index] - baseline[index]) * config.sensitivity
        : value,
    )
  }

  /** Starts each input component at rest without carrying movement across control sessions. */
  private restHistory(time: number): readonly History[] {
    return mapped(this.current).map((value) => ({ last: { value, time } }))
  }

  /** Estimates mapped-input units/ms from fresh history; acquisition/configuration resets start at rest. */
  private inputVelocity(value: readonly number[], time: number, reset: boolean): readonly number[] {
    if (reset) return value.map(() => 0)

    // Each axis derives from its own last change.
    // A movement on Y must not shorten X's sampling interval or expire its hold.
    return value.map((entry, index) => {
      const { last, previous } = this.history[index]

      if (entry !== last.value)
        return time - last.time < DIRECT_SAMPLE_WINDOW_MS && time > last.time
          ? (entry - last.value) / (time - last.time)
          : 0
      if (!previous || time - last.time >= DIRECT_SAMPLE_WINDOW_MS || last.time <= previous.time)
        return 0

      return (entry - previous.value) / (last.time - previous.time)
    })
  }

  /**
   * Builds an immutable candidate observation without accepting configuration or
   * session changes. Attached positions use CSS px/deg; unreadable targets expose
   * mapped input. Velocity always uses mapped input units per millisecond, with
   * unmapped axes at rest, regardless of the currently displayed animation.
   */
  private capture(
    config: Configuration,
    time: number,
    session = this.session,
    projectInput = false,
  ): RuntimeValue {
    const actual = this.actual()
    const projected = actual && projectInput ? this.projection(config, session) : undefined
    const velocity = this.inputVelocity(
      mapped(config),
      time,
      config.sensitivity !== this.current.sensitivity,
    )
    const values = projected ?? actual?.values ?? mapped(config)

    return controllerSnapshot(
      this,
      Object.freeze({
        value: readable(values, config.vector),
        velocity: readable(velocity, config.vector),
        attached: actual !== undefined,
      }),
    )
  }

  /** Reads at the supplied millisecond timestamp, or returns the published record during preview. */
  readSnapshot(context: { readonly time: number }): RuntimeValue {
    return this.preview ? this.published : this.capture(this.current, context.time)
  }

  /**
   * Prepares a candidate snapshot on the observation clock. Invalid input, shape
   * changes, or invalid projected CSS throw before live state changes. Commit accepts
   * the mapping/session/history together; discard leaves the active pose untouched.
   */
  prepareUpdate(args: FunctionArguments, context = { time: performance.now() }): PreparedUpdate {
    const next = configuration(args)
    if (next.component !== this.current.component || next.vector !== this.current.vector)
      throw new Error('link component and input shape are fixed')

    const actual = this.actual()
    const session =
      this.session && next.sensitivity !== this.current.sensitivity && actual
        ? { origin: actual.values, input: next.input }
        : this.session
    const projected = actual ? this.projection(next, session) : undefined

    if (
      projected &&
      (!projected.every(Number.isFinite) ||
        (this.address && !CSS.supports(this.address.property, actual!.serialize(projected))))
    ) {
      throw new Error('link input produces an invalid property value')
    }

    const value = this.capture(next, context.time, session, true)

    return {
      value,
      commit: () => {
        const nextMapped = mapped(next)
        const sensitivityChanged = next.sensitivity !== this.current.sensitivity

        // A sensitivity change rebases velocity even if the new raw input happens
        // to produce the same mapped value; that equality must not retain old motion.
        this.history = nextMapped.map((entry, index) => {
          const history = this.history[index]
          const expired = context.time - history.last.time >= DIRECT_SAMPLE_WINDOW_MS

          if (!sensitivityChanged && entry === history.last.value && !expired) return history

          // Like direct DOM observations, an expired committed hold establishes
          // a recent rest baseline so the first resumed movement can carry velocity.
          return {
            last: { value: entry, time: context.time },
            previous: sensitivityChanged || expired ? undefined : history.last,
          }
        })

        this.current = next
        // An unreadable target ends the old relative session only on acceptance.
        // A discarded preparation must not lose the origin of live control.
        this.session = typeof value === 'object' && value.attached === true ? session : undefined
        this.published = value
      },
      discard() {},
    }
  }

  /** Captures the displayed origin/input once per session; unreadable targets remain uncontrolled. */
  acquire(time: number) {
    if (this.session) return

    const actual = this.actual()
    if (!actual || !this.element || !this.address) return

    this.session = { origin: actual.values, input: this.current.input }
    this.history = this.restHistory(time)
    this.address.motion.beginControl(this.element, this.address.property, time)
  }

  /** Ends control, transferring fresh mapped-input velocity at the supplied millisecond time. */
  release(time = performance.now()) {
    if (this.session && this.element && this.address) {
      this.address.motion.endControl(
        this.element,
        this.address.property,
        this.inputVelocity(mapped(this.current), time, false),
        time,
        this.history.map((history) => history.last.time),
      )
    }

    this.session = undefined
  }

  /** Freezes on-demand snapshots during manual preview without advancing input history. */
  setPreview(active: boolean) {
    if (active === this.preview) return

    const time = performance.now()

    if (active) this.published = this.capture(this.current, time)

    this.preview = active
  }

  /**
   * Serializes an attached preview snapshot for a validated compatible scalar
   * length/rotate or translate-vector property. Fallback/non-record snapshots
   * return undefined, leaving ordinary presentation to the receiving owner.
   */
  render(property: string, snapshot: RuntimeValue): string | undefined {
    if (typeof snapshot !== 'object' || snapshot.attached !== true) return undefined

    const value = snapshot.value

    if (typeof value === 'number') return encodeProperty(property, [value])
    /* v8 ignore else -- @preserve: readable() publishes only numeric scalars or X/Y/Z records; scalar case returned above. */
    if (
      typeof value === 'object' &&
      typeof value.x === 'number' &&
      typeof value.y === 'number' &&
      typeof value.z === 'number'
    ) {
      return encodeProperty(property, [value.x, value.y, value.z])
    } else return undefined
  }

  /** Proposes a CSS write for the active readable session; the caller applies and records it. */
  control() {
    this.diagnose()
    const actual = this.actual()
    const values = actual ? this.projection(this.current) : undefined
    if (!actual) this.session = undefined
    if (!actual || !values || !this.element || !this.address) return undefined
    const value = actual.serialize(values)

    return { element: this.element, property: this.address.property, value }
  }

  /**
   * Binds the receiving element for on-demand reads without scheduling frames or
   * notifications. Cleanup is idempotent and restores mapped fallback observations.
   * Diagnostics may synchronously dispose/rebind; a failed bind releases its own
   * receiver before propagating the error.
   */
  bind(targets: ReadonlyMap<string, HTMLElement>): () => void {
    this.cleanup?.()

    let active = true

    const cleanup = () => {
      if (!active) return

      active = false

      this.element = undefined
      this.session = undefined
      this.history = this.restHistory(performance.now())
      this.published = this.capture(this.current, performance.now())
    }

    // Install cleanup ownership before diagnostics, whose callback may rebind.
    this.cleanup = cleanup

    try {
      this.element = this.address ? targets.get(this.address.target) : undefined
      this.published = this.capture(this.current, performance.now())
      this.diagnose()
    } catch (error) {
      cleanup()
      throw error
    }

    return cleanup
  }

  /** Releases the receiving element once; repeated disposal is harmless. */
  dispose() {
    this.cleanup?.()
  }
}

/**
 * Creates a reactive controller from finite scalar input or an exact {x, y} record.
 * Optional component='x'/'y' selects a translate axis for scalar input; shape/component
 * stay fixed, while finite sensitivity (default 1, including zero/negative values)
 * may change. Snapshots contain immutable value, velocity, and attached fields.
 * Positions sample the receiver on evaluation, or mapped input when unavailable.
 * Velocity comes only from committed input updates, in mapped units per millisecond;
 * samples expire after DIRECT_SAMPLE_WINDOW_MS, including unchanged-input releases.
 * No frames or notifications are scheduled for stationary input or running animations.
 *
 * The caller must pair scalar adapters with numeric dimensions/inset longhands
 * or scalar rotate, and vector/component adapters with translate.
 * Configure before binding, acquire before controlling, then apply and
 * record proposed writes through the address's PropertyMotion on the same clock.
 * Invalid inputs and updates throw; unreadable targets retain mapped fallback values.
 */
export function link(args: FunctionArguments): ReactiveCall {
  return new Link(args)
}
