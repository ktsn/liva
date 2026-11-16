import {
  assembleRuntime,
  nativeEffects,
  type RuntimeAssembly,
} from '../../../../runtime/src/__test__/helpers/assembly.ts'
import { afterEach, expect, it, vi } from 'vite-plus/test'
import { cdp, userEvent } from 'vite-plus/test/browser'
import type { CDPSession } from '@vitest/browser-playwright'
import { createApp, nextTick, type App } from 'vue'
import { decodeBundle, layerTargets, type RuntimeDiagnostic } from '@liva/runtime'
import fixture from '../../../../../fixtures/toggle.json'
import EditorPanel from '../components/EditorPanel.ce.vue'
import TimingControls from '../components/TimingControls.ce.vue'
import type { Definition, Timing } from '@liva/runtime'
import { EditorController } from '../controller.ts'
import type { EditorRequest, EditorReply } from '../communication/protocol.ts'

const toggleFields: EditorReply['fields'] = [
  { path: 'toggle/layer/toggle/target/track/property/background-color', kind: 'block', value: '' },
  {
    path: 'toggle/layer/toggle/target/track/property/background-color/value',
    kind: 'value',
    value: '#888',
  },
]

let app: App | undefined
let host: HTMLElement | undefined
let runtime: RuntimeAssembly | undefined

afterEach(() => {
  app?.unmount()
  runtime?.runtime.dispose()
  host?.remove()
})

async function tick() {
  await nextTick()
  await Promise.resolve()
  await nextTick()
}

function button(text: string) {
  const found = [...host!.querySelectorAll('button')].find(
    (element) => element.textContent?.trim() === text,
  )

  if (!found) throw new Error(`Missing button: ${text}`)

  return found
}

async function click(text: string) {
  button(text).click()

  await tick()
}

async function input(label: string, value: string) {
  const field = host!.querySelector<HTMLInputElement | HTMLSelectElement>(`[aria-label="${label}"]`)

  if (!field) throw new Error(`Missing input: ${label}`)

  field.value = value
  field.dispatchEvent(new Event(field.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))

  await tick()
}

