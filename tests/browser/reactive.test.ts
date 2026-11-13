import { test, expect } from '@playwright/test'
import { compile } from '../../packages/vite/wasm/liva_wasm.js'
import { decodeBundle } from '../../packages/runtime/src/model/definition.ts'
import type { RuntimeDiagnostic } from '../../packages/runtime/src/execution/instance.ts'
import derivedFixture from '../../fixtures/derived.json' with { type: 'json' }
import cardFixture from '../../fixtures/card.json' with { type: 'json' }
import toggleFixture from '../../fixtures/reactive-toggle.json' with { type: 'json' }

declare global {
  interface Window {
    dragScale: Animation
    letInstances: import('../../packages/runtime/src/execution/instance.ts').LivaInstance[]
  }
}

const base = 'http://127.0.0.1:4180'

test('HMR derives an aliased controller address from inactive property bindings', async ({
  page,
}) => {
  const definitions = ['width', 'height'].map(
    (property) =>
      decodeBundle(
        compile(
          `
    motion mapped(input: number, active: boolean) {
      let alias = movement
      let movement = link(input: input)
      layer base { width: 100px; height: 200px }
      layer direct when active { ${property} := alias }
    }
  `,
          false,
        ),
      ).definitions[0],
  )

  await page.goto('/tests/browser/')
  await page.waitForFunction(() => !!window.liva)

  const result = await page.evaluate(([before, after]) => {
    const element = document.createElement('div')
    document.body.append(element)
    const errors: RuntimeDiagnostic[] = []
    const inputs = { input: 0, active: false }
    const instance = new window.liva.LivaInstance(before, inputs, (error) => errors.push(error))

    try {
      instance.bind([['self', element]])
      instance.updateParameters({ ...inputs, active: true, input: 10 })
      instance.updateParameters({ ...inputs, active: true, input: 30 })
      const controlledWidth = getComputedStyle(element).width

      instance.updateParameters({ ...inputs, input: 30 })
      instance.replaceDefinition(after)
      instance.updateParameters({ ...inputs, active: true, input: 30 })
      instance.updateParameters({ ...inputs, active: true, input: 40 })

      return {
        controlledWidth,
        width: getComputedStyle(element).width,
        height: getComputedStyle(element).height,
        errors,
      }
    } finally {
      instance.dispose()
      element.remove()
    }
  }, definitions)

  expect(result).toEqual({ controlledWidth: '120px', width: '100px', height: '210px', errors: [] })
})

test('component expressions reject invalid updates without changing the controlled pose', async ({
  page,
}) => {
  const compiledDefinition = decodeBundle(
    compile(
      `motion mapped(axis: string, input: number, active: boolean) {
  let selected = axis
  let movement = link(input: input, component: selected)
  layer base { translate: 100px 20px 3px }
  layer direct when active { translate := movement }
}`,
      false,
    ),
  ).definitions[0]

  expect(compiledDefinition).toBeDefined()

  await page.goto('/tests/browser/')
  await page.waitForFunction(() => !!window.liva)

  const result = await page.evaluate((definition) => {
    const element = document.createElement('div')
    element.style.cssText = 'width:20px;height:20px'
    document.body.append(element)

    const errors: RuntimeDiagnostic[] = []
    const inputs = { axis: 'x', input: 0, active: false }
    const instance = new window.liva.LivaInstance(definition, inputs, (error) => errors.push(error))
    const readTranslate = () =>
      getComputedStyle(element)
        .translate.split(/\s+/)
        .map((part) => parseFloat(part))

    try {
      instance.bind([['self', element]])
      instance.updateParameters({ ...inputs, active: true })
      instance.updateParameters({ ...inputs, active: true, input: 10 })

      const moved = readTranslate()
      const rejected = ['y', 'z'].map((axis) => {
        instance.updateParameters({ ...inputs, active: true, axis, input: 50 })

        return readTranslate()
      })

      // Rejected updates must preserve the accepted axis and relative-control baseline.
      instance.updateParameters({ ...inputs, active: true, input: 20 })

      return {
        moved,
        rejected,
        recovered: readTranslate(),
        errors: errors.map(({ code, message }) => ({ code, message })),
      }
    } finally {
      instance.dispose()
      element.remove()
    }
  }, compiledDefinition)

  expect(result.moved).toEqual([110, 20, 3])
  expect(result.rejected).toEqual([
    [110, 20, 3],
    [110, 20, 3],
  ])
  expect(result.recovered).toEqual([120, 20, 3])
  expect(result.errors.map((error) => error.code)).toEqual([
    'runtime.expression',
    'runtime.expression',
  ])
  expect(result.errors[0].message).toContain('component and input shape are fixed')
  expect(result.errors[1].message).toContain('component must be x or y')
})

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
  await expect
    .poll(() => page.evaluate(() => window.instance.composition.states.interaction))
    .toBe('dragging')
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
      state: instance.composition.states.interaction,
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
    return {
      state: window.instance.composition.states.interaction,
      captured: window.track.hasPointerCapture(id),
    }
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

