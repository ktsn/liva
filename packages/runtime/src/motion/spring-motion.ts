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
import { propertyEncoder } from './property-codec.ts'
import type { MotionSample, SpringObservation } from './motion-history.ts'

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
