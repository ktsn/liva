import { callBuiltin } from '../builtins/index.ts'
import { allPureBuiltins } from '../evaluation/all-builtins.ts'
import { ReactiveCallStore } from '../evaluation/reactive-call-store.ts'
import { springPlayback } from '../motion/spring-playback.ts'
import { controllerFeature, ControllersExecution } from './controller-feature.ts'
import { layoutFeature, LayoutExecution } from './layout-feature.ts'
import { PresenceExecution } from './presence-execution.ts'
import { PreviewExecution } from './preview-execution.ts'
import { SourcesExecution } from './sources-execution.ts'
import type { MotionFeatures } from './motion-features.ts'

/** Feature assembly for hand-authored Definitions and isolated editor candidates. */
export const fullMotionFeatures = {
  pure: allPureBuiltins,
  reactive: { Store: ReactiveCallStore, builtins: (name, args) => callBuiltin(name, args) },
  controllers: controllerFeature,
  layout: layoutFeature,
  executor: {
    layout: LayoutExecution,
    controllers: ControllersExecution,
    presence: PresenceExecution,
    preview: PreviewExecution,
    sources: SourcesExecution,
    spring: springPlayback,
  },
} satisfies MotionFeatures
