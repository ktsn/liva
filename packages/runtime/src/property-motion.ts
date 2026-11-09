import { waapiProperty } from './animation.ts'
import type { Timing } from './definition.ts'
import { springParameters, SPRING_MAX_SECONDS, SPRING_MAX_SAMPLES } from './spring.ts'
import {
  decodeDestination,
  decodeProperty,
  propertyReference,
  type NumericProperty,
} from './property-codec.ts'

export const DIRECT_SAMPLE_WINDOW_MS = 80

type SpringTiming = Exclude<Timing, { kind: 'tween' }>
export type MotionSample = {
  readonly value: readonly number[]
  readonly velocity: readonly number[]
}
type Sample = { time: number; value: number }
type PropertyHistory = {
  samples: Sample[]
  animation?: Animation
  trajectory?: (milliseconds: number) => number
}

function oscillator(
  start: number,
  end: number,
  initialVelocity: number,
  stiffness: number,
  damping: number,
  mass: number,
  seconds: number,
) {
  const omega = Math.sqrt(stiffness / mass)
  const decay = damping / (2 * mass)
  const delta = omega * omega - decay * decay
  const displacement = start - end
  const incoming = initialVelocity * 1000
  let value: number
  let velocity: number

  if (Math.abs(delta) < omega * omega * 1e-8) {
    const coefficient = incoming + decay * displacement
    const exponential = Math.exp(-decay * seconds)
    value = (displacement + coefficient * seconds) * exponential
    velocity = (coefficient - decay * (displacement + coefficient * seconds)) * exponential
  } else if (delta > 0) {
    const frequency = Math.sqrt(delta)
    const coefficient = (incoming + decay * displacement) / frequency
    const exponential = Math.exp(-decay * seconds)
    const cosine = Math.cos(frequency * seconds)
    const sine = Math.sin(frequency * seconds)
    const basis = displacement * cosine + coefficient * sine
    value = exponential * basis
    velocity =
      exponential *
      (-decay * basis - displacement * frequency * sine + coefficient * frequency * cosine)
  } else {
    const root = Math.sqrt(-delta)
    const slow = (-omega * omega) / (decay + root)
    const fast = -decay - root
    const a = (incoming - fast * displacement) / (slow - fast)
    const b = displacement - a
    value = a * Math.exp(slow * seconds) + b * Math.exp(fast * seconds)
    velocity = a * slow * Math.exp(slow * seconds) + b * fast * Math.exp(fast * seconds)
  }

  return { value: end + value, velocity: velocity / 1000 }
}

export function springMotion(
  timing: SpringTiming,
  start: readonly number[],
  end: readonly number[],
  velocity: readonly number[],
) {
  const parameters = springParameters(timing)
  let { stiffness, damping } = parameters
  const { mass } = parameters
  const amplitude = start.map((value, index) => Math.max(1, Math.abs(value - end[index])))

  const sample = (milliseconds: number): MotionSample => {
    const components = start.map((value, index) =>
      oscillator(value, end[index], velocity[index], stiffness, damping, mass, milliseconds / 1000),
    )

    return {
      value: components.map((component) => component.value),
      velocity: components.map((component) => component.velocity),
    }
  }
  const settled = (at: number) => {
    const current = sample(at)

    return current.value.every(
      (value, index) =>
        Math.abs(value - end[index]) < amplitude[index] * 0.00025 &&
        Math.abs(current.velocity[index]) < amplitude[index] * 0.000001,
    )
  }

  let durationMs = parameters.durationMs

  if (timing.kind === 'spring-duration') {
    // Preserve incoming units/time; increase natural frequency until duration is a settling target.
    for (
      let attempt = 0;
      attempt < 32 && (!settled(durationMs) || !settled(durationMs * 0.95));
      attempt++
    ) {
      stiffness *= 1.21
      damping *= 1.1
    }

    if (!settled(durationMs)) throw new Error('Spring cannot settle within the requested duration')
  } else {
    while (!settled(durationMs) || !settled(Math.max(0, durationMs - 64))) {
      durationMs += 16
      if (durationMs > SPRING_MAX_SECONDS * 1000)
        throw new Error('Spring did not converge before duration cap')
    }
  }

  const count = Math.max(32, Math.ceil((durationMs / 1000) * Math.sqrt(stiffness / mass) * 10))
  if (count > SPRING_MAX_SAMPLES) throw new Error('Spring exceeds property sample cap')
  const samples = Array.from({ length: count + 1 }, (_, index) => {
    const time = (durationMs * index) / count

    return { time: index / count, value: index === count ? end : sample(time).value }
  })

  return { durationMs, samples, sample }
}

/** A Motion owns its histories, so target replacement/disposal never reuses an old session. */
export class PropertyMotion {
  private histories = new WeakMap<HTMLElement, Map<string, PropertyHistory>>()

  reset() {
    this.histories = new WeakMap()
  }

  private history(element: HTMLElement, address: string): PropertyHistory {
    let properties = this.histories.get(element)

    if (!properties) {
      properties = new Map()
      this.histories.set(element, properties)
    }

    let history = properties.get(address)

    if (!history) {
      history = { samples: [] }
      properties.set(address, history)
    }

    return history
  }

  observe(element: HTMLElement, property: string, time: number) {
    const decoded = decodeProperty(element, property)
    if (!decoded) return
    const protectedAddresses = new Set(
      decoded.addresses.filter((address) => {
        const animation = this.history(element, address).animation

        return animation && animation.playState !== 'idle' && animation.playState !== 'finished'
      }),
    )

    this.recordValues(element, decoded, decoded.values, time, protectedAddresses)
  }

