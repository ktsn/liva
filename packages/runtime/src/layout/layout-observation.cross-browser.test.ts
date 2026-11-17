import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { LayoutReadBatch, missingBounds } from './layout-bounds.ts'
import { observeLayoutInline, registerLayoutRead, writeLayoutStyle } from './layout-scheduler.ts'

const cleanups: (() => void)[] = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) cleanup()
})

async function frame(view: Window = window) {
  await new Promise<void>((resolve) => view.requestAnimationFrame(() => resolve()))
}

async function settled(view: Window = window) {
  await frame(view)
  await frame(view)
}

/** Wait for the native initialization notification before recording invalidation counts. */
async function initialResize(element: HTMLElement) {
  await new Promise<void>((resolve) => {
    const observer = new ResizeObserver(() => {
      observer.disconnect()
      resolve()
    })
    observer.observe(element)
  })
}

function fixture() {
  const root = document.createElement('div')
  root.style.cssText =
    'position:relative;box-sizing:border-box;width:320.5px;height:240.25px;border:3px solid;padding:16.5px;overflow:auto;'
  const target = document.createElement('div')
  target.style.cssText =
    'box-sizing:border-box;width:120.25px;height:35.5px;border:2px solid;padding:4px;'
  root.append(target)
  document.body.append(root)
  cleanups.push(() => root.remove())

  return { root, target }
}

describe('geometry read phases', () => {
  it('applies startup writes before a fresh document acquires its first geometry owner', () => {
    const iframe = document.createElement('iframe')
    document.body.append(iframe)
    cleanups.push(() => iframe.remove())
    // Appended same-origin about:blank has an initialized document synchronously.
    const childDocument = iframe.contentDocument!
    const root = childDocument.createElement('div')
    childDocument.body.append(root)
    writeLayoutStyle(root, () => {
      root.style.cssText = 'width:200px;height:30px;'
    })
    let width = 0

    cleanups.push(
      registerLayoutRead(
        childDocument,
        (batch) => {
          const next = batch.bounds(root, root)
          return () => {
            width = next.width
          }
        },
        [root],
      ),
    )

    expect(width).toBe(200)
  })

  it('keeps a shared element subscription until its last reader releases it', () => {
    const { root } = fixture()
    const firstChange = vi.fn<(change: unknown) => void>()
    const nextChange = vi.fn<(change: unknown) => void>()
    const first = observeLayoutInline(root, firstChange)
    const next = observeLayoutInline(root, nextChange)
    cleanups.push(next.dispose)

    root.style.color = 'red'
    next.flush()

    expect(firstChange).toHaveBeenCalledTimes(1)
    expect(nextChange).toHaveBeenCalledTimes(1)

    first.dispose()
    root.style.color = 'blue'
    next.flush()

    expect(firstChange).toHaveBeenCalledTimes(1)
    expect(nextChange).toHaveBeenCalledTimes(2)
    expect(nextChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ after: root.getAttribute('style'), generated: false }),
    )
  })

  it('keeps replacement inline observation alive after an obsolete cleanup repeats', () => {
    const { root } = fixture()
    const old = vi.fn<(change: unknown) => void>()
    const current = vi.fn<(change: unknown) => void>()
    const first = observeLayoutInline(root, old)
    first.dispose()
    const second = observeLayoutInline(root, current)
    cleanups.push(second.dispose)

    first.dispose()
    root.style.color = 'red'
    second.flush()

    expect(old).not.toHaveBeenCalled()
    expect(current).toHaveBeenCalledTimes(1)
    expect(current).toHaveBeenCalledWith(expect.objectContaining({ generated: false }))
  })

  it('shares ancestor reads and retains numeric frames independently of later DOM mutations', () => {
    const { root, target } = fixture()
    root.style.transform = 'rotate(25deg)'
    target.style.transform = 'rotate(15deg)'
    const batch = new LayoutReadBatch()
    const read = vi.spyOn(root, 'getBoundingClientRect')
    const snapshot = batch.projection(target)
    if (!snapshot) throw new Error('Expected supported affine snapshot')

    expect(batch.bounds(target, root).width).toBe(120.25)
    expect(read).toHaveBeenCalledTimes(1)
    const styles = vi.spyOn(window, 'getComputedStyle')
    target.style.width = '240px'
    root.style.transform = 'rotate(40deg)'
    const without = snapshot.withoutTransforms(new Set([root]))

    expect(styles).not.toHaveBeenCalled()
    expect(without.box.width).toBe(120.25)
    expect(without.frame.a).toBeCloseTo(1, 6)
    expect(without.frame.b).toBeCloseTo(0, 6)
    expect(without.positionPrecision).toBeGreaterThan(0)
    styles.mockRestore()
    read.mockRestore()
  })

  it('reports cached unsupported geometry independently to each consumer', () => {
    const { root, target } = fixture()
    root.style.position = 'sticky'
    const batch = new LayoutReadBatch()
    const first: string[] = []
    const second: string[] = []
    const styles = vi.spyOn(window, 'getComputedStyle')

    expect(batch.bounds(target, root, (reason) => first.push(reason))).toBe(missingBounds)
    const reads = styles.mock.calls.length
    expect(batch.bounds(target, root, (reason) => second.push(reason))).toBe(missingBounds)
    expect(styles).toHaveBeenCalledTimes(reads)
    expect(second).toEqual(first)
    expect(first).toHaveLength(1)
    styles.mockRestore()
  })

  it('rejects unrelated/disconnected references and boxless projection at the batch boundary', () => {
    const { root, target } = fixture()
    const batch = new LayoutReadBatch()

    expect(batch.bounds(root, target)).toBe(missingBounds)
    target.style.display = 'none'
    expect(batch.projection(target)).toBeUndefined()
    root.remove()
    expect(batch.bounds(target, root)).toBe(missingBounds)
    expect(batch.projection(target)).toBeUndefined()
  })
})

