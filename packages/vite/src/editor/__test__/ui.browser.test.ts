import { afterEach, expect, it } from 'vite-plus/test'
import { cdp, userEvent } from 'vite-plus/test/browser'
import type { CDPSession } from '@vitest/browser-playwright'
import { createApp, nextTick, type App } from 'vue'
import { LivaInstance, decodeBundle } from '@liva/runtime'
import fixture from '../../../../../fixtures/toggle.json'
import EditorPanel from '../components/EditorPanel.ce.vue'
import TimelineInspector from '../components/TimelineInspector.ce.vue'
import type { Timing } from '@liva/runtime'
import type { TimelineTrack } from '../timeline.ts'
import { EditorController } from '../controller.ts'

let app: App | undefined
let host: HTMLElement | undefined
let runtime: LivaInstance | undefined

afterEach(() => {
  app?.unmount()
  runtime?.dispose()
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

async function setupEditor(
  send?: ConstructorParameters<typeof EditorController>[0],
  definition = decodeBundle(JSON.stringify(fixture)).definitions[0],
) {
  const controller = new EditorController(
    send ??
      (async (request) => ({
        hash: 'original',
        definition,
        fields: [],
        sequence: request.sequence,
      })),
  )

  host = document.createElement('div')
  document.body.append(host)
  runtime = new LivaInstance(definition, 'off')
  controller.observe('mount', {
    root: host,
    runtime,
    definition,
    component: { livaSource: 'source' },
    requestedState: 'off',
  })
  runtime.bind(
    definition.states[0].targets.map(({ name }) => {
      const element = document.createElement('div')

      host!.append(element)
      return [name, element] as const
    }),
  )

  const mountPoint = document.createElement('div')

  host.append(mountPoint)
  app = createApp(EditorPanel, { controller })
  app.mount(mountPoint)

  return { controller, definition }
}

it('opens the editor, edits track timing and state endpoints, and controls preview', async () => {
  const { controller } = await setupEditor()

  await click('Motion editor')

  expect(controller.inspection?.definition.name).toBe('toggle')

  await click('▸ track')
  host!.querySelector<HTMLButtonElement>('[aria-label="Select track.background-color"]')!.click()

  await tick()

  await input('Track duration', '450')
  await click('Apply timing')

  expect(controller.draft).toEqual([
    expect.objectContaining({ op: 'track', timing: '@tween: 450ms ease-in-out' }),
  ])

  await expect.poll(() => controller.previewActive).toBe(true)

  await click('Use common timing')

  expect(controller.draft[0]).toMatchObject({ timing: undefined })

  await click('Play')

  expect(controller.previewActive).toBe(true)

  await new Promise(requestAnimationFrame)
  await new Promise(requestAnimationFrame)

  await click('Pause')
  await input('Playhead', '100')
  await click('To start')
  await click('End preview')

  expect(controller.previewActive).toBe(false)

  await input('Timing mode', 'spring-duration')
  await click('Apply timing')

  expect(controller.draft[0]).toMatchObject({ timing: '@spring: 200ms 0.25' })

  await input('Timing mode', 'spring-physics')
  await click('Apply timing')

  expect(controller.draft[0]).toMatchObject({ timing: '@spring: 300 20 1' })

  await input('Timing mode', 'tween')
  await input('Track duration', '-1')
  await click('Apply timing')

  expect(controller.message).toContain('nonnegative')

  await input('Timing mode', 'tween')
  await input('Track duration', '200')
  await click('Apply timing')
  await input('Playhead', '100')
  await click('New keyframe at playhead')
  await click('Add keyframe')

  expect(controller.message).toContain('Enter a value')

  await input('Keyframe value', 'red')
  await input('Keyframe percentage', '50')
  await input('Keyframe easing', 'linear')
  await click('Add keyframe')

  expect(controller.draft[0]).toMatchObject({
    frames: [{ offset: 0.5, value: 'red', easing: 'linear' }],
  })

  await input('Keyframe time', '60')
  await click('Apply keyframe')

  expect(controller.draft[0]).toMatchObject({ frames: [{ offset: 0.3, value: 'red' }] })

  await click('Delete keyframe')

  expect(controller.draft[0]).toMatchObject({
    frames: [
      { offset: 0, value: '#888' },
      { offset: 1, value: '#34b27b' },
    ],
  })

  await click('Use common keyframes')
  host!.querySelector<HTMLButtonElement>('[aria-label="track.background-color 0%"]')!.click()

  await tick()

  await input('Keyframe value', '')
  await click('Update state value')

  expect(controller.message).toContain('Enter a state value')

  await input('Keyframe value', 'blue')
  await click('Update state value')

  expect(controller.draft).toContainEqual({
    op: 'set',
    path: 'toggle/state/off/target/track/background-color',
    value: 'blue',
  })

  await click('Create endpoint override')

  expect(controller.draft).toContainEqual(
    expect.objectContaining({ op: 'track', frames: [{ offset: 0, value: 'blue' }] }),
  )

  await input('From state', 'on')

  expect(host!.querySelector<HTMLSelectElement>('[aria-label="To state"]')!.value).toBe('off')

  await input('Editing scope', 'general')
  await click('▾ track')
  await click('▸ track')

  await click('Discard changes')

  expect(controller.draft).toEqual([])

  await click('Close')

  expect(button('Motion editor')).toBeDefined()
})

it('edits all spring fields and displays track diagnostics without timing', async () => {
  const track: TimelineTrack = {
    target: 'box',
    property: 'opacity',
    path: 'box/opacity',
    duration: 0,
    frames: [],
    explicit: [],
    inheritedFrames: false,
    timingOrigin: 'Inherited common default',
    diagnostic: 'Missing timing',
  }
  const timings: Timing[] = []

  host = document.createElement('div')
  document.body.append(host)
  app = createApp(TimelineInspector, {
    track,
    from: 'off',
    to: 'on',
    general: false,
    onTiming: (timing: Timing) => timings.push(timing),
  })
  app.mount(host)

  expect(host.querySelector('[role="alert"]')?.textContent).toBe('Missing timing')

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

    return { hash: 'original', definition, fields: [], sequence: request.sequence }
  })

  await click('Motion editor')
  failure = 'Preview unavailable'
  await click('Play')

  expect(controller.message).toContain('Preview unavailable')
  expect(controller.previewActive).toBe(false)

  await click('▸ track')
  host!.querySelector<HTMLButtonElement>('[aria-label="Select track.background-color"]')!.click()

  await tick()

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

it('rejects colliding keyframes and spring intermediates while resizing real timeline tracks', async () => {
  const { controller } = await setupEditor()

  await click('Motion editor')
  await click('▸ thumb')

  const scale = host!.querySelector<HTMLElement>('[data-track="thumb.scale"]')!
  const key = host!.querySelector<HTMLElement>('[aria-label="thumb.scale 40%"]')!
  const extent = Number(host!.querySelector<HTMLInputElement>('[aria-label="Playhead"]')!.max)
  const collisionX = scale.getBoundingClientRect().width * ((0.7 * 350) / extent)

  await userEvent.dragAndDrop(key, scale, { targetPosition: { x: collisionX, y: 5 } })

  await tick()

  expect(controller.message).toContain('already exists')

  host!.querySelector<HTMLButtonElement>('[aria-label="Select thumb.scale"]')!.click()

  await tick()

  await input('Timing mode', 'spring-physics')
  await click('Apply timing')

  expect(controller.message).toContain('Remove intermediate keyframes')

  host!.querySelector<HTMLButtonElement>('[aria-label="thumb.translate 0%"]')!.click()

  await tick()

  await click('Create endpoint override')
  await input('Keyframe percentage', '50')
  await click('Apply keyframe')

  expect(controller.message).toContain('Spring tracks only support endpoints')

  const resize = host!.querySelector<HTMLElement>('[aria-label="Resize thumb.scale"]')!

  await userEvent.dragAndDrop(resize, scale, {
    targetPosition: { x: scale.getBoundingClientRect().width / 2, y: 5 },
  })

  await tick()

  expect(controller.draft).toContainEqual(
    expect.objectContaining({
      path: expect.stringContaining('/scale'),
      timing: expect.stringMatching(/^@tween:/),
    }),
  )
})

it('plays to completion, restarts at the end and saves synchronized edits', async () => {
  const { controller } = await setupEditor()

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

it('creates common timing for a single-state definition without a transition', async () => {
  const definition = {
    name: 'single',
    states: [
      { name: 'off', targets: [{ name: 'box', properties: [{ name: 'opacity', value: '1' }] }] },
    ],
    directionalTransitions: [],
  }
  const { controller } = await setupEditor(undefined, definition)

  await click('Motion editor')
  await input('Editing scope', 'general')

  expect(button('Play').disabled).toBe(true)

  await click('▸ box')
  host!.querySelector<HTMLButtonElement>('[aria-label="Select box.opacity"]')!.click()

  await tick()

  await input('Track duration', '100')
  await click('Apply timing')

  expect(controller.draft).toEqual([
    {
      op: 'track',
      path: 'single/transition/general/target/box/property/opacity',
      timing: '@tween: 100ms linear',
      frames: undefined,
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

it('edits destination values, sorts multiple keys and clears common overrides', async () => {
  const { controller } = await setupEditor()

  await click('Motion editor')
  await input('To state', 'off')
  await click('▸ track')

  const lane = host!.querySelector<HTMLElement>('[data-track="track.background-color"]')!
  const endpoint = host!.querySelector<HTMLElement>('[aria-label="track.background-color 0%"]')!

  await userEvent.dragAndDrop(endpoint, lane, { targetPosition: { x: 100, y: 5 } })

  await tick()

  expect(controller.message).toContain('State endpoints cannot be moved')

  host!.querySelector<HTMLButtonElement>('[aria-label="track.background-color 100%"]')!.click()

  await tick()

  await input('Keyframe value', 'purple')
  await click('Update state value')

  expect(controller.draft).toContainEqual(
    expect.objectContaining({
      path: 'toggle/state/on/target/track/background-color',
      value: 'purple',
    }),
  )

  for (const [time, value] of [
    ['50', 'red'],
    ['100', 'blue'],
  ]) {
    host!.querySelector<HTMLButtonElement>('[aria-label="Select track.background-color"]')!.click()

    await tick()

    await input('Track easing', 'linear')
    await input('Playhead', time)
    await click('New keyframe at playhead')
    await input('Keyframe value', value)
    await click('Add keyframe')
  }

  expect(controller.draft).toContainEqual(
    expect.objectContaining({
      frames: [
        { offset: 0.25, value: 'red' },
        { offset: 0.5, value: 'blue' },
      ],
    }),
  )

  host!.querySelector<HTMLButtonElement>('[aria-label="Select track.background-color"]')!.click()

  await tick()

  const rect = lane.getBoundingClientRect()
  const extent = Number(host!.querySelector<HTMLInputElement>('[aria-label="Playhead"]')!.max)

  lane.dispatchEvent(
    new MouseEvent('dblclick', { clientX: rect.left + (rect.width * 150) / extent, altKey: true }),
  )

  await tick()

  expect(button('Add keyframe')).toBeDefined()

  host!.querySelector<HTMLButtonElement>('[aria-label="Select track.background-color"]')!.click()

  await tick()

  await input('Playhead', '1000')
  await click('New keyframe at playhead')

  expect(host!.querySelector('[aria-label="Keyframe value"]')).toBeNull()

  await input('Playhead', '0')
  await click('New keyframe at playhead')

  expect(button('Update state value')).toBeDefined()

  await input('Editing scope', 'general')
  host!.querySelector<HTMLButtonElement>('[aria-label="track.background-color 0%"]')!.click()

  await tick()

  await click('Create endpoint override')
  await input('Keyframe easing', 'linear')
  await input('Keyframe value', 'cyan')
  await click('Apply keyframe')
  host!.querySelector<HTMLButtonElement>('[aria-label="Select track.background-color"]')!.click()

  await tick()

  await input('Timing mode', 'spring-duration')
  await click('Apply timing')

  expect(controller.message).toContain('Remove intermediate keyframes')

  host!.querySelector<HTMLButtonElement>('[aria-label="track.background-color 0%"]')!.click()

  await tick()

  await click('Delete keyframe')

  expect(controller.draft).toContainEqual(
    expect.objectContaining({
      path: 'toggle/transition/general/target/track/property/background-color',
      frames: undefined,
    }),
  )
})

it('stops timeline playback when application state supersedes the preview', async () => {
  const { controller } = await setupEditor()

  await click('Motion editor')
  await click('Play')

  expect(button('Pause')).toBeDefined()
  expect(controller.previewActive).toBe(true)

  runtime!.setState('on')
  controller.observe('update', controller.selected!.binding)

  await new Promise(requestAnimationFrame)
  await tick()

  expect(button('Play')).toBeDefined()
  expect(controller.previewActive).toBe(false)
  expect(runtime!.state).toBe('on')
  expect(controller.message).toContain('Application state superseded the preview')
})

it.each(['enter', 'leave'] as const)(
  'authors default and state-specific %s tracks for a single-state motion',
  async (phase) => {
    const definition = {
      name: 'single',
      states: [
        { name: 'off', targets: [{ name: 'box', properties: [{ name: 'opacity', value: '1' }] }] },
      ],
      directionalTransitions: [],
    }
    const { controller } = await setupEditor(undefined, definition)

    await click('Motion editor')
    await input('Editing scope', `${phase}-default`)
    await click('▸ box')

    expect(button('Play').disabled).toBe(false)
    expect(host!.querySelector('[aria-label="From state"]')).toBeNull()

    const selectTrack = async () => {
      host!.querySelector<HTMLButtonElement>('[aria-label="Select box.opacity"]')!.click()
      await tick()
    }
    await selectTrack()
    await input('Track duration', '200')
    await click('Apply timing')
    host!.querySelector<HTMLButtonElement>('[aria-label="box.opacity 0%"]')!.click()
    await tick()

    expect(host!.textContent).toContain('Captured state / presentation endpoint')
    expect(
      [...host!.querySelectorAll('button')].some(
        (element) => element.textContent === 'Update state value',
      ),
    ).toBe(false)

    await input('Keyframe value', '0.2')
    await click('Create endpoint override')
    await input('Editing scope', `${phase}-state`)
    host!.querySelector<HTMLButtonElement>('[aria-label="box.opacity 0%"]')!.click()
    await tick()

    expect(host!.textContent).toContain('Inherited default keyframe')

    await input('Keyframe value', '0.4')
    await click('Apply keyframe')
    await selectTrack()
    await input('Track duration', '400')
    await click('Apply timing')

    expect(controller.draft).toContainEqual(
      expect.objectContaining({
        path: `single/${phase}/off/target/box/property/opacity`,
        timing: '@tween: 400ms linear',
        frames: [{ offset: 0, value: '0.4' }],
      }),
    )

    await click('Use default keyframes')
    await click('Use default timing')

    expect(controller.draft).toContainEqual({
      op: 'track',
      path: `single/${phase}/off/target/box/property/opacity`,
      timing: undefined,
      frames: undefined,
    })

    await click('Play')
    await expect.poll(() => controller.previewActive).toBe(true)
    await click('End preview')

    expect(controller.previewActive).toBe(false)
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
