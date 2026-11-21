import { MotionRuntime } from './motion-runtime.ts'
import { fullMotionFeatures } from './full.ts'

/** Runtime for hand-authored definitions with access to every built-in. */
export class Runtime extends MotionRuntime {
  constructor(
    ...[execution, definition, inputs, report]: ConstructorParameters<typeof MotionRuntime>
  ) {
    super(execution, definition, inputs, report, fullMotionFeatures)
  }
}
