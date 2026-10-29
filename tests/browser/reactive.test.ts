import { test, expect } from '@playwright/test'
import cardFixture from '../../fixtures/card.json' with { type: 'json' }
import toggleFixture from '../../fixtures/reactive-toggle.json' with { type: 'json' }

declare global {
  interface Window {
    dragScale: Animation
  }
}

const base = 'http://127.0.0.1:4180'

test('drag follows input, preserves the scale effect, returns and can be interrupted', async ({
  page,
}) => {
  await page.goto('/tests/browser/')
  await page.waitForFunction(() => !!window.liva)
  await page.evaluate((fixture) => {
    const definition = window.liva.decodeBundle(JSON.stringify(fixture)).definitions[0]
    const element = document.createElement('div')
    element.id = 'card'
    element.style.cssText = 'width:200px;height:150px;touch-action:none;background:green'
    document.body.append(element)
    const instance = new window.liva.LivaInstance(definition, {}, (error) =>
      window.errors.push(error),
    )
    instance.bind([['body', element]])
    Object.assign(window, { instance, track: element })
  }, cardFixture)
  const card = page.locator('#card')
  const box = (await card.boundingBox())!
  const x = box.x + 30
  const y = box.y + 30

  await page.mouse.move(x, y)
  await page.mouse.down()
  await expect.poll(() => page.evaluate(() => window.instance.state)).toBe('dragging')
  await page.evaluate(() => {
    const scale = window.instance.animations.find((animation) =>
      (animation.effect instanceof KeyframeEffect ? animation.effect.getKeyframes() : []).some(
        (frame) => 'scale' in frame,
      ),
    )!
    scale.pause()
    scale.currentTime = 50
    Object.assign(window, { dragScale: scale })
  })
  await page.mouse.move(x + 80, y + 35)
  await page.mouse.move(x + 120, y + 45)
  expect(await card.evaluate((element) => getComputedStyle(element).translate)).toBe('120px 45px')
  expect(await page.evaluate(() => window.instance.animations.includes(window.dragScale))).toBe(
    true,
  )

  await page.mouse.up()
  const released = await page.evaluate(() => {
    const { instance, track } = window
    const translate = instance.animations.find((animation) =>
      (animation.effect instanceof KeyframeEffect ? animation.effect.getKeyframes() : []).some(
        (frame) => 'translate' in frame,
      ),
    )!
    translate.pause()
    translate.currentTime = 0
    return {
      state: instance.state,
      first:
        translate.effect instanceof KeyframeEffect
          ? translate.effect.getKeyframes()[0].translate
          : undefined,
      capture: track.hasPointerCapture(1),
    }
  })
  expect(released.state).toBe('idle')
  expect(released.first).toBe('120px 45px')
  expect(released.capture).toBe(false)

  const movedBox = (await card.boundingBox())!
  await page.mouse.move(movedBox.x + 30, movedBox.y + 30)
  await page.mouse.down()
  await page.mouse.move(movedBox.x + 65, movedBox.y + 50)
  expect(await card.evaluate((element) => getComputedStyle(element).translate)).toBe('35px 20px')
  await page.mouse.up()
  await expect.poll(() => page.evaluate(() => window.instance.animations.length)).toBe(0)
  await expect(card).toHaveCSS('translate', '0px')
  await expect(card).toHaveCSS('scale', '1')
  expect(await page.evaluate(() => window.errors)).toEqual([])
})

test('pointer cancellation and disposal release capture and remove listeners', async ({ page }) => {
  await page.goto('/tests/browser/')
  await page.waitForFunction(() => !!window.liva)
  await page.evaluate((fixture) => {
    const element = document.createElement('div')
    element.id = 'card'
    element.style.cssText = 'width:200px;height:150px;touch-action:none'
    document.body.append(element)
    const instance = new window.liva.LivaInstance(
      window.liva.decodeBundle(JSON.stringify(fixture)).definitions[0],
      {},
    )
    instance.bind([['body', element]])
    element.addEventListener('pointerdown', (event) => {
      element.dataset.pointer = String(event.pointerId)
    })
    Object.assign(window, { instance, track: element })
  }, cardFixture)
  const box = (await page.locator('#card').boundingBox())!
  await page.mouse.move(box.x + 30, box.y + 30)
  await page.mouse.down()
  await page.mouse.move(box.x + 70, box.y + 50)
  const canceled = await page.evaluate(() => {
    const id = Number(window.track.dataset.pointer)
    window.track.dispatchEvent(new PointerEvent('pointercancel', { pointerId: id }))
    return { state: window.instance.state, captured: window.track.hasPointerCapture(id) }
  })
  expect(canceled).toEqual({ state: 'idle', captured: false })
  await page.mouse.up()
  await expect.poll(() => page.evaluate(() => window.instance.animations.length)).toBe(0)

  await page.mouse.move(box.x + 30, box.y + 30)
  await page.mouse.down()
  const disposed = await page.evaluate(() => {
    const id = Number(window.track.dataset.pointer)
    window.instance.dispose()
    return {
      captured: window.track.hasPointerCapture(id),
      animations: window.track.getAnimations().length,
      translate: window.track.style.translate,
    }
  })
  expect(disposed).toEqual({ captured: false, animations: 0, translate: '' })
  await page.mouse.up()
  await page.mouse.down()
  expect(
    await page.evaluate(() => window.track.hasPointerCapture(Number(window.track.dataset.pointer))),
  ).toBe(false)
  await page.mouse.up()
})

