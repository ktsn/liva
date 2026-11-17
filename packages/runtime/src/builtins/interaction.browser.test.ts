import { expect, it } from 'vite-plus/test'
import { userEvent } from 'vite-plus/test/browser'
import { interaction } from './interaction.ts'
import type { RuntimeValue } from '../evaluation/reactive-value.ts'

async function bindInteraction(initiallyFocused = false) {
  const element = document.createElement('button')
  element.textContent = 'Interaction target'
  document.body.append(element)

  // Establish native pointer state before counting notifications from the operation under test.
  await userEvent.unhover(element)

  if (initiallyFocused) element.focus()

  await nextFrame()

  const subscription = interaction({ target: { name: 'body' } })
  const updates: RuntimeValue[] = []
  const cleanup = subscription.bind(new Map([['body', element]]), (value) => {
    updates.push(value)
  })

  return {
    element,
    subscription,
    cleanup,
    updates,
  }
}

async function nextFrame() {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
}

it('initializes from the target matching state', async () => {
  const binding = await bindInteraction(true)

  try {
    expect(binding.subscription.value).toMatchObject({
      focus: true,
      focusWithin: true,
      focusVisible: binding.element.matches(':focus-visible'),
    })
  } finally {
    binding.cleanup()
    binding.element.remove()
  }
})

it('publishes focus changes from the bound target', async () => {
  const binding = await bindInteraction()

  try {
    binding.element.focus()
    await nextFrame()

    expect(binding.subscription.value).toMatchObject({ focus: true, focusWithin: true })
    expect(binding.updates).toHaveLength(1)

    binding.element.blur()
    await nextFrame()

    expect(binding.subscription.value).toMatchObject({ focus: false, focusWithin: false })
    expect(binding.updates).toHaveLength(2)
  } finally {
    binding.cleanup()
    binding.element.remove()
  }
})

it('does not notify for unchanged snapshots across immediate and deferred rechecks', async () => {
  const binding = await bindInteraction(true)

  try {
    const previous = binding.updates.length

    document.dispatchEvent(new Event('pointermove'))
    document.dispatchEvent(new Event('pointermove'))
    await nextFrame()

    expect(binding.updates).toHaveLength(previous)
  } finally {
    binding.cleanup()
    binding.element.remove()
  }
})

it('releases listeners and resets the snapshot on disposal', async () => {
  const binding = await bindInteraction()

  try {
    await userEvent.hover(binding.element)
    await nextFrame()
    binding.element.focus()
    binding.cleanup()

    const previous = binding.updates.length

    binding.element.blur()
    binding.element.focus()
    await userEvent.hover(binding.element)
    await nextFrame()

    expect(binding.updates).toHaveLength(previous)
    expect(binding.subscription.value).toMatchObject({ focus: false, hover: false })
  } finally {
    binding.cleanup()
    binding.element.remove()
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
