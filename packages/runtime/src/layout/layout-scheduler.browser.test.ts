import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { registerLayoutRead, trackLayoutAnimation } from './layout-scheduler.ts'
import { measure } from '../builtins/measure.ts'

const cleanups: (() => void)[] = []

async function frame() {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
}

async function settled() {
  await frame()
  await frame()
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) cleanup()
})

describe('shared layout scheduling', () => {
  it('batches all reads before publications and defers dependent writes to another frame', async () => {
    const root = document.createElement('div')
    document.body.append(root)
    cleanups.push(() => root.remove())
    const order: string[] = []
    let change = false

    for (const name of ['first', 'second']) {
      cleanups.push(
        registerLayoutRead(document, () => {
          order.push(`read ${name}`)

          return () => {
            order.push(`publish ${name}`)
            if (change && name === 'first') {
              change = false
              root.style.width = '200px'
            }
          }
        }, [root]),
      )
    }

    await settled()
    order.length = 0
    change = true
    root.className = 'changed'

    await frame()

    expect(order).toEqual(['read first', 'read second', 'publish first', 'publish second'])

    await frame()

    expect(order.slice(4)).toEqual(['read first', 'read second', 'publish first', 'publish second'])
  })

  it('rechecks Liva layout effects each frame, including effects started before subscription', async () => {
    const root = document.createElement('div')
    root.style.cssText = 'width:100px;height:20px;'
    document.body.append(root)
    cleanups.push(() => root.remove())
    const animation = root.animate([{ width: '100px' }, { width: '200px' }], {
      duration: 1000,
      fill: 'both',
    })
    trackLayoutAnimation(root, 'width', animation)
    cleanups.push(() => animation.cancel())
    const source = measure({ target: { name: 'self' } })
    cleanups.push(source.bind(new Map([['self', root]]), () => {}))

    await settled()
    const before = source.value

    await settled()

    expect(source.value).not.toBe(before)
    expect(source.value).toMatchObject({ attached: true })

    animation.finish()

    await settled()

    expect(source.value).toMatchObject({ width: 200 })
  })

  it('releases failed initialization and propagates the original cause', () => {
    const cause = new Error('Geometry implementation failed')
    let failure: unknown

    try {
      registerLayoutRead(document, () => {
        throw cause
      }, [])
    } catch (error) {
      failure = error
    }

    expect(failure).toBeInstanceOf(Error)
    if (!(failure instanceof Error)) throw new Error('Expected initial measurement failure')
    expect(failure.cause).toBe(cause)

    const order: string[] = []
    const cleanup = registerLayoutRead(document, () => {
      order.push('read')

      return () => {
        order.push('publish')
      }
    }, [])

    expect(order).toEqual(['read', 'publish'])

    cleanup()
  })
  it('rejects a document without a browsing context', () => {
    const detached = document.implementation.createHTMLDocument()

    expect(() => registerLayoutRead(detached, () => () => {}, [])).toThrow('browsing context')
  })

  it('suppresses a cancelled frame callback and removes pending observation work', () => {
    const raf = vi.spyOn(window, 'requestAnimationFrame')
    const publications: string[] = []
    const cleanup = registerLayoutRead(
      document,
      () => () => {
        publications.push('publish')
      },
      [],
    )
    window.dispatchEvent(new Event('resize'))
    const callback = raf.mock.calls[0]?.[0]

    cleanup()
    if (!callback) throw new Error('Expected a scheduled read pass')
    callback(performance.now())

    expect(publications).toEqual(['publish'])

    raf.mockRestore()
  })

  it('retains independent registrations when a later registration fails initialization', () => {
    const cleanup = registerLayoutRead(document, () => () => {}, [])

    expect(() =>
      registerLayoutRead(document, () => {
        throw new Error('Failure')
      }, []),
    ).toThrow('Initial layout')

    cleanup()
  })

  it('does not continuously remeasure visual-only effects', async () => {
    const root = document.createElement('div')
    document.body.append(root)
    cleanups.push(() => root.remove())
    const animation = root.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 1000 })
    cleanups.push(() => animation.cancel())
    trackLayoutAnimation(root, 'opacity', animation)
    let reads = 0
    cleanups.push(
      registerLayoutRead(document, () => {
        reads++

        return () => {}
      }, [root]),
    )

    await settled()
    const previous = reads

    await settled()

    expect(reads).toBe(previous)
  })

  it('avoids duplicate lifetime listeners when the same layout effect is registered twice', () => {
    const root = document.createElement('div')
    document.body.append(root)
    cleanups.push(() => root.remove())
    const animation = root.animate([{ width: '10px' }, { width: '20px' }], { duration: 1000 })
    const listen = vi.spyOn(animation, 'addEventListener')
    cleanups.push(() => listen.mockRestore())
    cleanups.push(() => animation.cancel())
    trackLayoutAnimation(root, 'width', animation)
    const previous = listen.mock.calls.length

    trackLayoutAnimation(root, 'width', animation)

    expect(listen.mock.calls.length).toBe(previous)
  })

  it('detects removed style attributes in another document realm', async () => {
    const iframe = document.createElement('iframe')
    document.body.append(iframe)
    cleanups.push(() => iframe.remove())
    const otherDocument = iframe.contentDocument

    if (!otherDocument) throw new Error('Expected same-origin iframe document')

    const target = otherDocument.createElement('div')
    // Move without resizing so ResizeObserver cannot mask a missed attribute mutation.
    target.setAttribute('style', 'position:relative;left:100px')
    otherDocument.body.append(target)

    let publications = 0
    cleanups.push(
      registerLayoutRead(
        otherDocument,
        () => () => {
          publications++
        },
        [target],
      ),
    )

    await settled()
    const before = publications
    target.removeAttribute('style')

    await settled()

    expect(publications).toBe(before + 1)
  })
  it('tracks registered custom-property animations that move an unmeasured sibling', async () => {
    const property = `--measure-space-${crypto.randomUUID()}`
    CSS.registerProperty({
      name: property,
      syntax: '<length>',
      inherits: false,
      initialValue: '0px',
    })
    const root = document.createElement('div')
    root.style.cssText = 'width:300px;height:240px;'
    const sibling = document.createElement('div')
    sibling.style.height = `var(${property})`
    const target = document.createElement('div')
    target.style.cssText = 'width:100px;height:20px;'
    root.append(sibling, target)
    document.body.append(root)
    cleanups.push(() => root.remove())
    const source = measure({ target: { name: 'target' } })
    cleanups.push(
      source.bind(
        new Map([
          ['self', root],
          ['target', target],
        ]),
        () => {},
      ),
    )
    const initial = source.value
    if (typeof initial !== 'object' || typeof initial.y !== 'number')
      throw new Error('Expected bounds')
    const animation = sibling.animate([{ [property]: '0px' }, { [property]: '100px' }], {
      duration: 200,
      fill: 'both',
    })
    trackLayoutAnimation(sibling, property, animation)
    cleanups.push(() => animation.cancel())

    await settled()

    expect(source.value).not.toEqual(initial)

    animation.finish()

    await settled()

    expect(source.value).toMatchObject({ y: initial.y + 100, attached: true })
  })
})
