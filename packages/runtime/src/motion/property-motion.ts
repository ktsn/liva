import { waapiProperty } from './animation.ts'
import type { Timing } from '../model/definition.ts'
import {
  springState,
  springParameters,
  SPRING_MAX_SECONDS,
  SPRING_MAX_SAMPLES,
  SPRING_SETTLE_POSITION_ERROR,
  SPRING_SETTLE_VELOCITY_PER_SECOND,
  SPRING_SETTLE_WINDOW_SECONDS,
  SPRING_MIN_INTERVALS,
  SPRING_SAMPLING_DENSITY,
} from './spring.ts'
import {
  propertyEncoder,
  decodeDestination,
  decodeProperty,
  propertyReference,
  type NumericProperty,
} from './property-codec.ts'

/** Freshness window for direct-write handoff velocity, in milliseconds. */
export const DIRECT_SAMPLE_WINDOW_MS = 80

// Scale tolerances by displacement, with a one-unit floor for short moves and
// equal endpoints with incoming velocity. This is not the trajectory's peak amplitude.
const MIN_SETTLING_SCALE = 1
const SETTLE_VELOCITY_PER_MS = SPRING_SETTLE_VELOCITY_PER_SECOND / 1000
const SETTLE_LOOKBACK_MS = SPRING_SETTLE_WINDOW_SECONDS * 1000

// Preserve the existing bounded duration search: 10% frequency increments trade
// search granularity for work, and 32 attempts bound that work. These are heuristic
// settings, not analytically optimal values or a guarantee that every input converges.
const DURATION_FREQUENCY_GROWTH = 1.1
// k grows by the frequency factor squared, while damping grows by the factor itself:
// omega = sqrt(k/m) increases, but zeta = c/(2*sqrt(k*m)) stays constant. Keep the
// literal 1.21: computing 1.1 squared would change its floating-point representation.
const DURATION_STIFFNESS_GROWTH = 1.21
const DURATION_SEARCH_MAX_ATTEMPTS = 32

// Probe 5% before the requested end to reduce acceptance of a transient rest point.
// This retains the existing two-point heuristic, not an interval-wide guarantee.
const DURATION_SETTLE_PROBE_RATIO = 0.95

// Resolution of the physics-duration search, independent of the browser's frame rate.
const PHYSICS_DURATION_STEP_MS = 16

/** Spring timing accepted by numeric trajectories; browser tween timing is handled elsewhere. */
type SpringTiming = Exclude<Timing, { kind: 'tween' }>

/** Values use canonical component units; matching velocity components use those units per millisecond. */
export type MotionSample = {
  readonly value: readonly number[]
  readonly velocity: readonly number[]
}

/** A trajectory sample has no direct expiry; direct components retain their original observation deadline. */
export interface MotionObservation {
  readonly sample: MotionSample
  /** Capture instant on the same performance-clock millisecond axis as direct observations. */
  readonly time: number
  readonly validUntil: readonly (number | undefined)[]
  readonly observedAt: readonly (number | undefined)[]
}

/** Direct observation on the millisecond clock, optionally carrying released input velocity in units/ms. */
type Sample = { time: number; value: number; velocity?: number; validUntil?: number }

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
 * Builds a numeric spring trajectory for equally sized start/end/velocity vectors.
 * Velocities use canonical units per millisecond. Returns its duration, normalized
 * keyframe samples ending exactly at end, and a sampler taking elapsed milliseconds.
 * Duration is a settling target checked at selected times, not a guarantee of rest
 * over an interval. Uniform samples have no adaptive interpolation-error bound;
 * the final frame is pinned to end while the analytic sampler remains unsnapped.
 * Throws for invalid spring parameters or if settling exceeds timing/sampling limits.
 */
