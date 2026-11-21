import { BrowserExecutor } from './browser-executor.ts'
import { fullMotionFeatures } from './full.ts'
import type { RuntimeDiagnostic } from './execution-contracts.ts'

/** Browser executor for hand-authored definitions with all playback capabilities. */
export class PresentationExecutor extends BrowserExecutor {
  constructor(report: (diagnostic: RuntimeDiagnostic) => void) {
    super(report, fullMotionFeatures.executor)
  }
}
