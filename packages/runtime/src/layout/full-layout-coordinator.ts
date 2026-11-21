import { LayoutCoordinator as Coordinator } from './layout-coordinator.ts'
import { springMotion } from '../motion/spring-motion.ts'

/** Coordinates application layout with spring support for standalone participants. */
export class LayoutCoordinator extends Coordinator {
  constructor(report: (error: unknown) => void) {
    super(report, springMotion)
  }
}
