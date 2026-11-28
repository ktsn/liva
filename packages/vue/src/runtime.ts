import { fullMotionFeatures } from '@liva/runtime/features/execution/full'
import { Runtime } from '@liva/runtime'
import type { App } from 'vue'
import { createCompiledLivaPlugin, type LivaOptions } from './compiled.ts'
import { createLayoutSession } from './layout.ts'
import { registerPresence } from './presence.ts'
import { PresenceBindings } from './presence-bindings.ts'

export type { InstanceBinding, InstanceBounds, LivaOptions } from './compiled.ts'

export const handAuthoredFeatures = {
  ...fullMotionFeatures,
  layoutSession: createLayoutSession,
  presenceBindings: PresenceBindings,
}

/** Full integration for hand-authored definitions and explicit definition replacement. */
export function createLivaPlugin(options: LivaOptions = {}) {
  return {
    install(app: App) {
      registerPresence(app)
      app.use(createCompiledLivaPlugin({ ...options, defaults: handAuthoredFeatures, Runtime }))
    },
  }
}
