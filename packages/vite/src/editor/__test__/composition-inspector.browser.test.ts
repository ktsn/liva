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
  it.each([
    { offset: 0, sourcePath: `${path}/value`, location: 'Layer: base' },
    {
      offset: 1,
      sourcePath: 'sample/layer/machine/state/active/target/body/property/opacity/value',
      location: 'Layer: machine · State: active',
    },
    {
      offset: undefined,
      sourcePath: 'sample/layer/machine/state/active/target/body/property/opacity/value',
      location: 'Layer: machine · State: active',
    },
  ])(
    'edits only the selected declaration at offset $offset',
    async ({ offset, sourcePath, location }) => {
      const { edits } = setup({
        offset,
        provenance: {
          ...provenance,
          to: {
            path: 'sample/layer/machine/state/active/target/body/property/opacity/value',
            text: '0.8',
            label: 'active opacity',
          },
          sharedValue: false,
        },
      })

      expect(host!.querySelector('[aria-label="Editing location"]')!.textContent).toBe(location)
      expect(host!.querySelectorAll('[aria-label="Source value"]')).toHaveLength(1)
      expect(host!.querySelector('[aria-label="Keyframe source value"]')).toBeNull()
      expect(host!.textContent).not.toMatch(/FROM|TO/)

      await input('Source value', '${amount * 2}')
      await click('Apply value')

      expect(edits).toEqual([[{ op: 'set', path: sourcePath, value: '${amount * 2}' }]])
    },
  )

  it('keeps an external starting value uneditable instead of editing the ending declaration', () => {
    setup({ offset: 0, provenance: { ...provenance, from: undefined } })

    expect(host!.querySelector('[aria-label="Editing location"]')!.textContent).toBe('External CSS')
    expect(host!.querySelector('[aria-label="Source value"]')).toBeNull()
    expect(host!.textContent).toContain('External CSS has no editable source declaration.')
  })

  it('shows and edits the selected transition keyframe without another value form', async () => {
    const destination = 'sample/layer/machine/transition/1/target/body/property/opacity'
    const { edits } = setup({
      offset: 0.5,
      provenance: {
        ...provenance,
        frameDestination: destination,
        transition: { from: 'pending', to: 'success' },
        fields: [{ path: `${destination}/frame/0.5/value`, kind: 'value', value: '0.4' }],
      },
    })

    expect(host!.querySelector('[aria-label="Editing location"]')!.textContent).toBe(
      'Layer: machine · pending → success',
    )
    expect(host!.querySelector('[aria-label="Source value"]')).toBeNull()

    await input('Keyframe source value', '0.6')
    await click('Apply keyframe')

    expect(edits[0][0]).toEqual({ op: 'set', path: `${destination}/frame/0.5/value`, value: '0.6' })
  })

  it.each([0, 1])(
    'edits an inherited explicit endpoint at %s in the selected transition',
    async (offset) => {
      const destination = 'sample/layer/machine/transition/0/target/body/property/opacity'
      const inheritedValue = offset === 0 ? '0.7' : '0.9'
      const { edits } = setup({
        offset,
        track: {
          ...track,
          fromValue: '0.2',
          toValue: '1',
          explicit: [{ offset, value: inheritedValue }],
          inheritedFrames: true,
        },
        provenance: {
          ...provenance,
          from: {
            path: 'sample/layer/machine/state/idle/target/body/property/opacity/value',
            text: '0.2',
            label: 'idle opacity',
          },
          to: {
            path: 'sample/layer/machine/state/active/target/body/property/opacity/frame/1/value',
            text: '1',
            label: 'active opacity',
          },
          frameDestination: destination,
          transition: { from: 'idle', to: 'active' },
          fields: [],
        },
      })

      expect(host!.querySelector('[aria-label="Source value"]')).toBeNull()
      expect(
        host!.querySelector<HTMLInputElement>('[aria-label="Keyframe source value"]')!.value,
      ).toBe(inheritedValue)
      expect(host!.querySelector('[aria-label="Editing location"]')!.textContent).toBe(
        'Layer: machine · idle → active',
      )

      await input('Keyframe source value', '0.8')
      await click('Add keyframe')

      expect(edits).toEqual([
        [{ op: 'addFrame', path: destination, offset, value: '0.8', easing: undefined }],
      ])
    },
  )

  it('preserves the timing expression until the user applies a replacement', async () => {
    const { edits } = setup()

    await input('Timing mode', 'spring-duration')
    await input('Track duration', '400')

    expect(edits).toEqual([])

    await click('Apply timing')

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

  it('adds a pending source keyframe at an implicit endpoint', async () => {
    const { edits } = setup({ offset: 0, pending: true })

    await input('Keyframe source value', '0')
    await click('Add keyframe')

    expect(edits).toEqual([[{ op: 'addFrame', path, offset: 0, value: '0', easing: undefined }]])
  })

  it('deletes the selected source frame', async () => {
    const { edits } = setup({ offset: 0.5 })

    await click('Delete keyframe')

    expect(edits).toEqual([[{ op: 'removeFrame', path: `${path}/frame/0.5` }]])
  })

  it('reports an unsupported easing conversion instead of replacing its expression', async () => {
    const timing: Timing = { kind: 'tween', durationMs: 200, easing: 'linear(0, 1)' }
    const { edits, errors } = setup({ track: { ...track, timing } })

    await click('Apply timing')

    expect(errors[0]).toBeInstanceOf(Error)
    expect(String(errors[0])).toContain('no typed representation')
    expect(edits).toEqual([])
  })
})
