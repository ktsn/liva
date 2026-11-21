import { ProjectionReadBatch } from './projection-read.ts'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { readLayoutBounds, missingBounds } from './layout-bounds.ts'
import { measure } from '../builtins/measure.ts'

const cleanups: (() => void)[] = []

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

async function settle() {
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  )
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) cleanup()
})

describe('untransformed layout bounds', () => {
  it.each([
    ['content-box', 'border-box'],
    ['fill-box', 'border-box'],
    ['content-box', 'content-box'],
    ['fill-box', 'content-box'],
  ])('uses %s percentage translation references with %s sizing', (transformBox, boxSizing) => {
    const { root, target } = fixture()
    target.style.cssText += `box-sizing:${boxSizing};padding:3px 5px 9px 15px;transform-box:${transformBox};translate:50% 25%;`
    const bounds = readLayoutBounds(target, root)

    expect(bounds.x).toBeCloseTo(16.5, 3)
    expect(bounds.y).toBeCloseTo(16.5, 3)
    expect(bounds).toMatchObject({
      width: boxSizing === 'border-box' ? 120.25 : 144.25,
      height: boxSizing === 'border-box' ? 35.5 : 51.5,
      attached: true,
    })
  })

  it.each(['rotate:30deg', 'scale:2 .5', 'transform:skewX(20deg)'])(
    'diagnoses an ambiguous content-box pivot rather than publishing a wrong position: %s',
    (transform) => {
      const { root, target } = fixture()
      target.style.cssText += `padding:3px 5px 9px 15px;transform-box:content-box;transform-origin:20% 80%;${transform};`
      const reasons: string[] = []

      const bounds = readLayoutBounds(target, root, (reason) => reasons.push(reason))

      expect(bounds).toBe(missingBounds)
      expect(reasons).toEqual([
        'measure cannot resolve content-box transform origins for rotation, scale, or skew',
      ])
    },
  )

  it('allows content-box rotation when content and border boxes coincide', () => {
    const { root, target } = fixture()
    target.style.cssText +=
      'padding:0;border:0;transform-box:content-box;rotate:90deg;transform-origin:20% 80%;'

    const bounds = readLayoutBounds(target, root)

    expect(bounds.x).toBeCloseTo(16.5, 3)
    expect(bounds.y).toBeCloseTo(16.5, 3)
    expect(bounds.attached).toBe(true)
  })

  it.each(['matrix(1, 2, 2, 4, 0, 0)', 'scaleX(0)', 'scaleY(0)', 'scale(.000001)'])(
    'rejects singular or numerically collapsed transforms: %s',
    (transform) => {
      const { root, target } = fixture()
      target.style.transform = transform

      expect(readLayoutBounds(target, root)).toBe(missingBounds)
    },
  )

  it('diagnoses unresolved calc translation without publishing non-finite bounds', () => {
    const { root, target } = fixture()
    target.style.translate = 'calc(50% + 10px) 0px'
    const reasons: string[] = []

    const bounds = readLayoutBounds(target, root, (reason) => reasons.push(reason))

    expect(bounds).toBe(missingBounds)
    expect(reasons).toEqual(['measure supports two-dimensional numeric transforms'])
  })

  it('uses fractional border boxes relative to the reference padding origin', () => {
    const { root, target } = fixture()
    const bounds = readLayoutBounds(target, root)

    expect(bounds).toEqual({ x: 16.5, y: 16.5, width: 120.25, height: 35.5, attached: true })
    expect(readLayoutBounds(root, root)).toEqual({
      x: 0,
      y: 0,
      width: 320.5,
      height: 240.25,
      attached: true,
    })
  })

  it('removes nested rotations, scale and translation without changing application styles', () => {
    const { root, target } = fixture()
    const before = readLayoutBounds(target, root)
    root.style.transform = 'translate(13px, 11px) rotate(13deg) scale(1.2, 0.8)'
    target.style.translate = '50% 4px'
    target.style.rotate = '30deg'
    target.style.scale = '0.7 1.1'

    const transformed = readLayoutBounds(target, root)

    expect(transformed.x).toBeCloseTo(before.x, 3)
    expect(transformed.y).toBeCloseTo(before.y, 3)
    expect(transformed.width).toBe(before.width)
    expect(transformed.height).toBe(before.height)
    expect(root.style.transform).toContain('rotate(13deg)')
  })

  it.each(['.2rad', '20grad', '.1turn'])('removes authored angle units %s', (angle) => {
    const { root, target } = fixture()
    target.style.rotate = angle
    target.style.scale = '50%'
    target.style.translate = '25%'

    const bounds = readLayoutBounds(target, root)

    expect(bounds.x).toBeCloseTo(16.5, 3)
    expect(bounds.y).toBeCloseTo(16.5, 3)
  })

  it('measures content-box border dimensions without changing receiving box sizing', () => {
    const { root, target } = fixture()
    target.style.boxSizing = 'content-box'

    expect(readLayoutBounds(target, root)).toMatchObject({ width: 132.25, height: 47.5 })
  })

  it.each([
    ['display', 'inline'],
    ['transform-box', 'stroke-box'],
    ['perspective', '200px'],
    ['zoom', '2'],
    ['translate', '1px 2px 3px'],
    ['rotate', 'x 30deg'],
    ['scale', '1 1 2'],
    ['scale', '0'],
    ['transform', 'rotateY(30deg)'],
  ])('returns unattached for unsupported %s: %s', (property, value) => {
    const { root, target } = fixture()
    target.style.setProperty(property, value)

    expect(readLayoutBounds(target, root)).toBe(missingBounds)
  })

  it('removes page/reference/nested scrolling and retains physical axes in RTL', () => {
    const { root, target } = fixture()
    const nested = document.createElement('div')
    nested.style.cssText = 'width:180px;height:120px;overflow:auto;direction:rtl;'
    root.append(nested)
    nested.append(target)
    target.style.cssText += 'margin-left:300px;margin-top:300px;'
    const before = readLayoutBounds(target, root)

    root.scrollTop = 50
    nested.scrollTop = 60
    nested.scrollLeft = -50

    const after = readLayoutBounds(target, root)

    expect(after.x).toBeCloseTo(before.x, 4)
    expect(after.y).toBeCloseTo(before.y, 4)
    expect(after.attached).toBe(true)
  })

  it.each(['static', 'relative'])(
    'removes only effective scrolling through a %s intermediary',
    (position) => {
      const { root, target } = fixture()
      const scroller = document.createElement('div')
      scroller.style.cssText = `position:${position};width:160px;height:100px;overflow:auto;`
      const spacer = document.createElement('div')
      spacer.style.cssText = 'width:800px;height:800px;'
      root.append(scroller)
      scroller.append(spacer, target)
      target.style.cssText += 'position:absolute;left:60px;top:40px;'
      const before = readLayoutBounds(target, root)
      const projectedBefore = new ProjectionReadBatch().projection(target)

      scroller.scrollLeft = 30
      scroller.scrollTop = 50

      const after = readLayoutBounds(target, root)

      expect(after.x).toBeCloseTo(before.x, 4)
      expect(after.y).toBeCloseTo(before.y, 4)
      expect(after.attached).toBe(true)
      const projectedAfter = new ProjectionReadBatch().projection(target)

      if (!projectedBefore || !projectedAfter) throw new Error('Expected supported scroll frames')

      expect(projectedAfter.box.x).toBeCloseTo(projectedBefore.box.x, 4)
      expect(projectedAfter.box.y).toBeCloseTo(projectedBefore.box.y, 4)
    },
  )

  it('distinguishes missing/hidden boxes from measurable invisible or empty boxes', () => {
    const { root, target } = fixture()

    target.style.visibility = 'hidden'
    expect(readLayoutBounds(target, root).attached).toBe(true)

    target.style.width = '0'
    target.style.height = '0'
    target.style.padding = '0'
    target.style.border = '0'
    expect(readLayoutBounds(target, root)).toMatchObject({ width: 0, height: 0, attached: true })

    root.style.display = 'none'
    expect(readLayoutBounds(target, root)).toBe(missingBounds)

    root.style.display = 'block'
    target.remove()
    expect(readLayoutBounds(target, root)).toBe(missingBounds)
    expect(readLayoutBounds(undefined, root)).toBe(missingBounds)
  })

  it.each(['auto', '100px'])('rejects unresolved ruby dimensions with width %s', (width) => {
    const { root, target } = fixture()
    target.style.cssText = `display:ruby;width:${width};height:auto;`
    target.textContent = 'Ruby layout'

    expect(readLayoutBounds(target, root)).toBe(missingBounds)
  })

  it('returns unattached without a connected reference', () => {
    const { target } = fixture()
    const reference = document.createElement('div')

    expect(readLayoutBounds(target, undefined)).toBe(missingBounds)
    expect(readLayoutBounds(target, reference)).toBe(missingBounds)
  })

  it('rejects cross-branch and unsupported positioning', () => {
    const { root, target } = fixture()
    const other = document.createElement('div')
    root.append(other)

    expect(readLayoutBounds(target, other)).toBe(missingBounds)

    target.style.position = 'fixed'
    expect(readLayoutBounds(target, root)).toBe(missingBounds)

    target.style.position = 'sticky'
    expect(readLayoutBounds(target, root)).toBe(missingBounds)
  })
})

