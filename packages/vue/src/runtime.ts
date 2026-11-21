import { fullMotionFeatures } from '@liva/runtime/features/execution/full'
import type { Definition, MotionFeatures } from '@liva/runtime/core'
import { Runtime, RuntimeInspection } from '@liva/runtime'
import { createCompiledLivaPlugin, type LivaOptions } from './compiled.ts'
import { createLayoutSession } from './layout.ts'
import { LivaPresenceBoundary, livaEntry } from './presence.ts'
import { PresenceBindings } from './presence-bindings.ts'

export type { InstanceBinding, InstanceBounds, LivaOptions } from './compiled.ts'

export const handAuthoredFeatures = {
  ...fullMotionFeatures,
  layoutSession: createLayoutSession,
  presenceBindings: PresenceBindings,
}

/** Full integration for hand-authored definitions and explicit definition replacement. */
export function createLivaPlugin(options: LivaOptions = {}) {
  return createIntegration(options, true)
}

/** Adds inspection to the compiled path used by the development entry. */
export function createEditorLivaPlugin(
  options: LivaOptions,
  resolveInspectionFeatures: (definition: Definition) => MotionFeatures,
) {
  return createIntegration(options, false, resolveInspectionFeatures)
}

function createIntegration(
  options: LivaOptions,
  useFullRuntime: boolean,
  resolveInspectionFeatures?: (definition: Definition) => MotionFeatures,
) {
  const plugin = createCompiledLivaPlugin({
    ...options,
    defaults: handAuthoredFeatures,
    Runtime: useFullRuntime ? Runtime : undefined,
    inspect: (runtime, executor, report) =>
      new RuntimeInspection(runtime, executor, report, resolveInspectionFeatures),
    preview: {
      controllers: fullMotionFeatures.executor.controllers,
      preview: fullMotionFeatures.executor.preview,
    },
  })

  return {
    install(app: import('vue').App) {
      app.component('LivaPresenceBoundary', LivaPresenceBoundary)
      app.directive('liva-entry', livaEntry)
      app.use(plugin)
    },
  }
}
