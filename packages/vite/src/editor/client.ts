import { inspectionFeatures } from './inspection-features.ts'
import { handAuthoredFeatures, type InstanceBinding } from '@liva/vue/runtime'
import { createCompiledLivaPlugin } from '@liva/vue/compiled'
import { registerPresence } from '@liva/vue/features/presence'
import { RuntimeInspection } from '@liva/runtime'
import { PreviewExecution } from '@liva/runtime/features/execution/preview-execution'
import type { App } from 'vue'
import type { Edit } from './communication/protocol.ts'
import { createEditorTransport, subscribeToEditorEvents } from './communication/client.ts'
import { EditorController } from './controller.ts'
import { mountEditor } from './ui.ts'

function hasInspection(
  binding: InstanceBinding,
): binding is InstanceBinding & { readonly inspection: RuntimeInspection } {
  return binding.inspection !== undefined
}

/** The consuming dev server provides the session token and the virtual module's HMR context. */
export function createDevPlugin(token: string, hot: ImportMeta['hot']) {
  const controller = new EditorController(createEditorTransport(token))
  const unmount = mountEditor(controller)
  const unsubscribe = subscribeToEditorEvents(hot, {
    sourceChanged: (sourceId) => controller.sourceChanged(sourceId),
    diagnostics: (sourceId, message) => controller.reportSourceDiagnostics(sourceId, message),
  })
  hot?.dispose(() => {
    unsubscribe()
    unmount()
  })

  Object.assign(window, { __LIVA_EDITOR__: controller })

  const plugin = createCompiledLivaPlugin({
    defaults: handAuthoredFeatures,
    source: (component) => component.livaSource,
    observe: (event, binding) => {
      /* v8 ignore else -- @preserve: This adapter supplies both the observer and its inspection. */
      if (hasInspection(binding)) controller.observe(event, binding)
    },
    onDiagnostic: (diagnostic) => controller.report(diagnostic.message),
    inspect: (runtime, executor, report) =>
      new RuntimeInspection(runtime, executor, report, inspectionFeatures),
    preview: {
      controllers: handAuthoredFeatures.executor.controllers,
      preview: PreviewExecution,
    },
  })

  return {
    install(app: App) {
      registerPresence(app)
      app.use(plugin)
    },
  }
}

export type { Edit }
