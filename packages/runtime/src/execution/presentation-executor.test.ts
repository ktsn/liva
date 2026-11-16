import { expect, it, vi } from 'vite-plus/test'
import { PresentationExecutor } from './presentation-executor.ts'
import type { ReactiveSubscription } from '../evaluation/reactive-value.ts'

it('releases source adapter resources once across executor and binding cleanup', () => {
  const executor = new PresentationExecutor(() => {})
  const cleanup = vi.fn<() => void>()
  const source: ReactiveSubscription = { value: 1, bind: () => cleanup }
  const disconnect = executor.connectSource(source, () => {})

  executor.disconnectBindings()
  disconnect()
  disconnect()

  expect(cleanup).toHaveBeenCalledTimes(1)
})

it('rejects sources without a browser connection adapter', () => {
  const executor = new PresentationExecutor(() => {})

  expect(() => executor.connectSource({ value: 1 }, () => {})).toThrow(
    'Source has no browser adapter',
  )
})
