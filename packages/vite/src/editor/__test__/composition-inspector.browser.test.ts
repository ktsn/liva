import { afterEach, describe, expect, it } from 'vite-plus/test'
import { createApp, nextTick, type App } from 'vue'
import type { Timing } from '@liva/runtime'
import type { Edit } from '../communication/protocol.ts'
import type { TrackProvenance } from '../provenance.ts'
import type { TimelineTrack } from '../timeline.ts'
import CompositionInspector from '../components/CompositionInspector.ce.vue'

let app: App | undefined
let host: HTMLElement | undefined

afterEach(() => {
  app?.unmount()
  host?.remove()
})

const path = 'sample/layer/base/target/body/property/opacity'
const provenance: TrackProvenance = {
  from: { path: `${path}/value`, text: '${amount}', label: 'base opacity' },
  to: { path: `${path}/value`, text: '${amount}', label: 'base opacity' },
  sharedValue: true,
  owner: 'base',
  overridden: [],
  timingDestination: path,
  timingSource: { path: 'sample/layer/base/timing', text: 'quick', label: 'base default' },
  frameDestination: path,
  fields: [
    { path: `${path}/frame/0.5/value`, kind: 'value', value: '${amount / 2}' },
    { path: `${path}/frame/0.5/easing`, kind: 'value', value: 'stepStart' },
  ],
}
const track: TimelineTrack = {
  target: 'body',
  property: 'opacity',
  path,
  duration: 200,
  timing: { kind: 'tween', durationMs: 200, easing: 'linear' },
  fromValue: '1',
  toValue: '1',
  frames: [
    { offset: 0, value: '1' },
    { offset: 0.5, value: '0.5' },
    { offset: 1, value: '1' },
  ],
  explicit: [{ offset: 0.5, value: '0.5' }],
  inheritedFrames: false,
  timingOrigin: 'base',
}

function setup(
  options: {
    track?: TimelineTrack
    provenance?: TrackProvenance
    offset?: number
    pending?: boolean
  } = {},
) {
  const edits: Edit[][] = []
  const errors: unknown[] = []
  host = document.createElement('div')
  document.body.append(host)
  app = createApp(CompositionInspector, {
    track,
    provenance,
    ...options,
    onEdit: (value: Edit[]) => edits.push(value),
    onError: (error: unknown) => errors.push(error),
  })
  app.mount(host)

  return { edits, errors }
}

async function input(label: string, value: string) {
  const element = host!.querySelector<HTMLInputElement | HTMLSelectElement>(
    `[aria-label="${label}"]`,
  )!
  element.value = value
  element.dispatchEvent(
    new Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }),
  )
  await nextTick()
}

async function click(label: string) {
  const button = [...host!.querySelectorAll('button')].find(
    (element) => element.textContent?.trim() === label,
  )

  if (!button) throw new Error(`Missing button: ${label}`)

  button.click()
  await nextTick()
}

describe('composition source inspector', () => {
  it.each(['FROM', 'TO'])(
    'edits %s at its source declaration without replacing other expressions',
    async (side) => {
      const { edits } = setup()

      await input(`${side} source value`, '${amount * 2}')
      await click(`Apply ${side} value`)

      expect(edits).toEqual([[{ op: 'set', path: `${path}/value`, value: '${amount * 2}' }]])
      expect(host!.textContent).toContain('FROM and TO share this declaration')
    },
  )

  it('preserves the timing expression until the user applies a replacement', async () => {
    const { edits } = setup()

    expect(host!.querySelector<HTMLInputElement>('[aria-label="Timing expression"]')!.value).toBe(
      'quick',
    )

    await input('Timing mode', 'spring-duration')
    await input('Track duration', '400')
    await click('Use timing parameters')

    expect(edits).toEqual([])
    expect(host!.querySelector<HTMLInputElement>('[aria-label="Timing expression"]')!.value).toBe(
      'spring(duration: 400, bounce: 0.25)',
    )

    await click('Apply timing expression')

    expect(edits).toEqual([[{ op: 'timing', path, value: 'spring(duration: 400, bounce: 0.25)' }]])
  })

  it('removes only the local timing override', async () => {
    const { edits } = setup({
      provenance: {
        ...provenance,
        localTiming: { path: `${path}/timing`, text: 'local', label: 'local' },
      },
    })

    await click('Remove timing override')

    expect(edits).toEqual([[{ op: 'timing', path }]])
  })

  it('edits frame expressions before moving their source path', async () => {
    const { edits } = setup({ offset: 0.5 })

    expect(
      host!.querySelector<HTMLInputElement>('[aria-label="Keyframe source value"]')!.value,
    ).toBe('${amount / 2}')

    await input('Keyframe source value', '${amount / 3}')
    await input('Keyframe easing expression', 'steps(count: 4)')
    await input('Keyframe percentage', '60')
    await click('Apply keyframe')

    expect(edits).toEqual([
      [
        { op: 'set', path: `${path}/frame/0.5/value`, value: '${amount / 3}' },
        { op: 'easing', path: `${path}/frame/0.5`, value: 'steps(count: 4)' },
        { op: 'set', path: `${path}/frame/0.5/offset`, value: '60%' },
      ],
    ])
  })

  it('clears segment easing without moving the frame', async () => {
    const { edits } = setup({ offset: 0.5 })

    await input('Keyframe easing expression', '')
    await click('Apply keyframe')

    expect(edits[0]).toEqual([
      { op: 'set', path: `${path}/frame/0.5/value`, value: '${amount / 2}' },
      { op: 'easing', path: `${path}/frame/0.5`, value: undefined },
    ])
  })

  it.each([true, false])(
    'adds a source keyframe at an implicit endpoint (pending=%s)',
    async (pending) => {
      const { edits } = setup({ offset: 0, pending })

      await input('Keyframe source value', '0')
      await click('Add keyframe')

      expect(edits).toEqual([[{ op: 'addFrame', path, offset: 0, value: '0', easing: undefined }]])
    },
  )

  it('deletes the selected source frame', async () => {
    const { edits } = setup({ offset: 0.5 })

    await click('Delete keyframe')

    expect(edits).toEqual([[{ op: 'removeFrame', path: `${path}/frame/0.5` }]])
  })

  it('reports an unsupported easing conversion instead of replacing its expression', async () => {
    const timing: Timing = { kind: 'tween', durationMs: 200, easing: 'linear(0, 1)' }
    const { edits, errors } = setup({ track: { ...track, timing } })

    await click('Use timing parameters')

    expect(errors[0]).toBeInstanceOf(Error)
    expect(String(errors[0])).toContain('no typed representation')
    expect(edits).toEqual([])
    expect(host!.querySelector<HTMLInputElement>('[aria-label="Timing expression"]')!.value).toBe(
      'quick',
    )
  })
})