test('external updates select states and repeated values retain running effects', async ({
  page,
}) => {
  await page.goto('/tests/browser/')
  await page.waitForFunction(() => !!window.liva)
  const result = await page.evaluate((fixture) => {
    const track = document.createElement('div')
    const thumb = document.createElement('div')
    track.append(thumb)
    document.body.append(track)
    const instance = new window.liva.LivaInstance(
      window.liva.decodeBundle(JSON.stringify(fixture)).definitions[0],
      { checked: false },
    )
    instance.bind([
      ['track', track],
      ['thumb', thumb],
    ])
    instance.updateSources({ checked: true })
    const animations = [...instance.animations]
    instance.updateSources({ checked: true })
    const snapshot = {
      state: instance.state,
      same: animations.every((animation, index) => instance.animations[index] === animation),
    }
    instance.dispose()
    return snapshot
  }, toggleFixture)
  expect(result).toEqual({ state: 'on', same: true })
})

test('normal Vue playground includes a draggable card selectable in the editor', async ({
  page,
}) => {
  await page.goto(base)
  const card = page.getByTestId('draggable-card')
  await expect(card).toBeVisible()
  await card.scrollIntoViewIfNeeded()
  const box = (await card.boundingBox())!
  await page.mouse.move(box.x + 40, box.y + 40)
  await page.mouse.down()
  await page.mouse.move(box.x + 100, box.y + 70)
  expect(await card.evaluate((element) => getComputedStyle(element).translate)).toBe('60px 30px')
  await page.mouse.up()
  await expect(card).toHaveCSS('translate', '0px')

  await page.evaluate(async () => {
    const editor = window.__LIVA_EDITOR__
    const entry = [...editor.entries.values()].find(
      (item) => item.binding.definition.name === 'card',
    )!
    await editor.select(entry.id)
    await editor.preview('dragging', 'idle')
    editor.endPreview()
  })
  expect(await page.evaluate(() => window.__LIVA_EDITOR__.selected?.binding.definition.name)).toBe(
    'card',
  )
  await expect(card).toHaveCSS('scale', '1')
})

test('lost capture, target rebinding and editor replacement do not retain dragging state', async ({
  page,
}) => {
  await page.goto('/tests/browser/')
  await page.waitForFunction(() => !!window.liva)
  await page.evaluate((fixture) => {
    const element = document.createElement('div')
    element.id = 'card'
    element.style.cssText = 'width:200px;height:150px;touch-action:none'
    document.body.append(element)
    const definition = window.liva.decodeBundle(JSON.stringify(fixture)).definitions[0]
    const instance = new window.liva.LivaInstance(definition, {})
    element.addEventListener('pointerdown', (event) => {
      element.dataset.pointer = String(event.pointerId)
    })
    instance.bind([['body', element]])
    Object.assign(window, { instance, track: element })
  }, cardFixture)
  const box = (await page.locator('#card').boundingBox())!

  for (const operation of ['lost', 'rebind', 'replace'] as const) {
    await page.mouse.move(box.x + 30, box.y + 30)
    await page.mouse.down()
    expect(await page.evaluate(() => window.instance.state)).toBe('dragging')

    const snapshot = await page.evaluate((action) => {
      const { instance, track } = window
      const id = Number(track.dataset.pointer)
      if (action === 'lost') track.releasePointerCapture(id)
      else if (action === 'rebind') {
        instance.bind([])
        instance.bind([['body', track]])
      } else {
        instance.replaceDefinition(instance.definition, 'idle')
      }
      return { captured: track.hasPointerCapture(id), selected: instance.sourceState }
    }, operation)
    expect(snapshot.captured).toBe(false)
    if (operation !== 'lost') expect(snapshot.selected).toBe('idle')

    await page.mouse.up()
    await expect.poll(() => page.evaluate(() => window.instance.sourceState)).toBe('idle')
    await expect.poll(() => page.evaluate(() => window.instance.animations.length)).toBe(0)
  }
})

test('dynamic errors retain the last valid value and inactive templates do not block transitions', async ({
  page,
}) => {
  await page.goto('/tests/browser/')
  await page.waitForFunction(() => !!window.liva)
  await page.evaluate((fixture) => {
    const original = window.liva.decodeBundle(JSON.stringify(fixture)).definitions[0]
    const definition = structuredClone(original)
    const dynamic = definition.states[1].targets[0].properties[0]
    Object.assign(dynamic, {
      template: [
        {
          kind: 'binary',
          operator: '/',
          left: { kind: 'number', value: 100 },
          right: { kind: 'reference', path: ['movement', 'offset', 'x'] },
        },
        'px 0',
      ],
    })
    const element = document.createElement('div')
    element.id = 'card'
    element.style.cssText = 'width:200px;height:150px;touch-action:none'
    document.body.append(element)
    const instance = new window.liva.LivaInstance(definition, {}, (error) =>
      window.errors.push(error),
    )
    instance.bind([['body', element]])
    Object.assign(window, { instance, track: element })
  }, cardFixture)
  const box = (await page.locator('#card').boundingBox())!
  const x = box.x + 30
  const y = box.y + 30

  await page.mouse.move(x, y)
  await page.mouse.down()
  expect(await page.evaluate(() => window.instance.state)).toBe('idle')
  await page.mouse.move(x + 20, y)
  await expect.poll(() => page.evaluate(() => window.instance.state)).toBe('dragging')
  await page.mouse.move(x + 25, y)
  expect(
    await page.locator('#card').evaluate((element) => getComputedStyle(element).translate),
  ).toBe('4px')

  await page.mouse.move(x, y)
  expect(
    await page.locator('#card').evaluate((element) => getComputedStyle(element).translate),
  ).toBe('4px')
  await page.mouse.up()
  await expect.poll(() => page.evaluate(() => window.instance.state)).toBe('idle')
  await expect.poll(() => page.evaluate(() => window.instance.animations.length)).toBe(0)
  expect(
    await page.evaluate(() => window.errors.every((error) => error.code === 'runtime.expression')),
  ).toBe(true)
})
