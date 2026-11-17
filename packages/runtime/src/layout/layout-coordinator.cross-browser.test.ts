import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { assembleRuntime } from '../__test__/helpers/assembly.ts'
import type { Definition } from '../model/definition.ts'
import { LayoutCoordinator } from './layout-coordinator.ts'

const cleanups: (() => void)[] = []
let time: number
let callbacks: Map<number, FrameRequestCallback>
let nextFrame = 0

beforeEach(() => {
  time = 1000
  callbacks = new Map()
  vi.spyOn(performance, 'now').mockImplementation(() => time)
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    callbacks.set(++nextFrame, callback)
    return nextFrame
  })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
    callbacks.delete(id)
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).toReversed()) cleanup()
})

function frame(milliseconds: number) {
  time += milliseconds
  const pending = [...callbacks.values()]
  callbacks.clear()
  for (const callback of pending) callback(time)
}

function fixture(
  options: {
    source?: Definition
    element?: HTMLElement
    bindings?: readonly (readonly [string, HTMLElement])[]
  } = {},
) {
  const source: Definition = options.source ?? {
    name: 'item',
    layers: [
      {
        name: 'base',
        targets: [
          {
            name: 'self',
            properties: [
              {
                kind: 'layout',
                name: '$layout',
                axes: { x: true, y: true, width: true, height: true },
                timing: { kind: 'tween', durationMs: 1000, easing: 'linear' },
              },
            ],
          },
        ],
      },
    ],
  }
  const root = options.element ?? document.createElement('div')
  if (!options.element) root.style.cssText = 'width:100px;height:40px'
  document.body.append(root)
  const failures: unknown[] = []
  const assembly = assembleRuntime(source)
  assembly.executor.bind([['self', root], ...(options.bindings ?? [])])
  const coordinator = new LayoutCoordinator((error) => failures.push(error))
  const release = coordinator.register(assembly.executor)
  coordinator.begin()
  coordinator.finish()
  cleanups.push(() => {
    coordinator.dispose()
    assembly.runtime.dispose()
    root.remove()
  })

  function resize(width: number) {
    coordinator.begin()
    root.style.width = `${width}px`
    coordinator.finish()
  }

  return { coordinator, root, assembly, release, failures, resize }
}