describe('shared layout projection observation', () => {
  it('excludes exact generated writes while preserving interleaved external edits', async () => {
    const root = document.createElement('div')
    document.body.append(root)
    cleanups.push(() => root.remove())
    let reads = 0
    cleanups.push(
      registerLayoutRead(
        document,
        () => {
          reads++
          return () => {}
        },
        [root],
        { visual: true },
      ),
    )
    await initialResize(root)
    await settled()
    const before = reads

    writeLayoutStyle(root, () => root.style.setProperty('transform', 'scale(2)', 'important'))
    writeLayoutStyle(root, () => root.style.setProperty('border-radius', '12px', 'important'))
    await settled()
    expect(reads).toBe(before)

    writeLayoutStyle(root, () => root.style.setProperty('transform', 'scale(3)', 'important'))
    root.style.transform = 'rotate(20deg)'
    writeLayoutStyle(root, () => root.style.setProperty('transform', 'scale(4)', 'important'))
    await settled()
    expect(reads).toBe(before + 1)
  })

  it('shares one geometry cache across registered consumers in a flush', async () => {
    const root = document.createElement('div')
    root.style.cssText = 'width:100px;height:20px'
    document.body.append(root)
    cleanups.push(() => root.remove())
    const read = vi.spyOn(root, 'getBoundingClientRect')
    cleanups.push(() => read.mockRestore())
    let publish: (() => void) | undefined

    for (let index = 0; index < 2; index++) {
      cleanups.push(
        registerLayoutRead(
          document,
          (batch) => {
            batch.bounds(root, root)
            return () => publish?.()
          },
          [root],
        ),
      )
    }
    await settled()
    read.mockClear()
    const published = new Promise<void>((resolve) => {
      publish = resolve
    })
    root.className = 'changed'
    await published

    expect(read).toHaveBeenCalledTimes(1)
  })

  it.each(['prepare', 'read', 'publish', 'restore'])(
    'reports owned %s failures and still restores other participants',
    (phase) => {
      const raf = vi.spyOn(window, 'requestAnimationFrame')
      const cause = new Error(`${phase} failed`)
      const errors: unknown[] = []
      const order: string[] = []
      let failing = false
      const step = (owner: string, name: string) => {
        order.push(`${owner}:${name}`)
        if (failing && owner === 'first' && name === phase) throw cause
      }

      for (const owner of ['first', 'second']) {
        cleanups.push(
          registerLayoutRead(
            document,
            () => {
              step(owner, 'read')
              return () => step(owner, 'publish')
            },
            [],
            {
              prepare: () => {
                step(owner, 'prepare')
                return () => step(owner, 'restore')
              },
              onError: (error) => errors.push(error),
            },
          ),
        )
      }
      order.length = 0
      failing = true
      window.dispatchEvent(new Event('resize'))
      const callback = raf.mock.calls.at(-1)?.[0]
      if (!callback) throw new Error('Expected scheduled observation')

      callback(performance.now())

      expect(errors).toEqual([cause])
      expect(order).toContain('second:publish')
      expect(order.at(-1)).toBe('second:restore')
      expect(order.includes('first:restore')).toBe(phase !== 'prepare')
      expect(order.indexOf('second:read')).toBeLessThan(order.indexOf('second:publish'))
      raf.mockRestore()
    },
  )

  it('throws initialization failure even when an asynchronous owner handler exists', () => {
    const cause = new Error('Initial read failed')
    const reported: unknown[] = []
    let error: unknown

    try {
      registerLayoutRead(
        document,
        () => {
          throw cause
        },
        [],
        { onError: (failure) => reported.push(failure) },
      )
    } catch (failure) {
      error = failure
    }

    expect(error).toBeInstanceOf(Error)
    if (!(error instanceof Error)) throw new Error('Expected initialization failure')
    expect(error.cause).toBe(cause)
    expect(reported).toEqual([])
  })
  it('preserves the original cause when owner error handling throws and still completes other owners', () => {
    const raf = vi.spyOn(window, 'requestAnimationFrame')
    const cause = new Error('Read failed')
    const handlerCause = new Error('Monitoring failed')
    const order: string[] = []
    let fail = false
    cleanups.push(
      registerLayoutRead(
        document,
        () => {
          if (fail) throw cause
          return () => {}
        },
        [],
        {
          onError: () => {
            throw handlerCause
          },
        },
      ),
    )
    cleanups.push(
      registerLayoutRead(
        document,
        () => () => {
          order.push('published')
        },
        [],
        {
          prepare: () => () => {
            order.push('restored')
          },
        },
      ),
    )
    fail = true
    order.length = 0
    window.dispatchEvent(new Event('resize'))
    const callback = raf.mock.calls.at(-1)?.[0]
    if (!callback) throw new Error('Expected scheduled observation')
    let caught: unknown

    try {
      callback(performance.now())
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(AggregateError)
    expect(caught).toMatchObject({ cause, errors: [cause, handlerCause] })
    expect(order).toEqual(['published', 'restored'])
    raf.mockRestore()
  })

  it('recognizes generated removal of the final visual inline declaration', async () => {
    const root = document.createElement('div')
    root.style.transform = 'rotate(20deg)'
    document.body.append(root)
    cleanups.push(() => root.remove())
    let reads = 0
    cleanups.push(
      registerLayoutRead(
        document,
        () => {
          reads++
          return () => {}
        },
        [root],
        { visual: true },
      ),
    )
    await initialResize(root)
    await settled()
    const initial = reads

    writeLayoutStyle(root, () => root.removeAttribute('style'))
    await settled()

    expect(root.getAttribute('style')).toBeNull()
    expect(reads).toBe(initial)
  })
  it('does not publish a captured value after another owner unregisters it', () => {
    const raf = vi.spyOn(window, 'requestAnimationFrame')
    const published: string[] = []
    let remove: () => void
    let stop = false
    cleanups.push(
      registerLayoutRead(
        document,
        () => () => {
          if (stop) remove()
        },
        [],
      ),
    )
    remove = registerLayoutRead(
      document,
      () => () => {
        published.push('obsolete')
      },
      [],
    )
    cleanups.push(remove)
    published.length = 0
    stop = true
    window.dispatchEvent(new Event('resize'))
    const callback = raf.mock.calls.at(-1)?.[0]
    if (!callback) throw new Error('Expected shared observation')

    callback(performance.now())

    expect(published).toEqual([])
    raf.mockRestore()
  })
})