  beginControl(element: HTMLElement, property: string, time: number) {
    const decoded = decodeProperty(element, property)
    if (!decoded) return

    for (const [index, address] of decoded.addresses.entries()) {
      const history = this.history(element, address)
      history.samples = [{ time, value: decoded.values[index] }]
      history.animation = undefined
      history.trajectory = undefined
    }
  }

  record(
    element: HTMLElement,
    property: string,
    time = performance.now(),
    protectedAddresses: ReadonlySet<string> = new Set(),
  ) {
    const decoded = decodeProperty(element, property)
    if (!decoded) return

    this.recordValues(element, decoded, decoded.values, time, protectedAddresses)
  }

  recordValues(
    element: HTMLElement,
    decoded: NumericProperty,
    values: readonly number[],
    time: number,
    protectedAddresses: ReadonlySet<string> = new Set(),
  ) {
    for (const [index, address] of decoded.addresses.entries()) {
      if (protectedAddresses.has(address)) continue
      const history = this.history(element, address)
      history.animation = undefined
      history.trajectory = undefined
      const samples = history.samples
      const last = samples.at(-1)
      const value = values[index]

      // A hold expires movement history; subsequent motion starts from a recent rest sample.
      if (last?.value === value) {
        if (time - last.time >= DIRECT_SAMPLE_WINDOW_MS) history.samples = [{ time, value }]
        continue
      }

      if (last && time - last.time >= DIRECT_SAMPLE_WINDOW_MS) samples.length = 0
      if (last?.time === time) samples.pop()
      samples.push({ time, value })
      while (samples.length > 2 && samples[1].time < time - DIRECT_SAMPLE_WINDOW_MS) samples.shift()
    }
  }

  read(element: HTMLElement, property: string, time = performance.now()): MotionSample | undefined {
    const decoded = decodeProperty(element, property)
    if (!decoded) return undefined

    const velocity = decoded.addresses.map((address) => {
      const history = this.history(element, address)
      const animation = history.animation

      if (animation && (animation.playState === 'idle' || animation.playState === 'finished'))
        return 0

      if (animation) {
        const at = Number(animation.currentTime)
        if (history.trajectory) return history.trajectory(at) * animation.playbackRate

        return this.nativeVelocity(element, property, decoded, animation)[
          decoded.addresses.indexOf(address)
        ]
      }

      const last = history.samples.at(-1)
      const before = history.samples.at(-2)
      if (
        !last ||
        !before ||
        time - last.time >= DIRECT_SAMPLE_WINDOW_MS ||
        last.time <= before.time
      )
        return 0

      return (last.value - before.value) / (last.time - before.time)
    })

    return { value: decoded.values, velocity }
  }

  predict(
    element: HTMLElement,
    property: string,
    values: readonly number[],
    time: number,
  ): MotionSample | undefined {
    const decoded = decodeProperty(element, property)
    if (!decoded) return undefined
    const velocity = decoded.addresses.map((address, index) => {
      const history = this.history(element, address)
      const last = history.samples.at(-1)
      const before = history.samples.at(-2)

      if (!last) return 0
      if (values[index] !== last.value)
        return time - last.time < DIRECT_SAMPLE_WINDOW_MS && time > last.time
          ? (values[index] - last.value) / (time - last.time)
          : 0
      if (!before || time - last.time >= DIRECT_SAMPLE_WINDOW_MS || last.time <= before.time)
        return 0

      return (last.value - before.value) / (last.time - before.time)
    })

    return { value: values, velocity }
  }

  private nativeVelocity(
    element: HTMLElement,
    property: string,
    decoded: NumericProperty,
    animation: Animation,
  ): readonly number[] {
    const at = Number(animation.currentTime)
    // Registered effects use document.timeline, whose computed endTime is numeric.
    const duration = Number(animation.effect?.getComputedTiming().endTime)
    const left = Math.max(0, at - 0.5)
    const right = Math.min(duration, at + 0.5)
    if (right <= left) return decoded.values.map(() => 0)
    const running = animation.playState === 'running'

    try {
      animation.pause()
      animation.currentTime = left
      const before = decodeProperty(element, property)
      animation.currentTime = right
      const after = decodeProperty(element, property)
      /* v8 ignore if -- @preserve: These synchronous samples interpolate within the already-decoded numeric CSS space; no DOM mutation can intervene. */
      if (!before || !after) return decoded.values.map(() => 0)

      return before.values.map(
        (value, index) => ((after.values[index] - value) / (right - left)) * animation.playbackRate,
      )
    } finally {
      animation.currentTime = at
      if (running) animation.play()
    }
  }

  register(
    element: HTMLElement,
    property: string,
    animation: Animation,
    trajectory?: (milliseconds: number) => MotionSample,
  ) {
    const decoded = decodeProperty(element, property)
    if (!decoded) return

    for (const [component, address] of decoded.addresses.entries()) {
      const history = this.history(element, address)
      history.animation = animation
      history.trajectory =
        trajectory && ((milliseconds) => trajectory(milliseconds).velocity[component])
    }
  }

  prepareSpring(
    element: HTMLElement,
    property: string,
    destination: string,
    timing: SpringTiming,
    endpointOnly: boolean,
  ) {
    if (!endpointOnly) return undefined
    const start = this.read(element, property)
    const end = decodeDestination(element, property, destination)
    if (
      !start ||
      !end ||
      start.value.length !== end.values.length ||
      (property !== 'opacity' &&
        start.velocity.every((value) => value === 0) &&
        propertyReference(element, property, destination) === undefined)
    )
      return undefined

    const motion = springMotion(timing, start.value, end.values, start.velocity)

    return {
      ...motion,
      frames: motion.samples.map(({ time, value }) => ({
        [waapiProperty(property)]: end.serialize(value, true),
        offset: time,
        easing: 'linear',
      })),
    }
  }
}