test('parameter updates select states and repeated values retain running effects', async ({
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
    instance.updateParameters({ checked: true })
    const animations = [...instance.animations]
    instance.updateParameters({ checked: true })
    const snapshot = {
      state: instance.composition.states.toggle,
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
  await page.goto(`${base}/drag`)
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
    editor.endPreview()
  })
  expect(await page.evaluate(() => window.__LIVA_EDITOR__.selected?.binding.definition.name)).toBe(
    'card',
  )
  expect(await page.evaluate(() => window.__LIVA_EDITOR__.message)).toContain(
    'Saving updates the shared source',
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
    expect(await page.evaluate(() => window.instance.composition.states.interaction)).toBe(
      'dragging',
    )

    const snapshot = await page.evaluate((action) => {
      const { instance, track } = window
      const id = Number(track.dataset.pointer)
      if (action === 'lost') track.releasePointerCapture(id)
      else if (action === 'rebind') {
        instance.bind([])
        instance.bind([['body', track]])
      } else {
        instance.replaceDefinition(instance.definition)
      }
      return {
        captured: track.hasPointerCapture(id),
        selected: instance.composition.states.interaction,
      }
    }, operation)
    expect(snapshot.captured).toBe(false)
    if (operation !== 'lost') expect(snapshot.selected).toBe('idle')

    await page.mouse.up()
    await expect
      .poll(() => page.evaluate(() => window.instance.composition.states.interaction))
      .toBe('idle')
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
    const dynamic = definition.layers[0].states![1].targets[0].properties[0]
    Object.assign(dynamic, {
      value: {
        kind: 'template',
        parts: [
          {
            kind: 'binary',
            operator: '/',
            left: { kind: 'number', value: 100 },
            right: { kind: 'reference', path: ['movement', 'offset', 'x'] },
          },
          'px 0',
        ],
      },
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
  expect(await page.evaluate(() => window.instance.composition.states.interaction)).toBe('idle')
  await page.mouse.move(x + 20, y)
  await expect
    .poll(() => page.evaluate(() => window.instance.composition.states.interaction))
    .toBe('dragging')
  await page.mouse.move(x + 25, y)
  expect(
    await page.locator('#card').evaluate((element) => getComputedStyle(element).translate),
  ).toBe('4px')

  await page.mouse.move(x, y)
  expect(
    await page.locator('#card').evaluate((element) => getComputedStyle(element).translate),
  ).toBe('4px')
  await page.mouse.up()
  await expect
    .poll(() => page.evaluate(() => window.instance.composition.states.interaction))
    .toBe('idle')
  await expect.poll(() => page.evaluate(() => window.instance.animations.length)).toBe(0)
  expect(
    await page.evaluate(() => window.errors.every((error) => error.code === 'runtime.expression')),
  ).toBe(true)
})

test('typed parameter instances update CSS independently and retain values after invalid updates', async ({
  page,
}) => {
  await page.goto('/tests/browser/')
  await page.waitForFunction(() => !!window.liva)
  const result = await page.evaluate(() => {
    const definition: import('../../packages/runtime/src/model/definition.ts').Definition = {
      name: 'progress',
      parameters: [
        { name: 'progress', type: 'number' },
        { name: 'label', type: 'string' },
        { name: 'enabled', type: 'boolean' },
      ],
      layers: [
        {
          name: 'idle',
          targets: [
            {
              name: 'body',
              properties: [
                {
                  name: 'translate',
                  value: {
                    kind: 'template',
                    parts: [{ kind: 'reference', path: ['progress'] }, 'px 0'],
                  },
                },
                {
                  name: '--label',
                  value: {
                    kind: 'template',
                    parts: [{ kind: 'reference', path: ['label'] }],
                  },
                },
              ],
            },
          ],
        },
      ],
    }
    const elements = [document.createElement('div'), document.createElement('div')]
    const errors: string[] = []
    const instances = elements.map((element, index) => {
      document.body.append(element)
      const instance = new window.liva.LivaInstance(
        definition,
        { progress: index + 1, label: 'initial', enabled: false },
        (error) => errors.push(error.code),
      )
      instance.bind([['body', element]])
      return instance
    })

    instances[0].updateParameters({ progress: 25, label: 'updated', enabled: true })
    instances[0].updateParameters({ progress: Infinity, label: 'invalid', enabled: true })
    instances[0].updateParameters({ unknown: true })
    instances[0].replaceDefinition(definition)
    const snapshot = elements.map((element) => ({
      translate: element.style.translate,
      label: element.style.getPropertyValue('--label'),
    }))

    for (const instance of instances) instance.dispose()
    for (const element of elements) element.remove()
    return { snapshot, errors }
  })

  expect(result).toEqual({
    snapshot: [
      { translate: '25px', label: 'updated' },
      { translate: '2px', label: 'initial' },
    ],
    errors: ['runtime.parameter', 'runtime.parameter'],
  })
})

test('missing parameters reject creation, updates and incompatible replacements without disturbing effects', async ({
  page,
}) => {
  await page.goto('/tests/browser/')
  await page.waitForFunction(() => !!window.liva)
  const result = await page.evaluate((fixture) => {
    const definition = window.liva.decodeBundle(JSON.stringify(fixture)).definitions[0]
    const failures: string[] = []

    for (const input of [undefined, {}, 'off']) {
      try {
        const unexpected = new window.liva.LivaInstance(
          definition,
          // Exercise the JavaScript boundary with a removed string binding.
          input,
        )
        unexpected.dispose()
      } catch (error) {
        failures.push(String(error))
      }
    }

    const track = document.createElement('div')
    const thumb = document.createElement('div')
    track.append(thumb)
    document.body.append(track)
    const diagnostics: string[] = []
    const instance = new window.liva.LivaInstance(definition, { checked: false }, (error) =>
      diagnostics.push(error.message),
    )
    instance.bind([
      ['track', track],
      ['thumb', thumb],
    ])
    instance.updateParameters({ checked: true })
    const animations = [...instance.animations]

    instance.updateParameters({})

    for (const parameters of [
      [...definition.parameters!, { name: 'added', type: 'number' as const }],
      [{ name: 'checked', type: 'number' as const }],
    ]) {
      try {
        instance.replaceDefinition({ ...definition, parameters })
      } catch (error) {
        failures.push(String(error))
      }
    }

    const retained = {
      definition: instance.definition === definition,
      state: instance.composition.states.toggle,
      selected: instance.composition.states.toggle,
      effects:
        animations.length > 0 &&
        animations.every((animation, index) => instance.animations[index] === animation),
    }
    instance.updateParameters({ checked: false })
    const recovered = instance.composition.states.toggle

    instance.dispose()
    track.remove()
    return { failures, diagnostics, retained, recovered }
  }, toggleFixture)

  expect(result.failures).toEqual([
    'Error: Missing motion parameter: checked',
    'Error: Missing motion parameter: checked',
    'Error: Motion inputs must be a parameter object',
    'Error: Missing motion parameter: added',
    'Error: Motion parameter checked requires number',
  ])
  expect(result.diagnostics).toEqual(['Error: Missing motion parameter: checked'])
  expect(result.retained).toEqual({ definition: true, state: 'on', selected: 'on', effects: true })
  expect(result.recovered).toBe('off')
})

test('built-in subscriptions keep instance-local values across definition replacement', async ({
  page,
}) => {
  await page.goto('/tests/browser/')
  await page.waitForFunction(() => !!window.liva)
  await page.evaluate((fixture) => {
    const definition = structuredClone(
      window.liva.decodeBundle(JSON.stringify(fixture)).definitions[0],
    )
    Object.assign(
      definition.layers[0].targets[0].properties[0],
      definition.layers[0].states![1].targets[0].properties[0],
    )
    const instances = [0, 1].map((index) => {
      const element = document.createElement('div')
      element.id = `source-card-${index}`
      element.style.cssText = 'width:150px;height:100px;margin:30px;touch-action:none'
      document.body.append(element)
      const instance = new window.liva.LivaInstance(definition, {}, (error) =>
        window.errors.push(error),
      )
      instance.bind([['body', element]])
      return instance
    })
    Object.assign(window, { letInstances: instances })
  }, cardFixture)
  const first = page.locator('#source-card-0')
  const second = page.locator('#source-card-1')
  const box = (await first.boundingBox())!

  await page.mouse.move(box.x + 20, box.y + 20)
  await page.mouse.down()
  await page.mouse.move(box.x + 90, box.y + 50)
  await expect(first).toHaveCSS('translate', '70px 30px')
  await expect(second).toHaveCSS('translate', '0px')

  await page.evaluate(() => {
    const instance = window.letInstances[0]
    instance.replaceDefinition(instance.definition)
  })
  await page.mouse.up()

  await expect(first).toHaveCSS('translate', '70px 30px')
  expect(
    await page.evaluate(() =>
      window.letInstances.map((instance) => instance.composition.states.interaction),
    ),
  ).toEqual(['idle', 'idle'])

  const secondBox = (await second.boundingBox())!
  await page.mouse.move(secondBox.x + 20, secondBox.y + 20)
  await page.mouse.down()
  await page.mouse.move(secondBox.x + 50, secondBox.y + 30)
  await expect(second).toHaveCSS('translate', '30px 10px')
  await expect(first).toHaveCSS('translate', '70px 30px')
  await page.mouse.up()

  await page.evaluate(() => {
    for (const instance of window.letInstances) instance.dispose()
  })
  expect(await page.evaluate(() => window.errors)).toEqual([])
})

test('derived let bindings follow parameters and drag through aliases and preserve valid updates', async ({
  page,
}) => {
  await page.goto('/tests/browser/')
  await page.waitForFunction(() => !!window.liva)
  await page.evaluate((fixture) => {
    const definition = window.liva.decodeBundle(JSON.stringify(fixture)).definitions[0]
    const instances = [0, 1].map((index) => {
      const element = document.createElement('div')
      element.id = `derived-${index}`
      element.style.cssText = 'width:150px;height:100px;margin:30px;touch-action:none'
      document.body.append(element)
      const instance = new window.liva.LivaInstance(
        definition,
        { progress: 10, divisor: 1 },
        (error) => window.errors.push(error),
      )
      instance.bind([['body', element]])
      return instance
    })
    Object.assign(window, { letInstances: instances })
  }, derivedFixture)
  const first = page.locator('#derived-0')
  const second = page.locator('#derived-1')
  await expect(first).toHaveCSS('translate', '10px')
  const box = (await first.boundingBox())!

  await page.mouse.move(box.x + 20, box.y + 20)
  await page.mouse.down()
  await page.mouse.move(box.x + 60, box.y + 20)
  await expect(first).toHaveCSS('translate', '50px')
  expect(await page.evaluate(() => window.letInstances[0].composition.layers.dragging)).toBe(true)

  await page.evaluate(() => window.letInstances[0].updateParameters({ progress: 20, divisor: 1 }))
  await expect(first).toHaveCSS('translate', '60px')
  await page.mouse.move(box.x + 70, box.y + 20)
  await expect(first).toHaveCSS('translate', '70px')

  await page.evaluate(() => window.letInstances[0].updateParameters({ progress: 20, divisor: 0 }))
  await expect(first).toHaveCSS('translate', '70px')
  await page.evaluate(() => window.letInstances[0].updateParameters({ progress: 30, divisor: 1 }))
  await expect(first).toHaveCSS('translate', '80px')
  await page.mouse.up()
  expect(await page.evaluate(() => window.letInstances[0].composition.layers.dragging)).toBe(false)

  await page.evaluate(() => {
    const instance = window.letInstances[0]
    instance.replaceDefinition(instance.definition)
  })
  await expect(first).toHaveCSS('translate', '80px')
  await expect(second).toHaveCSS('translate', '10px')
  expect(await page.evaluate(() => window.errors.map((error) => error.code))).toEqual([
    'runtime.expression',
  ])

  await page.evaluate(() => {
    for (const instance of window.letInstances) instance.dispose()
  })
})
