import type { LivaInstance } from '../../execution/instance.ts'
import { PresentationExecutor } from '../../execution/presentation-executor.ts'

/** Uses the facade's actual browser participant while callers migrate to explicit assembly. */
export function executorOf(instance: LivaInstance): PresentationExecutor {
  const executor: unknown = Reflect.get(instance, 'executor')

  if (!(executor instanceof PresentationExecutor))
    throw new Error('Expected the facade browser participant')

  return executor
}

/** Collects the real executor capture as one boundary participant; no endpoints leave the executor. */
export function capturePresence(
  instance: LivaInstance,
  phase: 'enter' | 'leave',
  names: readonly string[],
  options?: Parameters<PresentationExecutor['capturePresence']>[2],
) {
  return [executorOf(instance).capturePresence(phase, names, options)]
}