function selectValue(label: string): string {
  const field = host?.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`)

  if (!field) throw new Error(`Missing select: ${label}`)

  return field.value
}

async function setupEditor(
  send?: ConstructorParameters<typeof EditorController>[0],
  definition = decodeBundle(JSON.stringify(fixture)).definitions[0],
  inputs: Record<string, unknown> = definition.parameters?.some(
    (parameter) => parameter.name === 'mode',
  )
    ? { mode: 'off' }
    : {},
  fields: EditorReply['fields'] = [],
) {
  const controller = new EditorController(
    send ??
      (async (request) => ({
        hash: 'original',
        definition,
        fields,
        sequence: request.sequence,
      })),
  )

  host = document.createElement('div')
  host.setAttribute('aria-label', 'Test motion')
  document.body.append(host)
  const diagnostics: RuntimeDiagnostic[] = []
  runtime = assembleRuntime(definition, inputs, (diagnostic) => diagnostics.push(diagnostic))
  controller.observe('mount', {
    label: 'Test motion',
    bounds: () => {
      const { top, bottom, left, right, width, height } = host!.getBoundingClientRect()
      return { top, bottom, left, right, width, height }
    },
    runtime: runtime.runtime,
    inspection: runtime.inspection,
    definition,
    source: 'source',
  })
  runtime.executor.bind(
    [...new Set(layerTargets(definition).map((target) => target.name))].map((name) => {
      const element = document.createElement('div')

      host!.append(element)
      return [name, element] as const
    }),
  )

  const mountPoint = document.createElement('div')

  host.append(mountPoint)
  app = createApp(EditorPanel, { controller })
  app.mount(mountPoint)

  return { controller, definition, diagnostics }
}

it('keeps the editor usable when selected instance bounds are unavailable', async () => {
  const { controller } = await setupEditor()
  const binding = [...controller.entries.values()][0].binding
  const bounds = vi.spyOn(binding, 'bounds').mockReturnValue(undefined)
  const scroll = vi.spyOn(window, 'scrollBy')

  await click('Motion editor')
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

  expect(bounds).toHaveBeenCalled()
  expect(scroll).not.toHaveBeenCalled()
  expect(host!.querySelector('[aria-label="Liva motion editor"]')).not.toBeNull()

  bounds.mockRestore()
  scroll.mockRestore()
})

it('opens composition playback, scrubs and restores on close', async () => {
  const { controller } = await setupEditor()

  await click('Motion editor')
  await input('To toggle state', 'on')
  await click('Play')

  expect(controller.previewActive).toBe(true)

  await click('Pause')
  await input('Playhead', '100')
  await click('To start')
  await click('End preview')

  expect(controller.previewActive).toBe(false)

  await click('Close')

  expect(button('Motion editor')).toBeDefined()
  expect(runtime!.runtime.composition.states.toggle).toBe('off')
})

it('offers Instant with no interpolation fields and emits immediate timing', async () => {
  const timings: Timing[] = []
  host = document.createElement('div')
  document.body.append(host)
  app = createApp(TimingControls, {
    timing: { kind: 'tween', durationMs: 0, easing: 'ease' },
    onApply: (timing: Timing) => timings.push(timing),
  })
  app.mount(host)

  expect(selectValue('Timing mode')).toBe('instant')
  expect(host.querySelector('[aria-label="Track duration"]')).toBeNull()
  expect(host.querySelector('[aria-label="Track easing"]')).toBeNull()

  await input('Timing mode', 'tween')
  await input('Timing mode', 'instant')
  await click('Apply timing')

  expect(timings).toEqual([{ kind: 'tween', durationMs: 0, easing: 'linear' }])
})

it('changes speed and loop while playing without editing source', async () => {
  const { controller } = await setupEditor()

  await click('Motion editor')
  await input('To toggle state', 'on')
  await input('Speed', '0.1')
  await click('↻ Loop')
  await click('Play')
  await new Promise(requestAnimationFrame)

  await input('Speed', '0.5')
  await click('↻ Loop')
  await click('Pause')
  await input('Speed', '0.25')
  await click('↻ Loop')

  expect(controller.previewActive).toBe(true)
  expect(button('Play')).toBeDefined()
  expect(controller.draft).toEqual([])
})

it('retains playback preferences when the editor form remounts', async () => {
  await setupEditor()
  await click('Motion editor')
  await input('Speed', '0.25')
  await click('↻ Loop')

  await click('Close')
  await click('Motion editor')

  expect(selectValue('Speed')).toBe('0.25')
  expect(button('↻ Loop').getAttribute('aria-pressed')).toBe('true')
})

it('scrubbing pauses looping playback without clearing its preference', async () => {
  await setupEditor()
  await click('Motion editor')
  await click('↻ Loop')
  await click('Play')

  await input('Playhead', '50')

  expect(button('Play')).toBeDefined()
  expect(button('↻ Loop').getAttribute('aria-pressed')).toBe('true')
})

it('does not repeat zero-duration previews with loop enabled', async () => {
  await setupEditor(undefined, {
    name: 'instant',
    layers: [
      {
        name: 'base',
        targets: [
          {
            name: 'body',
            properties: [
              {
                name: 'opacity',
                value: {
                  kind: 'literal',
                  value: '1',
                },
              },
            ],
          },
        ],
      },
    ],
  })

  await click('Motion editor')
  await click('↻ Loop')
  await click('Play')
  await new Promise(requestAnimationFrame)
  await tick()

  expect(button('Play')).toBeDefined()
  const timer = host!.querySelector('[aria-label="Playback time"]')

  expect(timer).not.toBeNull()
  expect(timer!.textContent).toBe('0 / 0 ms')
})

it('edits duration and physics spring parameters through shared controls', async () => {
  const timings: Timing[] = []

  host = document.createElement('div')
  host.setAttribute('aria-label', 'Test motion')
  document.body.append(host)
  app = createApp(TimingControls, {
    onApply: (timing: Timing) => timings.push(timing),
  })
  app.mount(host)

  await input('Timing mode', 'spring-duration')

  const bounce = host.querySelector<HTMLInputElement>('input[step="0.01"]')!

  bounce.value = '0.4'
  bounce.dispatchEvent(new Event('input', { bubbles: true }))
  await click('Apply timing')

  expect(timings.at(-1)).toEqual({ kind: 'spring-duration', durationMs: 350, bounce: 0.4 })

  await input('Timing mode', 'spring-physics')

  const values = ['500', '30', '2']

  for (const [index, field] of [...host.querySelectorAll<HTMLInputElement>('input')].entries()) {
    field.value = values[index]
    field.dispatchEvent(new Event('input', { bubbles: true }))
  }

  await click('Apply timing')

  expect(timings.at(-1)).toEqual({ kind: 'spring-physics', stiffness: 500, damping: 30, mass: 2 })
})

it('reports preview, save and discard failures without discarding the draft', async () => {
  const definition = decodeBundle(JSON.stringify(fixture)).definitions[0]
  let failure = ''
  const { controller } = await setupEditor(async (request) => {
    if (failure) throw new Error(failure)

    return { hash: 'original', definition, fields: toggleFields, sequence: request.sequence }
  })

  await click('Motion editor')
  failure = 'Preview unavailable'
  await click('Play')

  expect(controller.message).toContain('Preview unavailable')
  expect(controller.previewActive).toBe(false)

  await click('▸ track')
  host!.querySelector<HTMLButtonElement>('[aria-label="Select track.background-color"]')!.click()

  await tick()

  failure = ''
  await input('Track duration', '450')
  await click('Apply timing')
  failure = 'Save unavailable'
  await click('Save to source')

  await expect.poll(() => controller.message).toContain('Save unavailable')
  expect(controller.draft).toHaveLength(1)

  failure = 'Inspect unavailable'
  await click('Discard changes')

  await expect.poll(() => controller.message).toContain('Inspect unavailable')

  await input('Preview instance', '')

  expect(controller.selected).toBeUndefined()
})

it('retains existing physics parameters when replacing timing through shared controls', async () => {
  const timings: Timing[] = []
  host = document.createElement('div')
  document.body.append(host)
  app = createApp(TimingControls, {
    timing: { kind: 'spring-physics', stiffness: 450, damping: 35, mass: 2 },
    onApply: (value: Timing) => timings.push(value),
  })
  app.mount(host)

  const dampingInput = host.querySelectorAll('input')[1]

  dampingInput.value = '40'
  dampingInput.dispatchEvent(new Event('input', { bubbles: true }))
  await click('Apply timing')

  expect(timings).toEqual([{ kind: 'spring-physics', stiffness: 450, damping: 40, mass: 2 }])
})

it('retains duration-spring bounce when replacing its duration', async () => {
  const timings: Timing[] = []
  host = document.createElement('div')
  document.body.append(host)
  app = createApp(TimingControls, {
    timing: { kind: 'spring-duration', durationMs: 400, bounce: 0.6 },
    onApply: (value: Timing) => timings.push(value),
  })
  app.mount(host)

  await input('Track duration', '500')
  await click('Apply timing')

  expect(timings).toEqual([{ kind: 'spring-duration', durationMs: 500, bounce: 0.6 }])
})

it('offers typed easing constants instead of a raw CSS input', async () => {
  const timings: Timing[] = []
  host = document.createElement('div')
  document.body.append(host)
  app = createApp(TimingControls, { onApply: (value: Timing) => timings.push(value) })
  app.mount(host)

  await input('Track easing', 'step-start')
  await click('Apply timing')

  expect(host.querySelector('[aria-label="Track easing"]')?.tagName).toBe('SELECT')
  expect(timings.at(-1)).toMatchObject({ kind: 'tween', easing: 'step-start' })
})

it('plays to completion, restarts at the end and saves synchronized edits', async () => {
  const { controller } = await setupEditor(undefined, undefined, undefined, toggleFields)

  await click('Motion editor')
  await click('Play')

  await expect
    .poll(() => host!.querySelector('[role="timer"][aria-label="Playback time"]')!.textContent)
    .not.toMatch(/^0 /)
  await expect.poll(() => button('Play').disabled, { timeout: 5000 }).toBe(false)

  await click('Play')

  expect(controller.previewActive).toBe(true)

  controller.endPreview()

  await new Promise(requestAnimationFrame)

  expect(button('Play')).toBeDefined()

  await click('▸ track')
  host!.querySelector<HTMLButtonElement>('[aria-label="Select track.background-color"]')!.click()

  await tick()

  await input('Track duration', '500')
  await click('Apply timing')
  await click('Save to source')

  await expect.poll(() => controller.draft.length).toBe(0)
  expect(controller.message).toContain('synchronized')
})

it('creates a typed timing override for an ordinary layer property', async () => {
  const definition = {
    name: 'single',
    layers: [
      {
        name: 'base',
        targets: [
          {
            name: 'box',
            properties: [
              {
                name: 'opacity',
                value: {
                  kind: 'literal',
                  value: '1',
                },
              },
            ],
          },
        ],
      },
    ],
  } satisfies Definition
  const { controller } = await setupEditor(undefined, definition, {}, [
    { path: 'single/layer/base/target/box/property/opacity', kind: 'block', value: '' },
    { path: 'single/layer/base/target/box/property/opacity/value', kind: 'value', value: '1' },
  ])

  await click('Motion editor')
  await click('▸ box')
  await click('opacity')
  await input('Track duration', '100')
  await click('Apply timing')

  expect(controller.draft).toEqual([
    {
      op: 'timing',
      path: 'single/layer/base/target/box/property/opacity',
      value: 'tween(duration: 100, easing: linear)',
    },
  ])
})

it('ignores a preview response superseded while its request was in flight', async () => {
  const definition = decodeBundle(JSON.stringify(fixture)).definitions[0]
  let resolve!: (reply: {
    hash: string
    definition: typeof definition
    fields: []
    sequence?: number
  }) => void
  let sequence: number | undefined
  const pending = new Promise<{
    hash: string
    definition: typeof definition
    fields: []
    sequence?: number
  }>((done) => {
    resolve = done
  })
  const { controller } = await setupEditor(async (request) => {
    if (request.action === 'preview') {
      sequence = request.sequence
      return pending
    }

    return { hash: 'original', definition, fields: [] }
  })

  await click('Motion editor')
  await click('Play')
  await click('End preview')
  resolve({ hash: 'original', definition, fields: [], sequence })

  await tick()

  expect(controller.previewActive).toBe(false)
  expect(button('Play').disabled).toBe(false)
})

it('respects reduced motion both during playback and when starting a preview', async () => {
  const { controller } = await setupEditor()
  const session: CDPSession = cdp()

  await click('Motion editor')
  await click('Play')

  await new Promise(requestAnimationFrame)

  try {
    await session.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    })

    await expect.poll(() => button('Play').disabled).toBe(false)

    await click('Play')

    expect(controller.previewActive).toBe(true)
    expect(button('Play')).toBeDefined()
  } finally {
    await session.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
    })
  }
})

it('applies From edits to their source declaration', async () => {
  const { controller } = await setupEditor(
    async (request) => compositionSourceReply(request),
    compositionDefinition,
  )

  await click('Motion editor')
  await click('▸ body')
  await click('opacity')
  host!.querySelector<HTMLButtonElement>('[aria-label="body.opacity 0%"]')!.click()
  await tick()
  await input('Source value', '0.4')
  await click('Apply value')
  await expect.poll(() => controller.previewActive).toBe(true)

  expect(controller.draft).toEqual([
    { op: 'set', path: 'layered/layer/base/target/body/property/opacity/value', value: '0.4' },
  ])
  expect(host!.querySelector<HTMLInputElement>('[aria-label="Source value"]')!.value).toBe('0.4')
})

it('stops timeline playback when application state supersedes the preview', async () => {
  const { controller } = await setupEditor()

  await click('Motion editor')
  await click('Play')

  expect(button('Pause')).toBeDefined()
  expect(controller.previewActive).toBe(true)

  runtime!.runtime.updateParameters({ mode: 'on' })
  controller.observe('update', controller.selected!.binding)

  await new Promise(requestAnimationFrame)
  await tick()

  expect(button('Play')).toBeDefined()
  expect(controller.previewActive).toBe(false)
  expect(runtime!.runtime.composition.states.toggle).toBe('on')
  expect(controller.message).toContain('Application state superseded the preview')
})

it.each(['enter', 'leave'] as const)(
  'authors motion-level %s timing for a layer property',
  async (phase) => {
    const definition = {
      name: 'single',
      layers: [
        {
          name: 'base',
          targets: [
            {
              name: 'box',
              properties: [
                {
                  name: 'opacity',
                  value: {
                    kind: 'literal',
                    value: '1',
                  },
                },
              ],
            },
          ],
        },
      ],
    } satisfies Definition
    const { controller } = await setupEditor(undefined, definition)

    await click('Motion editor')
    await input('Existing transition', `${phase}-default`)
    await click('▸ box')
    await click('opacity')
    await input('Track duration', '200')
    await click('Apply timing')

    expect(controller.draft).toEqual([
      {
        op: 'timing',
        path: `single/${phase}/target/box/property/opacity`,
        value: 'tween(duration: 200, easing: linear)',
      },
    ])
    expect(host!.querySelector('[aria-label="From state"]')).toBeNull()
    expect(runtime!.runtime.composition.layers.base).toBe(true)
  },
)

it('adapts timeline ticks to zoom while preserving the playhead', async () => {
  await setupEditor()
  await click('Motion editor')
  await input('Playhead', '150')

  const content = host!.querySelector<HTMLElement>('[data-testid="timeline-content"]')!
  const initialWidth = content.style.width
  const labels = () =>
    [...host!.querySelectorAll('[data-testid="timeline-tick"]')].map((element) =>
      Number(element.textContent),
    )
  const playhead = host!.querySelector<HTMLInputElement>('[aria-label="Playhead"]')!
  const initialExtent = Number(playhead.max)

  expect(labels().every((value, index) => value === index * labels()[1])).toBe(true)

  await click('+')

  expect(content.style.width).not.toBe(initialWidth)
  expect(playhead.value).toBe('150')
  expect(Number(playhead.max)).toBe(initialExtent)

  await click('−')
  await click('−')

  expect(Number(playhead.max)).toBeGreaterThan(initialExtent)
  expect(labels().every((value, index) => value === index * labels()[1])).toBe(true)
  expect(playhead.value).toBe('150')

  await click('+')

  expect(content.style.width).toBe(initialWidth)
  expect(Number(playhead.max)).toBe(initialExtent)

  const initialStep = labels()[1]

  for (let index = 0; index < 6; index++) {
    await click('−')
  }

  expect(labels()[1]).toBeGreaterThan(initialStep)
  expect([1, 2, 5]).toContain(labels()[1] / 10 ** Math.floor(Math.log10(labels()[1])))
  expect(playhead.value).toBe('150')
  expect(host!.querySelector('[aria-label="Reset timeline zoom"]')).toBeNull()
})

it('scrubs zoom with the slider and keeps it synchronized with the zoom buttons', async () => {
  await setupEditor()
  await click('Motion editor')
  await input('Playhead', '150')

  const slider = host!.querySelector<HTMLInputElement>('[aria-label="Timeline zoom level"]')!
  const playhead = host!.querySelector<HTMLInputElement>('[aria-label="Playhead"]')!
  const content = host!.querySelector<HTMLElement>('[data-testid="timeline-content"]')!
  const initialWidth = content.style.width
  const initialExtent = Number(playhead.max)

  await input('Timeline zoom level', '2')

  expect(content.style.width).not.toBe(initialWidth)
  expect(Number(playhead.max)).toBe(initialExtent)
  expect(playhead.value).toBe('150')

  await click('−')

  expect(Number(slider.value)).toBeLessThan(2)

  await click('+')

  expect(Number(slider.value)).toBeCloseTo(2)

  await input('Timeline zoom level', '-2')

  expect(Number(playhead.max)).toBeGreaterThan(initialExtent)
  expect(playhead.value).toBe('150')
})

it('keeps the leftmost visible time anchored when zooming in and out', async () => {
  await setupEditor()
  await click('Motion editor')
  await input('Timeline zoom level', '2')

  const scroller = host!.querySelector<HTMLElement>(
    '[role="region"][aria-label="Animation timeline"]',
  )!
  const lane = host!.querySelector<HTMLElement>('[data-testid="timeline-ruler-lane"]')!
  const playhead = host!.querySelector<HTMLInputElement>('[aria-label="Playhead"]')!
  const leftTime = () =>
    (scroller.scrollLeft / lane.getBoundingClientRect().width) * Number(playhead.max)

  scroller.style.width = '800px'
  scroller.style.overflow = 'auto'
  lane.parentElement!.style.cssText =
    'display: grid; grid-template-columns: var(--timeline-label-width) 1fr'
  scroller.scrollLeft = 200

  const anchor = leftTime()

  expect(anchor).toBeGreaterThan(0)

  for (const level of ['3', '1', '-1']) {
    await input('Timeline zoom level', level)

    expect(Math.abs(leftTime() - anchor)).toBeLessThan(2)
  }
})

function pointer(target: Element, type: string, x: number, mouseButton = 0) {
  target.dispatchEvent(
    new PointerEvent(type, { bubbles: true, clientX: x, button: mouseButton, pointerId: 1 }),
  )
}

it('pans the timeline only after a primary pointer drag on its background', async () => {
  await setupEditor()
  await click('Motion editor')
  await input('Timeline zoom level', '2')

  const scroller = host!.querySelector<HTMLElement>('[aria-label="Animation timeline"]')!
  const lane = host!.querySelector<HTMLElement>('[data-testid="timeline-ruler-lane"]')!

  scroller.style.width = '800px'
  scroller.style.overflow = 'auto'
  lane.parentElement!.style.cssText =
    'display: grid; grid-template-columns: var(--timeline-label-width) 1fr'
  scroller.scrollLeft = 200

  pointer(scroller, 'pointermove', 100)
  pointer(scroller, 'pointerdown', 100, 2)
  pointer(scroller.querySelector('button')!, 'pointerdown', 100)
  await tick()

  expect(scroller.classList.contains('panning')).toBe(false)

  pointer(scroller, 'pointerdown', 100)
  pointer(scroller, 'pointermove', 101)
  await tick()

  expect(scroller.scrollLeft).toBe(200)
  expect(scroller.classList.contains('panning')).toBe(true)

  pointer(scroller, 'pointermove', 80)
  await tick()

  expect(scroller.scrollLeft).toBe(220)

  pointer(scroller, 'pointerup', 80)
  await tick()

  expect(scroller.classList.contains('panning')).toBe(false)
})

const compositionDefinition = {
  name: 'layered',
  layers: [
    {
      name: 'base',
      targets: [
        {
          name: 'body',
          properties: [
            {
              name: 'opacity',
              value: {
                kind: 'literal',
                value: '1',
              },
            },
            {
              name: 'scale',
              value: {
                kind: 'literal',
                value: '1',
              },
              timing: { kind: 'tween' as const, durationMs: 200, easing: 'linear' },
            },
          ],
        },
      ],
    },
    {
      name: 'hover',
      when: { kind: 'boolean' as const, value: false },
      targets: [
        {
          name: 'body',
          properties: [
            {
              name: 'scale',
              value: {
                kind: 'literal',
                value: '1.1',
              },
            },
          ],
        },
      ],
    },
    {
      name: 'machine',
      targets: [],
      initialState: 'idle',
      states: [
        {
          name: 'idle',
          targets: [
            {
              name: 'body',
              properties: [
                {
                  name: 'scale',
                  value: {
                    kind: 'literal',
                    value: '1',
                  },
                },
              ],
            },
          ],
        },
        {
          name: 'active',
          targets: [
            {
              name: 'body',
              properties: [
                {
                  name: 'scale',
                  value: {
                    kind: 'literal',
                    value: '1.2',
                  },
                },
              ],
            },
          ],
        },
      ],
      transitions: [1.5, 1.7].map((value) => ({
        from: 'idle',
        to: 'active',
        when: { kind: 'boolean' as const, value: false },
        transition: {
          targets: [
            {
              name: 'body',
              properties: [
                {
                  name: 'scale',
                  keyframes: [{ offset: 0.5, value: { kind: 'literal', value: String(value) } }],
                },
              ],
            },
          ],
        },
      })),
    },
  ],
} satisfies Definition

it('initializes independent composition selectors and swaps complete selections', async () => {
  await setupEditor(undefined, compositionDefinition)
  await click('Motion editor')

  const fromHover = host!.querySelector<HTMLInputElement>('[aria-label="From hover enabled"]')!
  const toHover = host!.querySelector<HTMLInputElement>('[aria-label="To hover enabled"]')!
  expect(fromHover.checked).toBe(false)
  expect(toHover.checked).toBe(false)

  toHover.focus()
  await userEvent.keyboard(' ')
  await tick()

  expect(toHover.checked).toBe(true)
  expect(fromHover.checked).toBe(false)
  expect(host!.querySelectorAll('.different')).toHaveLength(2)

  await input('To machine state', 'active')
  await click('Swap')

  expect(fromHover.checked).toBe(true)
  expect(toHover.checked).toBe(false)
  expect(selectValue('From machine state')).toBe('active')
  expect(selectValue('To machine state')).toBe('idle')
  expect(runtime!.runtime.composition).toEqual({
    layers: { base: true, hover: false },
    states: { machine: 'idle' },
  })
})

it('selects duplicate transitions without changing other layers and clears incompatible selections', async () => {
  await setupEditor(undefined, compositionDefinition)
  await click('Motion editor')
  const toHover = host!.querySelector<HTMLInputElement>('[aria-label="To hover enabled"]')!
  toHover.click()
  await tick()
  const identity = JSON.stringify({ layer: 'machine', index: 1 })

  await input('Existing transition', identity)
  await input('Playhead', '100')

  expect(nativeEffects(runtime!.executor)).toHaveLength(1)
  expect(toHover.checked).toBe(true)

  const effect = nativeEffects(runtime!.executor)[0].effect

  if (!(effect instanceof KeyframeEffect)) throw new Error('Expected a keyframe animation')

  expect(effect.getKeyframes()).toContainEqual(
    expect.objectContaining({ offset: 0.5, scale: '1.7' }),
  )
  expect(selectValue('From machine state')).toBe('idle')
  expect(selectValue('To machine state')).toBe('active')

  await click('Swap')

  expect(selectValue('Existing transition')).toBe('')

  await input('Existing transition', identity)
  await input('To machine state', 'idle')

  expect(selectValue('Existing transition')).toBe('')
})

it('shows all To properties and permits playback for equal compositions without edits', async () => {
  const { controller } = await setupEditor(undefined, compositionDefinition)
  await click('Motion editor')
  await click('▸ body')

  expect(host!.querySelector('[aria-label="Select body.opacity"]')).not.toBeNull()
  expect(host!.querySelector('[aria-label="Select body.scale"]')).not.toBeNull()
  expect(button('Play').disabled).toBe(false)

  await click('scale')

  expect(host!.querySelector('[aria-label="Selection inspector"]')!.textContent).toContain(
    'Layer: machine',
  )
  expect(host!.querySelector('[aria-label="Keyframe value"]')).toBeNull()
  expect(button('Save to source').disabled).toBe(true)

  await input('Playhead', '100')

  expect(controller.previewActive).toBe(true)
  expect(nativeEffects(runtime!.executor)).toHaveLength(1)

  await click('End preview')

  expect(nativeEffects(runtime!.executor)).toHaveLength(0)
})

it('keeps source unchanged for pointer gestures on composition rows', async () => {
  const { controller } = await setupEditor(undefined, compositionDefinition)
  await click('Motion editor')
  await click('▸ body')
  const key = host!.querySelector<HTMLElement>('[aria-label="body.scale 0%"]')!
  const lane = host!.querySelector<HTMLElement>('[data-track="body.scale"]')!

  key.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
  lane.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  await tick()

  expect(controller.draft).toEqual([])
  expect(host!.querySelector('[aria-label="Resize body.scale"]')).toBeNull()
})

it('allows clearing a transition shortcut and changing From independently', async () => {
  await setupEditor(undefined, compositionDefinition)
  await click('Motion editor')
  await input('Existing transition', JSON.stringify({ layer: 'machine', index: 0 }))
  await input('Existing transition', '')
  await input('From machine state', 'active')

  expect(selectValue('To machine state')).toBe('active')
  expect(button('Play').disabled).toBe(false)
})

it('reports invalid selected timing and recovers when the invalid layer is disabled', async () => {
  const { diagnostics } = await setupEditor(undefined, {
    ...compositionDefinition,
    layers: [
      ...compositionDefinition.layers,
      {
        name: 'invalid',
        when: { kind: 'boolean', value: false },
        targets: [
          {
            name: 'body',
            properties: [
              {
                name: 'scale',
                value: {
                  kind: 'literal',
                  value: '2',
                },
                timingExpression: {
                  kind: 'call',
                  function: 'tween',
                  arguments: [{ name: 'duration', value: { kind: 'number', value: -1 } }],
                },
              },
            ],
          },
        ],
      },
    ],
  })
  await click('Motion editor')
  const checkbox = host!.querySelector<HTMLInputElement>('[aria-label="To invalid enabled"]')!

  checkbox.click()
  await tick()

  expect(host!.querySelector('[role="alert"]')?.textContent).toContain('non-negative')
  expect(button('Play').disabled).toBe(true)
  expect(diagnostics.at(-1)?.code).toBe('runtime.inspection')
  expect(diagnostics.at(-1)?.error).toBeInstanceOf(Error)

  checkbox.click()
  await tick()

  expect(host!.querySelector('[role="alert"]')).toBeNull()
  expect(button('Play').disabled).toBe(false)
})

it('inspects the selected intermediate frame and effective timing without editing', async () => {
  await setupEditor(undefined, compositionDefinition)
  await click('Motion editor')
  await input('Existing transition', JSON.stringify({ layer: 'machine', index: 0 }))
  await click('▸ body')

  host!.querySelector<HTMLButtonElement>('[aria-label="body.scale 50%"]')!.click()
  await tick()

  const inspector = host!.querySelector('[aria-label="Selection inspector"]')!
  expect(inspector.querySelector('input, button')).toBeNull()
})

it('ignores invalid transition instructions hidden by the effective owner', async () => {
  const definition: Definition = {
    ...compositionDefinition,
    layers: [
      ...compositionDefinition.layers.map((layer) =>
        layer.name === 'machine'
          ? {
              ...layer,
              transitions: layer.transitions?.map((transition) => ({
                ...transition,
                transition: {
                  targets: ['body', 'absent'].map((name) => ({
                    name,
                    properties: [
                      {
                        name: 'scale',
                        timingExpression: {
                          kind: 'call' as const,
                          function: 'tween',
                          arguments: [
                            { name: 'duration', value: { kind: 'number' as const, value: -1 } },
                          ],
                        },
                      },
                    ],
                  })),
                },
              })),
            }
          : layer,
      ),
      {
        name: 'cover',
        targets: [
          {
            name: 'body',
            properties: [
              {
                name: 'scale',
                value: {
                  kind: 'literal',
                  value: '2',
                },
              },
            ],
          },
        ],
      },
    ],
  }
  const { diagnostics } = await setupEditor(undefined, definition)
  await click('Motion editor')
  await input('Existing transition', JSON.stringify({ layer: 'machine', index: 0 }))
  await input('Playhead', '100')

  expect(host!.querySelector('[role="alert"]')).toBeNull()
  expect(nativeEffects(runtime!.executor)).toHaveLength(1)
  expect(diagnostics.filter((item) => item.code === 'runtime.inspection')).toEqual([])

  host!.querySelector<HTMLInputElement>('[aria-label="To cover enabled"]')!.click()
  await tick()

  expect(host!.querySelector('[role="alert"]')?.textContent).toContain('non-negative')
  expect(button('Play').disabled).toBe(true)
})

it.each(['composition', 'enter'] as const)(
  'refreshes the same selected form inspection after accepted input changes: %s',
  async (scope) => {
    const definition: Definition = {
      name: 'fresh-inspection',
      parameters: [
        { name: 'amount', type: 'number' },
        { name: 'duration', type: 'number' },
      ],
      layers: [
        {
          name: 'base',
          targets: [
            {
              name: 'body',
              properties: [
                {
                  name: 'opacity',
                  value: { kind: 'template', parts: [{ kind: 'reference', path: ['amount'] }] },
                  timingExpression: {
                    kind: 'call',
                    function: 'tween',
                    arguments: [
                      { name: 'duration', value: { kind: 'reference', path: ['duration'] } },
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
      enter: {
        timingExpression: {
          kind: 'call',
          function: 'tween',
          arguments: [{ name: 'duration', value: { kind: 'reference', path: ['duration'] } }],
        },
        targets: [
          {
            name: 'body',
            properties: [
              {
                name: 'opacity',
                keyframes: [
                  {
                    offset: 0,
                    value: { kind: 'template', parts: [{ kind: 'reference', path: ['amount'] }] },
                  },
                ],
              },
            ],
          },
        ],
      },
    }
    const { controller } = await setupEditor(undefined, definition, { amount: 0.25, duration: 100 })
    const participant = runtime!
    const composition = vi.spyOn(participant.inspection, 'inspectComposition')
    const lifecycle = vi.spyOn(participant.inspection, 'inspectLifecycle')

    await click('Motion editor')

    if (scope === 'enter') {
      await input('Existing transition', 'enter-default')
    }

    expect(host!.querySelector('[aria-label="Playback time"]')!.textContent).toContain('100 ms')

    const selected = controller.selected!.binding
    participant.runtime.onUpdate = () => controller.observe('update', selected)
    composition.mockClear()
    lifecycle.mockClear()

    participant.runtime.updateParameters({ amount: 0.75, duration: 400 })

    await tick()

    expect(controller.selected!.binding).toBe(selected)
    expect(host!.querySelector('[aria-label="Playback time"]')!.textContent).toContain('400 ms')
    const snapshots =
      scope === 'enter'
        ? lifecycle.mock.results
            .filter((result) => result.type === 'return')
            .map(({ value }) => value.transition?.targets[0].properties[0].keyframes?.[0].value)
        : composition.mock.results
            .filter((result) => result.type === 'return')
            .map(({ value }) => value.presentation.targets[0].properties[0].value)

    expect(snapshots).toContainEqual(
      scope === 'enter' ? { kind: 'literal', value: '0.75' } : '0.75',
    )

    composition.mockRestore()
    lifecycle.mockRestore()
  },
)

it('inspects the replacement instance and reinitializes its current composition after remount', async () => {
  const definition: Definition = {
    ...compositionDefinition,
    layers: compositionDefinition.layers.map((layer) =>
      layer.name === 'base'
        ? {
            ...layer,
            targets: [
              {
                name: 'body',
                properties: [
                  {
                    name: 'opacity',
                    value: {
                      kind: 'template',
                      parts: [{ kind: 'reference', path: ['amount'] }],
                    },
                    timingExpression: {
                      kind: 'call',
                      function: 'tween',
                      arguments: [
                        { name: 'duration', value: { kind: 'reference', path: ['duration'] } },
                      ],
                    },
                  },
                ],
              },
            ],
          }
        : layer,
    ),
    parameters: [
      { name: 'amount', type: 'number' },
      { name: 'duration', type: 'number' },
    ],
  }
  const { controller } = await setupEditor(undefined, definition, { amount: 0.25, duration: 100 })
  await click('Motion editor')
  const original = controller.selected!.binding

  controller.observe('unmount', original)
  runtime!.runtime.dispose()
  runtime = assembleRuntime(definition, { amount: 0.75, duration: 400 })
  controller.observe('mount', {
    ...original,
    runtime: runtime.runtime,
    inspection: runtime.inspection,
  })
  await tick()
  await click('▸ body')
  await click('opacity')

  const inspector = host!.querySelector('[aria-label="Selection inspector"]')!

  expect(inspector.querySelector('[aria-label="Editing location"]')!.textContent).toBe(
    'Layer: base',
  )
  expect(host!.querySelector('[aria-label="Playback time"]')!.textContent).toContain('400 ms')
})

it('identifies an external From endpoint on a property without timing', async () => {
  await setupEditor(undefined, compositionDefinition)
  await click('Motion editor')

  host!.querySelector<HTMLInputElement>('[aria-label="From base enabled"]')!.click()
  await tick()
  await click('▸ body')

  host!.querySelector<HTMLButtonElement>('[aria-label="body.opacity 0%"]')!.click()
  await tick()

  const inspector = host!.querySelector('[aria-label="Selection inspector"]')!
  expect(inspector.textContent).not.toContain('Resolved timing:')
  expect(inspector.querySelector('[aria-label="Editing location"]')!.textContent).toBe(
    'External CSS',
  )
  expect(inspector.querySelector('[aria-label="Source value"]')).toBeNull()
})

function compositionSourceReply(request: EditorRequest): EditorReply {
  const definition = structuredClone(compositionDefinition)
  const path = 'layered/layer/base/target/body/property/opacity'
  let value = '1'

  for (const edit of request.edits ?? []) {
    if (edit.op === 'set' && edit.path === `${path}/value`) {
      if (!Number.isFinite(Number(edit.value))) throw new Error('Invalid opacity source value')
      value = edit.value
    }
  }

  definition.layers[0].targets[0].properties[0].value = { kind: 'literal', value }

  return {
    hash: 'original',
    sequence: request.sequence,
    definition,
    fields: [
      { path, kind: 'block', value: '' },
      { path: `${path}/value`, kind: 'value', value },
    ],
  }
}

it('applies composition edit replies to the selected preview without changing application state', async () => {
  const requests: EditorRequest[] = []
  const { controller } = await setupEditor(async (request) => {
    requests.push(request)
    return compositionSourceReply(request)
  }, compositionDefinition)
  await click('Motion editor')
  await click('▸ body')
  await click('opacity')

  await input('Source value', '0.5')
  await click('Apply value')
  await expect.poll(() => controller.previewActive).toBe(true)

  expect(requests.at(-1)?.edits).toEqual([
    { op: 'set', path: 'layered/layer/base/target/body/property/opacity/value', value: '0.5' },
  ])
  expect(host!.querySelector<HTMLInputElement>('[aria-label="Source value"]')!.value).toBe('0.5')
  expect(runtime!.runtime.definition).toEqual(compositionDefinition)
  expect(runtime!.runtime.composition?.layers.hover).toBe(false)
  expect(button('Save to source').disabled).toBe(false)
})

it('rolls back an invalid composition draft and permits a corrected source edit', async () => {
  const { controller } = await setupEditor(
    async (request) => compositionSourceReply(request),
    compositionDefinition,
  )
  await click('Motion editor')
  await click('▸ body')
  await click('opacity')

  await input('Source value', 'invalid')
  await click('Apply value')
  await expect.poll(() => controller.message).toContain('Invalid opacity')

  expect(controller.draft).toEqual([])
  expect(controller.previewActive).toBe(false)

  await input('Source value', '0.4')
  await click('Apply value')
  await expect.poll(() => controller.previewActive).toBe(true)

  expect(host!.querySelector<HTMLInputElement>('[aria-label="Source value"]')!.value).toBe('0.4')
})

it('ignores a composition source preview ended while compilation was pending', async () => {
  let complete!: (reply: EditorReply) => void
  let pendingRequest!: EditorRequest
  const pending = new Promise<EditorReply>((resolve) => {
    complete = resolve
  })
  const { controller } = await setupEditor(async (request) => {
    if (request.action === 'preview') {
      pendingRequest = request
      return pending
    }

    return compositionSourceReply(request)
  }, compositionDefinition)
  await click('Motion editor')
  await click('Play')
  await click('End preview')

  complete(compositionSourceReply(pendingRequest))
  await tick()

  expect(controller.previewActive).toBe(false)
  expect(runtime!.runtime.definition).toEqual(compositionDefinition)
})

it('preserves unapplied composition source input across timeline zoom renders', async () => {
  await setupEditor(async (request) => compositionSourceReply(request), compositionDefinition)
  await click('Motion editor')
  await click('▸ body')
  await click('opacity')

  await input('Source value', '0.35')
  await input('Timeline zoom level', '2')

  expect(host!.querySelector<HTMLInputElement>('[aria-label="Source value"]')!.value).toBe('0.35')
})

async function setupCompositionFrames() {
  const definition = {
    name: 'frames',
    layers: [
      {
        name: 'base',
        targets: [
          {
            name: 'body',
            properties: [
              {
                name: 'opacity',
                value: {
                  kind: 'keyframes',
                  frames: [
                    {
                      offset: 0.5,
                      value: {
                        kind: 'literal',
                        value: '0.5',
                      },
                    },
                    {
                      offset: 1,
                      value: {
                        kind: 'literal',
                        value: '1',
                      },
                    },
                  ],
                },
                timing: { kind: 'tween' as const, durationMs: 200, easing: 'linear' },
              },
            ],
          },
        ],
      },
    ],
  } satisfies Definition
  const path = 'frames/layer/base/target/body/property/opacity'
  const { controller } = await setupEditor(async (request) => {
    const candidate = structuredClone(definition)
    const property = candidate.layers[0].targets[0].properties[0]

    for (const edit of request.edits ?? []) {
      if (edit.op === 'addFrame')
        property.value.frames.push({
          offset: (edit.offset * 100) / 100,
          value: { kind: 'literal', value: edit.value },
        })
      else if (edit.op === 'removeFrame')
        property.value.frames = property.value.frames.filter(
          (frame) => `${path}/frame/${frame.offset}` !== edit.path,
        )
      else if (edit.op === 'set') {
        const frame = property.value.frames.find((candidateFrame) =>
          edit.path.startsWith(`${path}/frame/${candidateFrame.offset}/`),
        )

        if (frame && edit.path.endsWith('/offset')) frame.offset = parseFloat(edit.value) / 100
        else if (frame) frame.value = { kind: 'literal', value: edit.value }
      }
    }

    return {
      hash: 'original',
      sequence: request.sequence,
      definition: candidate,
      fields: [
        { path, kind: 'block' as const, value: '' },
        ...property.value.frames.map((frame) => ({
          path: `${path}/frame/${frame.offset}/value`,
          kind: 'value' as const,
          value: frame.value.value,
        })),
      ],
    }
  }, definition)
  await click('Motion editor')
  await click('▸ body')
  await click('opacity')

  return controller
}

it('selects an existing composition frame instead of adding a duplicate at the playhead', async () => {
  const controller = await setupCompositionFrames()

  await input('Playhead', '100')
  await click('New keyframe at playhead')

  expect(button('Apply keyframe')).toBeDefined()
  expect(controller.draft).toEqual([])
  expect(selectValue('Keyframe percentage')).toBe('50')
})

it.each([0, 100])('does not add a frame beyond a %s ms track duration', async (durationMs) => {
  const definition: Definition = {
    name: 'short',
    layers: [
      {
        name: 'base',
        targets: [
          {
            name: 'body',
            properties: [
              {
                name: 'opacity',
                value: {
                  kind: 'literal',
                  value: '1',
                },
                timing: { kind: 'tween', durationMs, easing: 'linear' },
              },
              {
                name: 'scale',
                value: {
                  kind: 'literal',
                  value: '1',
                },
                timing: { kind: 'tween', durationMs: 500, easing: 'linear' },
              },
            ],
          },
        ],
      },
    ],
  }
  const path = 'short/layer/base/target/body/property/opacity'
  const { controller } = await setupEditor(undefined, definition, {}, [
    { path, kind: 'block', value: '' },
    { path: `${path}/value`, kind: 'value', value: '1' },
  ])

  await click('Motion editor')
  await click('▸ body')
  await click('opacity')
  await input('Playhead', '250')
  await click('New keyframe at playhead')

  expect(controller.draft).toEqual([])
  expect(host!.querySelector('[aria-label="Keyframe source value"]')).toBeNull()
})

it.each([25, 33.333])(
  'clears pending selection after adding a composition frame at %s percent',
  async (percentage) => {
    const controller = await setupCompositionFrames()

    await input('Playhead', '50')
    await click('New keyframe at playhead')
    await input('Keyframe percentage', String(percentage))
    await click('Add keyframe')
    await expect.poll(() => host!.textContent).toContain('Apply keyframe')

    await input('Keyframe source value', '0.3')
    await click('Apply keyframe')

    expect(controller.draft).toContainEqual({
      op: 'set',
      path: `frames/layer/base/target/body/property/opacity/frame/${((Math.round(percentage * 10000) / 1000000) * 100) / 100}/value`,
      value: '0.3',
    })
    expect(controller.draft.filter((edit) => edit.op === 'addFrame')).toHaveLength(1)
  },
)

it('keeps the moved composition frame selected for follow-up edits', async () => {
  const controller = await setupCompositionFrames()
  host!.querySelector<HTMLButtonElement>('[aria-label="body.opacity 50%"]')!.click()
  await tick()
  await input('Keyframe percentage', '60')
  await click('Apply keyframe')
  await expect
    .poll(() => host!.querySelector<HTMLInputElement>('[aria-label="Keyframe percentage"]')?.value)
    .toBe('60')

  await input('Keyframe source value', '0.7')
  await click('Apply keyframe')

  expect(controller.draft.at(-2)).toEqual({
    op: 'set',
    path: 'frames/layer/base/target/body/property/opacity/frame/0.6/value',
    value: '0.7',
  })
})

it('clears frame selection after a composition frame is deleted', async () => {
  const controller = await setupCompositionFrames()
  host!.querySelector<HTMLButtonElement>('[aria-label="body.opacity 50%"]')!.click()
  await tick()
  await click('Delete keyframe')
  await expect.poll(() => host!.querySelector('[aria-label="Keyframe source value"]')).toBeNull()

  expect(controller.draft).toEqual([
    { op: 'removeFrame', path: 'frames/layer/base/target/body/property/opacity/frame/0.5' },
  ])
})

it('switches between lifecycle and composition editing in the transition selector', async () => {
  await setupEditor(undefined, compositionDefinition)
  await click('Motion editor')
  await input('Existing transition', 'leave-default')

  expect(host!.querySelector('[aria-label="Baseline machine state"]')).not.toBeNull()
  expect(host!.querySelector('[aria-label="From machine state"]')).toBeNull()

  await input('Existing transition', JSON.stringify({ layer: 'machine', index: 0 }))

  expect(host!.querySelector('[aria-label="Baseline machine state"]')).toBeNull()
  expect(selectValue('From machine state')).toBe('idle')
  expect(selectValue('To machine state')).toBe('active')
})

it('uses one composition baseline for lifecycle rows and isolated scrub-ready playback', async () => {
  const definition: Definition = {
    ...compositionDefinition,
    enter: {
      timing: { kind: 'tween', durationMs: 200, easing: 'linear' },
      targets: [
        {
          name: 'body',
          properties: [
            {
              name: 'opacity',
              keyframes: [
                {
                  offset: 0,
                  value: {
                    kind: 'literal',
                    value: '0',
                  },
                },
              ],
            },
            {
              name: 'color',
              keyframes: [
                {
                  offset: 0,
                  value: {
                    kind: 'literal',
                    value: 'red',
                  },
                },
              ],
            },
          ],
        },
      ],
    },
  }
  const { controller } = await setupEditor(undefined, definition)

  await click('Motion editor')
  await input('Existing transition', 'enter-default')

  expect(host!.querySelector('[aria-label="From base enabled"]')).toBeNull()
  expect(host!.querySelector('[aria-label="Baseline base enabled"]')).not.toBeNull()

  await input('Baseline machine state', 'active')
  const hover = host?.querySelector<HTMLInputElement>('[aria-label="Baseline hover enabled"]')

  expect(hover).toBeInstanceOf(HTMLInputElement)

  if (!hover) throw new Error('Missing baseline hover checkbox')

  hover.click()

  await tick()

  await click('▸ body')
  await click('color')

  const inspector = host?.querySelector('[aria-label="Selection inspector"]')

  expect(inspector?.querySelector('[aria-label="Editing location"]')?.textContent).toBe(
    'External CSS',
  )
  expect(host!.querySelector('[aria-label="Editing scope"]')).toBeNull()

  await click('Play')

  await expect.poll(() => controller.previewActive).toBe(true)

  expect(nativeEffects(runtime!.executor)).toHaveLength(2)
  expect(runtime!.runtime.composition?.states.machine).toBe('idle')

  await click('End preview')

  expect(nativeEffects(runtime!.executor)).toHaveLength(0)
})

it.each(['enter', 'leave'] as const)(
  'shows the %s editing scope and phase-specific completion behavior',
  async (phase) => {
    const definition: Definition = {
      ...compositionDefinition,
      [phase]: {
        timing: { kind: 'tween', durationMs: 200, easing: 'linear' },
        targets: [
          {
            name: 'body',
            properties: [
              {
                name: 'opacity',
                keyframes: [
                  { offset: 0, value: { kind: 'literal', value: '0.2' } },
                  { offset: 1, value: { kind: 'literal', value: '0.6' } },
                ],
              },
            ],
          },
        ],
      },
    }

    await setupEditor(undefined, definition)
    await click('Motion editor')
    await input('Existing transition', `${phase}-default`)
    await click('▸ body')
    await click('opacity')

    const inspector = host?.querySelector('[aria-label="Selection inspector"]')

    expect(inspector?.querySelector('[aria-label="Timing editing location"]')?.textContent).toBe(
      `Motion ${phase}`,
    )
    expect(inspector?.textContent?.includes('Completion restores')).toBe(phase === 'enter')
  },
)
