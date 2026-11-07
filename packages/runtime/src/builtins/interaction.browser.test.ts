import { expect, it } from 'vite-plus/test'
import { userEvent } from 'vite-plus/test/browser'
import { interaction } from './interaction.ts'

it('initializes from matching state and observes changes without duplicate notifications', async () => {
  const element = document.createElement('button')
  element.textContent = 'Interaction target'
  document.body.append(element)
  element.focus()

  const subscription = interaction({ target: { name: 'body' } })
  let updates = 0
  const cleanup = subscription.bind(new Map([['body', element]]), () => {
    updates++
  })

  try {
    expect(subscription.value).toMatchObject({
      focus: true,
      focusWithin: true,
      focusVisible: element.matches(':focus-visible'),
    })

    await userEvent.hover(element)
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

    expect(subscription.value).toMatchObject({ hover: element.matches(':hover') })

    const previous = updates
    document.dispatchEvent(new Event('pointermove'))
    document.dispatchEvent(new Event('pointermove'))
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

    expect(updates).toBe(previous)

    element.blur()
    cleanup()
    const disposed = updates
    element.focus()
    await userEvent.hover(element)
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

    expect(updates).toBe(disposed)
    expect(subscription.value).toMatchObject({ focus: false, hover: false })
  } finally {
    cleanup()
    element.remove()
  }
})

it('allows disposal from an update callback without leaving a deferred recheck', () => {
  const element = document.createElement('button')
  document.body.append(element)
  const subscription = interaction({ target: { name: 'body' } })
  let updates = 0
  const cleanup = subscription.bind(new Map([['body', element]]), () => {
    updates++
    cleanup()
  })

  try {
    element.focus()

    expect(updates).toBe(1)

    element.blur()
    element.focus()

    expect(updates).toBe(1)
  } finally {
    cleanup()
    element.remove()
  }
})

it('rejects a target without a browsing context', () => {
  const document = window.document.implementation.createHTMLDocument()
  const element = document.createElement('button')
  const subscription = interaction({ target: { name: 'body' } })

  expect(() => subscription.bind(new Map([['body', element]]), () => {})).toThrow(
    'browsing context',
  )
})