export function springMotion(
  timing: SpringTiming,
  start: readonly number[],
  end: readonly number[],
  velocity: readonly number[],
) {
  const parameters = springParameters(timing)
  let { stiffness, damping } = parameters
  const { mass } = parameters
  const settlingScale = start.map((value, index) =>
    Math.max(MIN_SETTLING_SCALE, Math.abs(value - end[index])),
  )

  /** Samples every component at the same elapsed time, retaining analytic velocity. */
  const sample = (milliseconds: number): MotionSample => {
    // The shared physical solver uses seconds; Motion observations and velocities
    // use milliseconds. Convert only at this boundary so handoff units stay stable.
    const components = start.map((value, index) =>
      springState(
        value,
        end[index],
        velocity[index] * 1000,
        stiffness,
        damping,
        mass,
        milliseconds / 1000,
      ),
    )

    return {
      value: components.map((component) => component.value),
      velocity: components.map((component) => component.velocity / 1000),
    }
  }

  /** Tests position and velocity against displacement-relative settling tolerances. */
  const settled = (at: number) => {
    const current = sample(at)

    return current.value.every(
      (value, index) =>
        Math.abs(value - end[index]) < settlingScale[index] * SPRING_SETTLE_POSITION_ERROR &&
        Math.abs(current.velocity[index]) < settlingScale[index] * SETTLE_VELOCITY_PER_MS,
    )
  }

  let durationMs = parameters.durationMs

  if (timing.kind === 'spring-duration') {
    // Preserve the requested duration, damping ratio, and incoming physical velocity
    // while increasing natural frequency. Check both the end and a nearby earlier
    // time, rather than accepting a single quiet sample during an oscillation.
    for (
      let attempt = 0;
      attempt < DURATION_SEARCH_MAX_ATTEMPTS &&
      (!settled(durationMs) || !settled(durationMs * DURATION_SETTLE_PROBE_RATIO));
      attempt++
    ) {
      stiffness *= DURATION_STIFFNESS_GROWTH
      damping *= DURATION_FREQUENCY_GROWTH
    }

    // Once the attempt budget is exhausted, only the final instant is required.
    // The earlier probe is a search heuristic and is not a final acceptance condition.
    if (!settled(durationMs)) throw new Error('Spring cannot settle within the requested duration')
  } else {
    // Preserve the supplied physics and extend time instead. Unlike the scalar
    // solver's consecutive rest samples, these two probes do not establish rest
    // throughout the lookback span or guarantee that later motion stays in bounds.
    while (!settled(durationMs) || !settled(Math.max(0, durationMs - SETTLE_LOOKBACK_MS))) {
      durationMs += PHYSICS_DURATION_STEP_MS
      if (durationMs > SPRING_MAX_SECONDS * 1000)
        throw new Error('Spring did not converge before duration cap')
    }
  }

  // Share scalar easing's coarse density, but keep uniform sampling here. There
  // is no midpoint-error refinement, so this density is not an error guarantee.
  const count = Math.max(
    SPRING_MIN_INTERVALS,
    Math.ceil((durationMs / 1000) * Math.sqrt(stiffness / mass) * SPRING_SAMPLING_DENSITY),
  )

  // This cap limits intervals; including both endpoints produces count + 1 samples.
  if (count > SPRING_MAX_SAMPLES) throw new Error('Spring exceeds property sample cap')
  const samples = Array.from({ length: count + 1 }, (_, index) => {
    const time = (durationMs * index) / count

    // Pin the rendered endpoint without changing the analytic trajectory or its
    // residual velocity, which remains available from sample(durationMs).
    return { time: index / count, value: index === count ? end : sample(time).value }
  })

  return { durationMs, samples, sample }
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
  /** New terminal/controller-release derivative, if committed after a captured handoff. */
  readonly releasedAt?: readonly (number | undefined)[]
  /** Components currently sampled from a running/paused native effect, in the same address order. */
  readonly animated?: readonly boolean[]
}

/**
 * Plans a supported spring from supplied observations without browser reads.
 * Non-endpoint tracks, unreadable/incompatible values, and stationary non-opacity
 * tracks without relative dependencies use the ordinary scalar-easing fallback.
 * CSS output uses existing bounded property serialization. Sampling failures throw.
 */
export function prepareSpringMotion(
  property: string,
  timing: SpringTiming,
  endpointOnly: boolean,
  observation: SpringObservation,
) {
  const { start, end } = observation

  if (
    !endpointOnly ||
    !start ||
    !end ||
    start.value.length !== end.length ||
    (property !== 'opacity' &&
      start.velocity.every((value) => value === 0) &&
      !observation.relative)
  )
    return undefined

  const encode = propertyEncoder(property)

  if (!encode) return undefined

  const motion = springMotion(timing, start.value, end, start.velocity)

  return {
    ...motion,
    frames: motion.samples.map(({ time, value }) => ({
      value: encode(value, true),
      offset: time,
      easing: 'linear',
    })),
  }
}