describe('reactive layout measurements', () => {
  it('initializes synchronously and detects sibling-induced position changes', async () => {
    const { root, target } = fixture()
    const sibling = document.createElement('div')
    sibling.style.height = '20px'
    root.prepend(sibling)
    const source = measure({ target: { name: 'item' } })
    let notifications = 0
    const cleanup = source.bind(
      new Map([
        ['self', root],
        ['item', target],
      ]),
      () => {
        notifications++
      },
    )
    cleanups.push(cleanup)

    expect(source.value).toMatchObject({ x: 16.5, y: 36.5, attached: true })

    await settle()
    const previous = notifications
    sibling.style.height = '40px'
    sibling.textContent = 'Changed content'

    await settle()

    expect(source.value).toMatchObject({ y: 56.5 })
    expect(notifications).toBe(previous + 1)
  })

  it('suppresses unchanged and transform/scroll-only updates and stops on cleanup', async () => {
    const { root, target } = fixture()
    const source = measure({ target: { name: 'item' } })
    let notifications = 0
    const cleanup = source.bind(
      new Map([
        ['self', root],
        ['item', target],
      ]),
      () => {
        notifications++
      },
    )
    cleanups.push(cleanup)

    await settle()
    const previous = notifications
    target.style.translate = '40px 20px'
    root.scrollTop = 10

    await settle()

    expect(notifications).toBe(previous)

    target.style.width = '140.5px'

    await settle()

    expect(source.value).toMatchObject({ width: 140.5 })
    const updated = notifications
    cleanup()
    target.style.width = '160px'

    await settle()

    expect(notifications).toBe(updated)
  })
  it('publishes absence and reattachment, using explicit target/reference aliases', async () => {
    const { root, target } = fixture()
    const source = measure({ target: { name: 'item' }, relativeTo: { name: 'root' } })
    const bindings = new Map([
      ['root', root],
      ['item', target],
    ])
    let notifications = 0
    const cleanup = source.bind(bindings, () => {
      notifications++
    })
    cleanups.push(cleanup)

    target.remove()

    await settle()

    expect(source.value).toBe(missingBounds)

    root.append(target)

    await settle()

    expect(source.value).toMatchObject({ attached: true, width: 120.25 })
    expect(notifications).toBe(2)

    cleanup()

    expect(source.value).toBe(missingBounds)
  })

  it('falls back when a named target is absent while the root remains bound', () => {
    const { root } = fixture()
    const source = measure({ target: { name: 'absent' } })
    cleanups.push(source.bind(new Map([['self', root]]), () => {}))

    expect(source.value).toBe(missingBounds)
  })
  it('diagnoses unsupported geometry once and recovers when it becomes readable', async () => {
    const { root, target } = fixture()
    target.style.rotate = 'x 30deg'
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const source = measure({ target: { name: 'item' } })
    cleanups.push(() => warning.mockRestore())
    cleanups.push(
      source.bind(
        new Map([
          ['self', root],
          ['item', target],
        ]),
        () => {},
      ),
    )

    expect(source.value).toBe(missingBounds)
    expect(warning).toHaveBeenCalledTimes(1)

    target.style.width = '140px'

    await settle()

    expect(warning).toHaveBeenCalledTimes(1)

    target.style.rotate = 'none'
    target.style.width = '150px'

    await settle()

    expect(source.value).toMatchObject({ width: 150, attached: true })
  })

  it('cancels queued publication notifications when another registration removes it', async () => {
    const { root, target } = fixture()
    const source = measure({ target: { name: 'item' } })
    let notifications = 0
    const cleanup = source.bind(
      new Map([
        ['self', root],
        ['item', target],
      ]),
      () => {
        notifications++
      },
    )
    cleanups.push(cleanup)
    const { registerLayoutRead } = await import('./layout-scheduler.ts')
    let cancel = false
    cleanups.push(
      registerLayoutRead(
        document,
        () => () => {
          if (cancel) cleanup()
        },
        [root],
      ),
    )

    await settle()
    target.style.width = '150px'
    cancel = true

    await settle()

    expect(notifications).toBe(0)
    expect(source.value).toBe(missingBounds)
  })

  it('updates when inline layout styles are removed', async () => {
    const { root, target } = fixture()
    const source = measure({ target: { name: 'item' } })
    cleanups.push(
      source.bind(
        new Map([
          ['self', root],
          ['item', target],
        ]),
        () => {},
      ),
    )

    await settle()

    target.removeAttribute('style')

    await settle()

    expect(source.value).toMatchObject({ width: 281.5, attached: true })
  })
})
