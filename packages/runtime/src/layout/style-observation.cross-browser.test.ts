import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { trackLayoutAnimation } from './layout-scheduler.ts'
import {
  observeLayoutStyles,
  ownLayoutStyleSource,
  layoutStyleSourceTimes,
  layoutStyleSourceRevision,
} from './style-observation.ts'

const cleanups: (() => void)[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).toReversed()) cleanup()
})

function fixture() {
  const parent = document.createElement('div')
  const child = document.createElement('div')
  parent.style.cssText = 'width:200px;height:100px;border-radius:16px;transform:scale(.5);'
  child.style.cssText = 'width:40px;height:20px;border-radius:24px;'
  parent.append(child)
  document.body.append(parent)
  cleanups.push(() => parent.remove())

  return { parent, child }
}

function sourceEffect(element: HTMLElement) {
  const animation = element.animate([{ borderRadius: '8px' }, { borderRadius: '24px' }], {
    duration: 1000,
    fill: 'both',
  })
  animation.pause()
  animation.currentTime = 250
  // The test owns cancellation, independently of source-observation registration.
  void animation.finished.catch(() => {})
  cleanups.push(() => animation.cancel())

  return animation
}

describe('paint source observation phases', () => {
  it('excludes inherited ancestor output once before all reads and restores it last', () => {
    const { parent, child } = fixture()
    const events: string[] = []
    cleanups.push(
      ownLayoutStyleSource(parent, () => {
        events.push('parent source')
        parent.style.borderRadius = '8px'
        return () => {
          events.push('parent output')
          parent.style.borderRadius = '16px'
        }
      }),
    )
    cleanups.push(
      ownLayoutStyleSource(child, () => {
        events.push('child source')
        child.style.borderRadius = 'inherit'
        return () => {
          events.push('child output')
          child.style.borderRadius = '24px'
        }
      }),
    )

    const radius = observeLayoutStyles([child, parent, child], () => {
      events.push('read')
      return getComputedStyle(child).borderTopLeftRadius
    })

    expect(radius).toBe('8px')
    expect(events).toEqual([
      'parent source',
      'child source',
      'read',
      'child output',
      'parent output',
    ])
    expect(parent.style.transform).toBe('scale(0.5)')
    expect(child.style.borderRadius).toBe('24px')
  })

  it('retains a replacement source owner after obsolete unregistration', () => {
    const { parent } = fixture()
    const old = ownLayoutStyleSource(parent, () => {
      throw new Error('An obsolete source owner must not run')
    })
    cleanups.push(
      ownLayoutStyleSource(parent, () => {
        parent.style.borderRadius = '8px'
        return () => {
          parent.style.borderRadius = '24px'
        }
      }),
    )

    old()
    const radius = observeLayoutStyles([parent], () => getComputedStyle(parent).borderTopLeftRadius)
    old()

    expect(radius).toBe('8px')
    expect(parent.style.borderRadius).toBe('24px')
  })

  it('tracks one native source through ancestors, duplicate registration and final completion', async () => {
    const { parent, child } = fixture()
    const animation = sourceEffect(parent)
    const before = layoutStyleSourceRevision(document)
    const added = vi.spyOn(animation, 'addEventListener')

    trackLayoutAnimation(parent, 'border-radius', animation)
    trackLayoutAnimation(parent, 'border-radius', animation)

    expect(layoutStyleSourceTimes(child)).toEqual([{ animation, time: 250 }])
    expect(added.mock.calls.map(([type]) => type)).toEqual(['finish', 'cancel'])
    expect(layoutStyleSourceRevision(document)).toBeGreaterThan(before)
    const registered = layoutStyleSourceRevision(document)

    animation.finish()
    await animation.finished
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

    expect(layoutStyleSourceTimes(child)).toEqual([])
    expect(layoutStyleSourceRevision(document)).toBeGreaterThan(registered)
    expect(animation.playState).toBe('finished')
    expect(parent.getAnimations()).toContain(animation)
    expect(getComputedStyle(parent).borderTopLeftRadius).toBe('24px')
  })

  it('releases partial native listener registration after failure without canceling the source effect', () => {
    const { parent, child } = fixture()
    const animation = sourceEffect(parent)
    const cause = new Error('Native cancel-listener registration failed')
    const add = animation.addEventListener.bind(animation)
    const removed = vi.spyOn(animation, 'removeEventListener')
    const failed = vi
      .spyOn(animation, 'addEventListener')
      .mockImplementation((type, listener, options) => {
        if (type === 'cancel') throw cause
        add(type, listener, options)
      })

    expect(() => trackLayoutAnimation(parent, 'border-radius', animation)).toThrow(cause)

    expect(layoutStyleSourceTimes(child)).toEqual([])
    expect(removed.mock.calls.map(([type]) => type)).toEqual(['finish', 'cancel'])
    expect(animation.playState).toBe('paused')
    expect(animation.currentTime).toBe(250)
    failed.mockRestore()
    trackLayoutAnimation(parent, 'border-radius', animation)
    expect(layoutStyleSourceTimes(child)).toEqual([{ animation, time: 250 }])
  })
})
