import { afterEach, expect, it } from 'vite-plus/test'
import { userEvent } from 'vite-plus/test/browser'
import { createApp, nextTick, type App } from 'vue'
import TimelineRow from './TimelineRow.ce.vue'
import type { TimelineTrack } from '../timeline.ts'

let app: App | undefined
let host: HTMLElement | undefined

afterEach(() => {
  app?.unmount()
  host?.remove()
})

it('converts pointer drags into frame and duration changes and validates double-click positions', async () => {
  const track: TimelineTrack = {
    target: 'box',
    property: 'opacity',
    path: 'track',
    duration: 1000,
    timing: { kind: 'tween', durationMs: 1000, easing: 'linear' },
    frames: [
      { offset: 0, value: '0' },
      { offset: 0.5, value: '0.5' },
      { offset: 1, value: '1' },
    ],
    explicit: [{ offset: 0.5, value: '0.5' }],
    inheritedFrames: false,
    timingOrigin: 'Local property',
  }
  const moves: [number, number][] = []
  const durations: number[] = []
  const additions: number[] = []

  host = document.createElement('div')
  host.style.cssText = 'width:800px;margin:20px'
  document.body.append(host)
  app = createApp(TimelineRow, {
    track,
    extent: 2000,
    time: 0,
    marks: [],
    onMove: (from: number, to: number) => moves.push([from, to]),
    onDuration: (value: number) => durations.push(value),
    onAdd: (value: number) => additions.push(value),
  })
  app.mount(host)

  await nextTick()

  const lane = host.querySelector<HTMLElement>('.lane')!
  const key = host.querySelector<HTMLElement>('[aria-label="box.opacity 50%"]')!
  const resize = host.querySelector<HTMLElement>('[aria-label="Resize box.opacity"]')!

  await userEvent.dragAndDrop(key, lane, { targetPosition: { x: 300, y: 15 } })

  expect(moves[0][0]).toBe(0.5)
  expect(moves[0][1]).toBeGreaterThan(0.5)
  expect(moves[0][1]).toBeLessThanOrEqual(1)

  await userEvent.dragAndDrop(resize, lane, { targetPosition: { x: 600, y: 15 } })

  expect(durations[0]).toBeGreaterThan(1000)

  const rect = lane.getBoundingClientRect()

  lane.dispatchEvent(
    new MouseEvent('dblclick', {
      bubbles: true,
      clientX: rect.left + rect.width / 4,
      altKey: true,
    }),
  )

  expect(additions).toEqual([0.5])

  lane.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: rect.right }))

  expect(additions).toHaveLength(1)

  key.dispatchEvent(new PointerEvent('pointerdown', { button: 2 }))
  key.dispatchEvent(new PointerEvent('pointermove'))
  key.dispatchEvent(new PointerEvent('pointerup'))
  key.dispatchEvent(new PointerEvent('pointercancel'))
  resize.dispatchEvent(new PointerEvent('pointercancel'))

  expect(moves).toHaveLength(1)
})
