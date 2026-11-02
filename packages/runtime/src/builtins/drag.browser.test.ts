import { expect, it } from 'vite-plus/test'
import { userEvent } from 'vite-plus/test/browser'
import { drag } from './drag.ts'
import type { RuntimeValue } from '../reactive-value.ts'

it('tracks real pointer movement, release and cleanup independently for each target', async () => {
  const source = document.createElement('div')
  const destination = document.createElement('div')

  source.style.cssText =
    'position:fixed;left:20px;top:20px;width:40px;height:40px;background:red;touch-action:none'
  destination.style.cssText =
    'position:fixed;left:120px;top:80px;width:40px;height:40px;background:blue'
  document.body.append(source, destination)

  const subscription = drag({ target: { name: 'body' } })
  const updates: RuntimeValue[] = []
  const cleanup = subscription.bind(new Map([['body', source]]), (value) => updates.push(value))

  try {
    source.dispatchEvent(new PointerEvent('pointermove', { pointerId: 99 }))
    source.dispatchEvent(new PointerEvent('pointerup', { pointerId: 99 }))
    source.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 99 }))
    source.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 99, isPrimary: false }))
    source.dispatchEvent(
      new PointerEvent('pointerdown', { pointerId: 99, isPrimary: true, button: 2 }),
    )

    expect(updates).toEqual([])

    await userEvent.dragAndDrop(source, destination)

    expect(updates).toContainEqual({ active: true, released: false, offset: { x: 0, y: 0 } })
    expect(subscription.value).toEqual({ active: false, released: true, offset: { x: 100, y: 60 } })

    cleanup()

    expect(subscription.value).toEqual({
      active: false,
      released: false,
      offset: { x: 100, y: 60 },
    })

    const count = updates.length

    await userEvent.dragAndDrop(source, destination)

    expect(updates).toHaveLength(count)
  } finally {
    cleanup()
    source.remove()
    destination.remove()
  }
})

it.each(['cleanup', 'capture-lost'] as const)(
  'ends an active pointer subscription on %s',
  async (mode) => {
    const source = document.createElement('div')
    const destination = document.createElement('div')

    source.style.cssText =
      'position:fixed;left:20px;top:20px;width:40px;height:40px;touch-action:none'
    destination.style.cssText = 'position:fixed;left:120px;top:80px;width:40px;height:40px'
    document.body.append(source, destination)

    const subscription = drag({ target: { name: 'body' } })
    let cleanup!: () => void

    cleanup = subscription.bind(new Map([['body', source]]), (value) => {
      if (mode === 'cleanup' && typeof value === 'object' && value.active) cleanup()
    })
    source.addEventListener('pointermove', (event) => {
      if (mode === 'capture-lost' && source.hasPointerCapture(event.pointerId))
        source.releasePointerCapture(event.pointerId)
    })

    try {
      await userEvent.dragAndDrop(source, destination)

      expect(subscription.value).toMatchObject({ active: false, released: false })
    } finally {
      cleanup()
      source.remove()
      destination.remove()
    }
  },
)
