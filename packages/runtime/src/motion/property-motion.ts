import { waapiProperty } from './animation.ts'
import type { Timing } from '../model/definition.ts'
import { MotionHistory } from './motion-history.ts'
import { prepareSpringMotion } from './spring-motion.ts'

export {
  DIRECT_SAMPLE_WINDOW_MS,
  type MotionSample,
  type SpringObservation,
} from './motion-history.ts'
export { springMotion, prepareSpringMotion } from './spring-motion.ts'

/** Motion history with explicit access to numeric spring frame preparation. */
export class PropertyMotion extends MotionHistory {
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
    timing: Exclude<Timing, { kind: 'tween' }>,
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
}