describe('LayoutCoordinator failure and registration ownership', () => {
  it('propagates destination capture failure, releases generated output and can accept a later transaction', () => {
    const { coordinator, root, failures, resize } = fixture()
    resize(200)
    coordinator.begin()
    root.style.width = '300px'
    const cause = new Error('Destination capture failed')
    vi.spyOn(root, 'getBoundingClientRect').mockImplementationOnce(() => {
      throw cause
    })
    let caught: unknown

    try {
      coordinator.finish()
    } catch (error) {
      caught = error
    }

    expect(caught).toBe(cause)
    expect(root.style.transform).toBe('')
    expect(callbacks.size).toBe(0)
    expect(root.getAnimations()).toEqual([])
    resize(400)
    expect(root.getBoundingClientRect().width).toBeCloseTo(300, 3)
    frame(1000)
    expect(root.getBoundingClientRect().width).toBeCloseTo(400, 3)
    expect(failures).toEqual([])
  })

  it('monitors playback output failure with original identity and cancels retained work', () => {
    const { root, failures, resize } = fixture()
    resize(200)
    const cause = new Error('Projection output failed')
    vi.spyOn(root.style, 'setProperty').mockImplementationOnce(() => {
      throw cause
    })

    frame(250)

    expect(failures).toEqual([cause])
    expect(root.style.transform).toBe('')
    expect(callbacks.size).toBe(0)
    const read = vi.spyOn(root, 'getBoundingClientRect')
    frame(250)
    expect(read).not.toHaveBeenCalled()
  })

  it('releases an active registration without affecting the remaining app lifetime', () => {
    const { root, coordinator, release, resize, failures } = fixture()
    resize(200)
    expect(root.style.transform).not.toBe('')

    release()

    expect(callbacks.size).toBe(0)
    expect(root.style.transform).toBe('')
    coordinator.begin()
    coordinator.finish()
    frame(1000)
    expect(root.style.transform).toBe('')
    expect(failures).toEqual([])
  })
  it('retains failed style restoration for later owner cleanup and reports both causes', () => {
    const { root, assembly, failures, resize } = fixture()
    resize(200)
    const cause = new Error('Projection output failed')
    const cleanupCause = new Error('Restoration failed')
    vi.spyOn(root.style, 'setProperty').mockImplementationOnce(() => {
      throw cause
    })
    vi.spyOn(root.style, 'cssText', 'set').mockImplementationOnce(() => {
      throw cleanupCause
    })

    frame(250)

    expect(failures).toHaveLength(2)
    expect(failures[0]).toBeInstanceOf(AggregateError)
    expect(failures[0]).toMatchObject({ cause, errors: [cause, cleanupCause] })
    expect(failures[1]).toBe(cause)
    expect(callbacks.size).toBe(0)
    assembly.runtime.dispose()
    expect(root.style.transform).toBe('')
    expect(root.getAnimations()).toEqual([])
  })
  it('settles when installing generated output makes a receiver boxless', () => {
    const { root, failures, resize } = fixture()
    root.dataset.item = ''
    const style = document.createElement('style')
    style.textContent = '[data-item][style*="transform"] { display: none; }'
    document.body.append(style)
    cleanups.push(() => style.remove())

    resize(200)

    expect(root.style.transform).toBe('')
    expect(root.getBoundingClientRect().width).toBeCloseTo(200, 3)
    expect(callbacks.size).toBe(0)
    expect(failures).toEqual([])
  })
  it('settles finite authored transforms whose cumulative physical frame cannot be represented', () => {
    const { root, resize, failures } = fixture()
    let outer = root
    for (let depth = 0; depth < 10; depth++) {
      const ancestor = document.createElement('div')
      ancestor.style.cssText = 'width:300px;height:200px;transform:scale(1e38);transform-origin:0 0'
      outer.replaceWith(ancestor)
      ancestor.append(outer)
      outer = ancestor
    }
    cleanups.push(() => outer.remove())

    resize(200)

    expect(root.style.transform).toBe('')
    expect(callbacks.size).toBe(0)
    expect(failures).toEqual([])
  })

  it('settles an unrepresentable overridden basis while retaining authored individual scale', () => {
    const root = document.createElement('div')
    const elements = [root]
    const bindings: (readonly [string, HTMLElement])[] = []
    let parent = root
    for (let depth = 1; depth <= 85; depth++) {
      const child = document.createElement('div')
      parent.append(child)
      elements.push(child)
      bindings.push([`level${depth}`, child])
      parent = child
    }
    for (const element of elements)
      element.style.cssText =
        'width:100px;height:40px;scale:.0001;transform:scale(10000);transform-origin:0 0'
    const source: Definition = {
      name: 'deep',
      layers: [
        {
          name: 'base',
          targets: ['self', ...bindings.map(([name]) => name)].map((name) => ({
            name,
            properties: [
              {
                kind: 'layout',
                name: '$layout',
                axes: { x: true, y: true, width: true, height: true },
                timing: { kind: 'tween', durationMs: 1000, easing: 'linear' },
              },
            ],
          })),
        },
      ],
    }
    const { coordinator, failures } = fixture({ source, element: root, bindings })

    coordinator.begin()
    for (const element of elements) element.style.width = '200px'
    coordinator.finish()

    expect(parent.style.transform).toBe('scale(10000)')
    expect(elements.every((element) => !/NaN|Infinity/.test(element.style.transform))).toBe(true)
    frame(1000)
    expect(elements.every((element) => element.style.scale === '0.0001')).toBe(true)
    expect(failures).toEqual([])
  })
})
