import { sampleSpring } from './spring.ts'
import { prepareSpringMotion, springMotion } from './spring-motion.ts'
import type { SpringPlayback } from '../execution/presentation-planner.ts'

export const springPlayback = {
  timing: sampleSpring,
  frames: prepareSpringMotion,
  trajectory: springMotion,
} satisfies SpringPlayback & { trajectory: typeof springMotion }
