import { afterEach, describe, expect, it } from 'vite-plus/test'
import { userEvent } from 'vite-plus/test/browser'
import { defineCustomElement, nextTick } from 'vue'
import TimelineRow from './TimelineRow.ce.vue'
import type { TimelineTrack } from '../timeline.ts'

const RowElement = defineCustomElement(TimelineRow)

customElements.define('liva-test-timeline-row', RowElement)

let host: HTMLElement | undefined

afterEach(async () => {
  host?.remove()

  await nextTick()
})

async function setupRow(extent = 2000) {
  const track: TimelineTrack = {
    target: 'box',
    property: 'opacity',
    path: 'track',
    duration: 1000,
    timing: { kind: 'tween', durationMs: 1000, easing: 'linear' },
    frames: [
      { offset: 0, value: '0' },
      { offset: 0.33333, value: '0.5' },
      { offset: 1, value: '1' },
    ],
    explicit: [{ offset: 0.33333, value: '0.5' }],
  }
  const selections: unknown[] = []
  const element = new RowElement({
    track,
    extent,
  })

  element.addEventListener('select', (event) => {
    if (!(event instanceof CustomEvent)) throw new Error('Expected a selection event')

    selections.push(event.detail)
  })

  element.style.cssText = 'display:block;inline-size:800px;margin:20px;--timeline-label-width:160px'
  document.body.append(element)
  host = element

  await nextTick()

  const root = element.shadowRoot

  if (!root) throw new Error('Missing timeline shadow root')

  return { element: root, selections }
}

function rowElement(element: ShadowRoot, selector: string): HTMLElement {
  const found = element.querySelector<HTMLElement>(selector)

  if (!found) throw new Error(`Missing timeline element: ${selector}`)

  return found
}

describe('timeline row selection', () => {
  it.each([
    { label: 'Select box.opacity', offset: undefined },
    { label: 'box.opacity 33.333%', offset: 0.33333 },
  ])('selects $label from the keyboard', async ({ label, offset }) => {
    const { element, selections } = await setupRow()
    const button = rowElement(element, `[aria-label="${label}"]`)

    button.focus()

    expect(element.activeElement).toBe(button)

    await userEvent.keyboard('{Enter}')

    expect(selections).toEqual([offset === undefined ? [] : [offset]])
    expect(element.activeElement).toBe(button)
  })

  it.each([1000, 2000])('positions frames in the %s ms viewport', async (extent) => {
    const { element } = await setupRow(extent)
    const lane = rowElement(element, '.lane').getBoundingClientRect()
    const band = rowElement(element, '.band').getBoundingClientRect()
    const frame = rowElement(element, '[aria-label="box.opacity 33.333%"]').getBoundingClientRect()

    expect(band.width / lane.width).toBeCloseTo(1000 / extent)
    expect((frame.x + frame.width / 2 - lane.x) / lane.width).toBeCloseTo((0.33333 * 1000) / extent)
  })
})
