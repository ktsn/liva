import { Runtime } from '../../execution/runtime.ts'
import { RuntimeInspection } from '../../execution/inspection.ts'
import { BrowserExecutor } from '../../execution/browser-executor.ts'
import { fullMotionFeatures } from '../../execution/full.ts'
import { PreviewExecution } from '../../execution/preview-execution.ts'
import type { Definition } from '../../model/definition.ts'
import type { RuntimeDiagnostic } from '../../execution/execution-contracts.ts'

/** Test setup exposes actual role participants; tests call replacement APIs directly. */
export function assembleRuntime(
  definition: Definition,
  inputs: Readonly<Record<string, unknown>> = {},
  report: (diagnostic: RuntimeDiagnostic) => void = console.warn,
) {
  const executor = new BrowserExecutor(report, {
    ...fullMotionFeatures.executor,
    preview: PreviewExecution,
  })
  let runtime: Runtime | undefined

  try {
    runtime = new Runtime(executor, definition, inputs, report)
    executor.attach(runtime.environment)
  } catch (error) {
    try {
      if (runtime) runtime.dispose()
      else executor.dispose()
    } catch (cleanupError) {
      report({
        code: 'test.initialization-cleanup',
        message: String(cleanupError),
        error: cleanupError,
      })
    }

    throw error
  }

  return { runtime, executor, inspection: new RuntimeInspection(runtime, executor, report) }
}

export type RuntimeAssembly = ReturnType<typeof assembleRuntime>

/**
 * Internal native-effect observation for browser behavior assertions. Product APIs
 * deliberately expose only scoped preview operations. Preserve the executor's
 * native ordering and preview selection without adding a public Animation view.
 */
export function nativeEffects(executor: BrowserExecutor): readonly Animation[] {
  const active: unknown = Reflect.get(executor, 'active')
  const mode: unknown = Reflect.get(executor, 'presentationMode')

  if (!Array.isArray(active)) throw new Error('Expected executor effect registry')

  return active
    .filter((entry: { preview: boolean }) => mode !== 'preview' || entry.preview)
    .map((entry: { animation: Animation }) => entry.animation)
}