/**
 * Tracks displayed values and handoff velocity for one Motion instance, keyed by
 * element and canonical component address so CSS aliases share observations.
 * Direct observations use performance.now()-compatible milliseconds; decoded values
 * use canonical units and velocities use those units per millisecond. Unreadable or
 * unsupported properties cannot supply samples or prepared springs.
 * Animation creation/cancellation remains the caller's responsibility.
 */
export class PropertyMotion {
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
   * position at time; unreadable targets are ignored. The supplied velocity takes
   * precedence over DOM finite differences until stale or superseded by a write/effect.
   */
  endControl(
    element: HTMLElement,
    property: string,
    velocity: readonly number[],
    time: number,
    validUntil?: readonly number[],
  ) {
    const decoded = decodeProperty(element, property)
    if (!decoded) return

    for (const [index, address] of decoded.addresses.entries()) {
      const history = this.history(element, address)
      history.samples = [
        {
          time,
          value: decoded.values[index],
          velocity: velocity[index],
          validUntil: validUntil?.[index],
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
    return this.capture(element, property, time)?.sample
  }

  /** Captures motion plus original direct-sample expiry times (performance-clock ms) for deferred handoff. */
  capture(
    element: HTMLElement,
    property: string,
    time = performance.now(),
  ): MotionObservation | undefined {
    const decoded = decodeProperty(element, property)
    if (!decoded) return undefined

    const validUntil: (number | undefined)[] = []
    const observedAt: (number | undefined)[] = []
    const velocity = decoded.addresses.map((address) => {
      const history = this.history(element, address)
      const animation = history.animation
      const lastDirect = history.samples.at(-1)
      validUntil.push(
        animation
          ? undefined
          : (lastDirect?.validUntil ?? (lastDirect?.time ?? time) + DIRECT_SAMPLE_WINDOW_MS),
      )
      observedAt.push(animation ? undefined : lastDirect?.time)

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
      if (last?.velocity !== undefined)
        return time >= last.time && time < (last.validUntil ?? last.time + DIRECT_SAMPLE_WINDOW_MS)
          ? last.velocity
          : 0
      if (
        !last ||
        !before ||
        time - last.time >= DIRECT_SAMPLE_WINDOW_MS ||
        last.time <= before.time
      )
        return 0

      return (last.value - before.value) / (last.time - before.time)
    })

    return { sample: { value: decoded.values, velocity }, time, validUntil, observedAt }
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

  /**
   * Prepares endpoint-only WAAPI spring frames using displayed values and velocity.
   * Returns undefined for non-endpoint tracks, incompatible numeric endpoints, or
   * stationary non-opacity values without relative dependencies, allowing the caller's
   * ordinary animation path. Relative endpoints and opacity may start at rest.
   * Returned frames use bounded serialization; spring settling/sampling failures throw.
   */
  prepareSpring(
    element: HTMLElement,
    property: string,
    destination: string,
    timing: SpringTiming,
    endpointOnly: boolean,
  ) {
    if (!endpointOnly) return undefined
    const observation = this.observeSpring(element, property, destination)
    const motion = prepareSpringMotion(property, timing, endpointOnly, observation)

    if (!motion) return undefined

    return {
      ...motion,
      frames: motion.frames.map(({ value, offset, easing }) => ({
        [waapiProperty(property)]: value,
        offset,
        easing,
      })),
    }
  }

  /** Captures displayed motion and numeric destination/reference facts for pure planning. */
  observeSpring(element: HTMLElement, property: string, destination: string): SpringObservation {
    const start = this.read(element, property)
    const endpoint = decodeDestination(element, property, destination)
    const end = endpoint?.values
    const animated = endpoint?.addresses.map((address) => {
      const animation = this.histories.get(element)?.get(address)?.animation

      return animation !== undefined && ['running', 'paused'].includes(animation.playState)
    })
    const releasedAt = endpoint?.addresses.map((address) => {
      const history = this.histories.get(element)?.get(address)
      const last = history?.samples.at(-1)

      return !history?.animation && last?.velocity !== undefined ? last.time : undefined
    })
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
      releasedAt,
      animated,
      relative: needsReference && propertyReference(element, property, destination) !== undefined,
    }
  }
}
