import type {
  FunctionArguments,
  PreparedUpdate,
  ReactiveCall,
  RuntimeValue,
} from '../reactive-value.ts'
import {
  controllerSnapshot,
  type ControllerAddress,
  type PropertyController,
} from '../controllers.ts'
import { decodeProperty } from '../property-codec.ts'
import { DIRECT_SAMPLE_WINDOW_MS } from '../property-motion.ts'

type Configuration = {
  readonly input: readonly number[]
  readonly sensitivity: number
  readonly component?: 'x' | 'y'
  readonly vector: boolean
}
type Session = { readonly origin: readonly number[]; readonly input: readonly number[] }
type History = { readonly value: readonly number[]; readonly time: number }

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

function readable(values: readonly number[], vector: boolean): RuntimeValue {
  return vector ? Object.freeze({ x: values[0], y: values[1], z: values[2] }) : values[0]
}

function equal(left: RuntimeValue, right: RuntimeValue): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

class Link implements ReactiveCall, PropertyController {
  private current: Configuration
  private address?: ControllerAddress
  private element?: HTMLElement
  private session?: Session
  private preview = false
  private published: RuntimeValue
  private history: History
  private previous?: History
  private cleanup?: () => void
  private readonly warnings = new Set<string>()

  constructor(args: FunctionArguments) {
    this.current = configuration(args)
    this.history = { value: mapped(this.current), time: performance.now() }
    this.published = this.capture(this.current, performance.now())
  }

  get value(): RuntimeValue {
    return this.published
  }

  configure(address: ControllerAddress) {
    if (
      this.address &&
      (this.address.target !== address.target || this.address.property !== address.property)
    ) {
      throw new Error('A controller may attach to exactly one target/property address')
    }

    this.address = address
  }

  private actual() {
    const element = this.element
    const address = this.address
    if (!element || !address) return undefined
    const decoded = decodeProperty(element, address.property)

    return decoded
  }

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

  private fallbackVelocity(
    value: readonly number[],
    time: number,
    reset: boolean,
  ): readonly number[] {
    if (reset) return value.map(() => 0)
    const different = value.some((entry, index) => entry !== this.history.value[index])
    if (different)
      return time - this.history.time < DIRECT_SAMPLE_WINDOW_MS && time > this.history.time
        ? value.map(
            (entry, index) => (entry - this.history.value[index]) / (time - this.history.time),
          )
        : value.map(() => 0)
    if (
      !this.previous ||
      time - this.history.time >= DIRECT_SAMPLE_WINDOW_MS ||
      this.history.time <= this.previous.time
    )
      return value.map(() => 0)
    const before = this.previous

    return value.map(
      (entry, index) => (entry - before.value[index]) / (this.history.time - before.time),
    )
  }

  private capture(
    config: Configuration,
    time: number,
    session = this.session,
    projectInput = false,
  ): RuntimeValue {
    const actual = this.actual()
    const projected = actual && projectInput ? this.projection(config, session) : undefined
    const element = this.element
    const address = this.address
    const wasAttached = typeof this.published === 'object' && this.published.attached === true
    let values = mapped(config)
    let velocity = this.fallbackVelocity(
      values,
      time,
      wasAttached || config.sensitivity !== this.current.sensitivity,
    )
    let attached = false

    if (actual && element && address) {
      const sample = projected
        ? address.motion.predict(element, address.property, projected, time)
        : address.motion.read(element, address.property, time)

      /* v8 ignore else -- @preserve: actual() just decoded this same element/property synchronously, before any DOM write or callback. */
      if (sample) {
        values = sample.value
        velocity = wasAttached ? sample.velocity : sample.velocity.map(() => 0)
        attached = true
      }
    }

    return controllerSnapshot(
      this,
      Object.freeze({
        value: readable(values, config.vector),
        velocity: readable(velocity, config.vector),
        attached,
      }),
    )
  }

  readSnapshot(context: { readonly time: number }): RuntimeValue {
    return this.preview ? this.published : this.capture(this.current, context.time)
  }

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

        if (nextMapped.some((entry, index) => entry !== this.history.value[index])) {
          this.previous =
            next.sensitivity !== this.current.sensitivity ||
            context.time - this.history.time >= DIRECT_SAMPLE_WINDOW_MS
              ? undefined
              : this.history
          this.history = { value: nextMapped, time: context.time }
        }

        this.current = next
        this.session = session
        this.published = value
      },
      discard() {},
    }
  }

  acquire(time: number) {
    if (this.session) return
    const actual = this.actual()
    if (!actual || !this.element || !this.address) return

    this.session = { origin: actual.values, input: this.current.input }
    this.address.motion.beginControl(this.element, this.address.property, time)
  }

  release() {
    this.session = undefined
  }

  setPreview(active: boolean) {
    if (active === this.preview) return

    const time = performance.now()

    if (active) this.published = this.capture(this.current, time)
    else if (this.element && this.address)
      this.address.motion.beginControl(this.element, this.address.property, time)

    this.preview = active
  }

  render(property: string, snapshot: RuntimeValue): string | undefined {
    if (typeof snapshot !== 'object' || snapshot.attached !== true) return undefined
    const value = snapshot.value

    if (typeof value === 'number') return `${value}${property === 'rotate' ? 'deg' : 'px'}`
    /* v8 ignore else -- @preserve: readable() publishes only numeric scalars or X/Y/Z records; scalar case returned above. */
    if (
      typeof value === 'object' &&
      typeof value.x === 'number' &&
      typeof value.y === 'number' &&
      typeof value.z === 'number'
    ) {
      return `${value.x}px ${value.y}px ${value.z}px`
    } else return undefined
  }

  control() {
    this.diagnose()
    const actual = this.actual()
    const values = actual ? this.projection(this.current) : undefined
    if (!actual || !values || !this.element || !this.address) return undefined
    const value = actual.serialize(values)

    return { element: this.element, property: this.address.property, value }
  }

  bind(
    targets: ReadonlyMap<string, HTMLElement>,
    update: (value: RuntimeValue) => void,
  ): () => void {
    this.cleanup?.()
    this.element = this.address ? targets.get(this.address.target) : undefined
    this.published = this.capture(this.current, performance.now())
    this.diagnose()
    let active = true
    let frame: number

    const observe = () => {
      if (this.preview) {
        frame = requestAnimationFrame(observe)
        return
      }

      const time = performance.now()
      if (this.element && this.address)
        this.address.motion.observe(this.element, this.address.property, time)
      const next = this.capture(this.current, time)
      this.diagnose()

      if (!equal(next, this.published)) {
        const previous = this.published
        this.published = next

        if (
          typeof next === 'object' &&
          typeof previous === 'object' &&
          next.attached !== previous.attached
        ) {
          this.previous = undefined
          this.session = undefined
          this.history = { value: mapped(this.current), time }
          /* v8 ignore else -- @preserve: An attached-source switch requires a previously bound receiving element/address; missing targets never become attached. */
          if (this.element && this.address)
            this.address.motion.beginControl(this.element, this.address.property, time)
        }

        update(next)
      }

      frame = requestAnimationFrame(observe)
    }
    frame = requestAnimationFrame(observe)
    const cleanup = () => {
      if (!active) return
      active = false
      cancelAnimationFrame(frame)
      this.element = undefined
      this.session = undefined
      this.previous = undefined
      this.history = { value: mapped(this.current), time: performance.now() }
      this.published = this.capture(this.current, performance.now())
    }
    this.cleanup = cleanup

    return cleanup
  }

  dispose() {
    this.cleanup?.()
  }
}

export function link(args: FunctionArguments): ReactiveCall {
  return new Link(args)
}
