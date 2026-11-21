import {
  decodeDestination,
  decodeProperty,
  propertyReference,
  type NumericProperty,
} from './property-codec.ts'

/** Freshness window for direct-write handoff velocity, in milliseconds. */
export const DIRECT_SAMPLE_WINDOW_MS = 80

/** Canonical component values and matching velocities in component units per millisecond. */
export type MotionSample = {
  readonly value: readonly number[]
  readonly velocity: readonly number[]
}

/** Direct observation on the millisecond clock, optionally carrying released input velocity in units/ms. */
type Sample = { time: number; value: number; velocity?: { value: number; time: number } }

/**
 * Observations for one target/component address. A registered animation takes
 * precedence over direct samples; its optional trajectory supplies analytic velocity
 * at effect-local milliseconds. The animation's creator owns cancellation.
 */
type PropertyHistory = {
  samples: Sample[]
  animation?: Animation
  trajectory?: (milliseconds: number) => number
}

/**
 * Endpoint-only spring observations in canonical component order. Start/end positions
 * use px, degrees, or unitless components; start velocity uses those units per ms.
 * Start value/velocity vectors have matching finite components. Relative dependency
 * is observed only when needed to select numeric handoff for a stationary property.
 */
export interface SpringObservation {
  readonly start?: MotionSample
  readonly end?: readonly number[]
  readonly relative: boolean
}

/**
 * Tracks displayed values and handoff velocity for one Motion instance, keyed by
 * element and canonical component address so CSS aliases share observations.
 * Direct observations use performance.now()-compatible milliseconds; decoded values
 * use canonical units and velocities use those units per millisecond. Unreadable or
 * unsupported properties cannot supply samples or prepared springs.
 * Animation creation/cancellation remains the caller's responsibility.
 */
export class MotionHistory {
  private histories = new WeakMap<HTMLElement, Map<string, PropertyHistory>>()

  /** Forgets all target histories and animation references without cancelling their effects. */
  reset() {
    this.histories = new WeakMap()
  }

  /** Returns this instance's component history, creating an empty entry on first access. */
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

  /**
   * Starts a direct-control session from the current displayed value at time.
   * Replaces prior velocity history and effect references; unreadable values are ignored.
   */
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

  /**
   * Ends direct control with a committed input derivative in canonical units/ms,
   * ordered like the property's decoded components. Captures the displayed start
   * position at time; unreadable targets are ignored. Optional velocityTimes retain
   * each input component's original sampling time, so delayed playback does not
   * restart its freshness window at release. The supplied velocity takes
   * precedence over DOM finite differences until stale or superseded by a write/effect.
   */
  endControl(
    element: HTMLElement,
    property: string,
    velocity: readonly number[],
    time: number,
    velocityTimes?: readonly number[],
  ) {
    const decoded = decodeProperty(element, property)
    if (!decoded) return

    for (const [index, address] of decoded.addresses.entries()) {
      const history = this.history(element, address)

      history.samples = [
        {
          time,
          value: decoded.values[index],
          velocity: { value: velocity[index] ?? 0, time: velocityTimes?.[index] ?? time },
        },
      ]
      history.animation = undefined
      history.trajectory = undefined
    }
  }

  /**
   * Records the currently displayed value as direct observations. Protected canonical
   * addresses retain their histories; other components stop following registered effects.
   */
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

  /**
   * Commits supplied values in decoded.addresses order, replacing effect references
   * for unprotected components. Time shares the observation clock; stale movement
   * expires and same-time writes replace the previous observation.
   */
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

  /**
   * Reads displayed values and their velocity without recording a new observation.
   * Uses registered effect velocity when available, otherwise recent direct samples;
   * missing, stale, nonforward, or completed motion contributes zero velocity.
   * Returns undefined when the displayed value cannot be decoded.
   */
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

      if (last?.velocity) {
        const sampled = last.velocity.time

        return time >= sampled && time - sampled < DIRECT_SAMPLE_WINDOW_MS ? last.velocity.value : 0
      }

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

  /**
   * Estimates displayed units/ms around a registered document-timeline effect's
   * current time, including playbackRate. Restores its time and running state before
   * returning; a time range with no sampling interval contributes zero velocity.
   */
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

  /**
   * Associates an effect with every canonical component of a readable property.
   * An optional trajectory returns values/units-per-ms velocity at effect-local
   * milliseconds; without it, read estimates velocity from native interpolation.
   * The caller retains ownership of the effect and its cancellation.
   */
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

  /** Captures displayed motion and numeric destination/reference facts for pure planning. */
  observeSpring(element: HTMLElement, property: string, destination: string): SpringObservation {
    const start = this.read(element, property)
    const end = decodeDestination(element, property, destination)?.values
    // Relative dependency is only needed to decide whether a stationary,
    // non-opacity track should use numeric frames instead of scalar easing.
    const needsReference =
      property !== 'opacity' &&
      start !== undefined &&
      end !== undefined &&
      start.value.length === end.length &&
      start.velocity.every((value) => value === 0)

    return {
      start,
      end,
      relative: needsReference && propertyReference(element, property, destination) !== undefined,
    }
  }
}
