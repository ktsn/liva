import type { RuntimeAssembly } from './assembly.ts'
import type { PresentationExecutor } from '../../execution/presentation-executor.ts'

/** Collects actual executor captures; browser endpoints remain private to their owner. */
export function capturePresence(
  instance: RuntimeAssembly,
  phase: 'enter' | 'leave',
  names: readonly string[],
  options?: Parameters<PresentationExecutor['capturePresence']>[2],
) {
  return [instance.executor.capturePresence(phase, names, options)]
}
