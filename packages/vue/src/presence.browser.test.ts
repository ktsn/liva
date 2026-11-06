import { afterEach, expect, it } from 'vite-plus/test'
import {
  createApp,
  defineComponent,
  h,
  nextTick,
  ref,
  resolveDirective,
  withDirectives,
  vShow,
  type App,
} from 'vue'
import { LifecycleSession, type Definition } from '@liva/runtime'
import { createLivaPlugin } from './runtime.ts'
import { LivaPresenceBoundary, type PresenceEntry } from './presence.ts'

const definition: Definition = {
  name: 'fade',
  layers: [
    { name: 'idle', targets: [{ name: 'box', properties: [{ name: 'opacity', value: '1' }] }] },
  ],
  enter: {
    timing: { kind: 'tween', durationMs: 50, easing: 'linear' },
    targets: [
      { name: 'box', properties: [{ name: 'opacity', keyframes: [{ offset: 0, value: '0' }] }] },
    ],
  },
  leave: {
    timing: { kind: 'tween', durationMs: 50, easing: 'linear' },
    targets: [
      { name: 'box', properties: [{ name: 'opacity', keyframes: [{ offset: 1, value: '0' }] }] },
    ],
  },
}
let app: App | undefined
let host: HTMLElement | undefined

afterEach(() => {
  app?.unmount()
  host?.remove()
})

async function mount(persisted: boolean, group = false, motion = definition) {
  const visible = ref(true)
  const revision = ref(0)
  const entries: PresenceEntry[] = []
  const component = defineComponent({
    livaDefinitions: [motion],
    setup() {
      const root = resolveDirective('liva')!
      const target = resolveDirective('liva-target')!
      const entryDirective = resolveDirective('liva-entry')!

      return () =>
        withDirectives(
          h('section', [
            h(
              LivaPresenceBoundary,
              { persisted, group },
              {
                default: ({ item }: { item: (key: unknown) => PresenceEntry }) =>
                  (group ? ['box', 'second'] : ['box']).flatMap((key) => {
                    const entry = item(key)

                    entries.push(entry)

                    if (!persisted && !visible.value) return []

                    const node = withDirectives(
                      h('div', { key, 'data-revision': revision.value }, 'content'),
                      [
                        [target, { owner: ['root'], entries: [entry] }, 'box', { compiled: true }],
                        [entryDirective, entry],
                      ],
                    )

                    return [persisted ? withDirectives(node, [[vShow, visible.value]]) : node]
                  }),
              },
            ),
          ]),
          [[root, { value: {}, owner: ['root'] }, 'fade', { compiled: true }]],
        )
    },
  })

  host = document.createElement('div')
  document.body.append(host)
  app = createApp(defineComponent({ setup: () => () => [h(component), h(component)] })).use(
    createLivaPlugin(),
  )
  app.mount(host)

  await nextTick()

  return { visible, revision, entries }
}

it.each([false, true])(
  'retains DOM during leave and supports re-entry (persisted=%s)',
  async (persisted) => {
    const { visible, revision, entries } = await mount(persisted)

    await expect.poll(() => host!.querySelector('div')!.getAnimations().length).toBe(0)
    expect(host!.querySelector<HTMLElement>('div')!.style.opacity).toBe('1')

    revision.value++

    await nextTick()

    expect(host!.querySelector('div')!.getAttribute('data-revision')).toBe('1')

    visible.value = false

    await nextTick()

    expect(host!.querySelector('div')).not.toBeNull()

    await expect
      .poll(() =>
        persisted
          ? host!.querySelector<HTMLElement>('div')!.style.display
          : host!.querySelector('div'),
      )
      .toBe(persisted ? 'none' : null)

    visible.value = true

    await nextTick()

    await expect.poll(() => host!.querySelector('div')!.getAnimations().length).toBe(0)
    expect(host!.querySelector<HTMLElement>('div')!.style.display).not.toBe('none')
    expect(entries.at(-1)?.leaving).toBe(false)
  },
)

it('cancels an in-progress leave when a persisted element re-enters', async () => {
  const { visible } = await mount(true)

  visible.value = false

  await nextTick()

  visible.value = true

  await nextTick()

  await expect.poll(() => host!.querySelector('div')!.getAnimations().length).toBe(0)
  expect(host!.querySelector<HTMLElement>('div')!.style.display).not.toBe('none')
})

it('runs grouped lifecycle effects and disposes pending work with the owner', async () => {
  const { visible, entries } = await mount(false, true)

  visible.value = false

  await nextTick()

  app!.unmount()
  app = undefined

  expect(entries.every((entry) => entry.targets.size === 0 && entry.element === undefined)).toBe(
    true,
  )
  expect(host!.querySelector('div')).toBeNull()
})

it('completes transitions immediately when a slot has no registered lifecycle entry', async () => {
  const shown = ref(true)

  host = document.createElement('div')
  document.body.append(host)
  app = createApp(
    defineComponent({
      setup: () => () =>
        h(LivaPresenceBoundary, null, { default: () => (shown.value ? h('div', 'plain') : null) }),
    }),
  )
  app.mount(host)

  await nextTick()

  expect(host.textContent).toBe('plain')

  shown.value = false

  await nextTick()

  expect(host.textContent).toBe('')
})

it('rebases a retained session from its displayed value before leaving', async () => {
  const { visible, entries } = await mount(false)

  await expect.poll(() => host!.querySelector('div')!.getAnimations().length).toBe(0)

  const entry = entries.find((candidate) => candidate.element === host!.querySelector('div'))!
  const element = entry.element!
  const prior = new LifecycleSession(
    [
      {
        element,
        track: {
          target: 'box',
          property: 'opacity',
          timing: { kind: 'tween', durationMs: 1000, easing: 'linear' },
          keyframes: [
            { offset: 0, value: '0.5' },
            { offset: 1, value: '1' },
          ],
          destinationValue: '1',
        },
      },
    ],
    'enter',
  )

  entry.session = prior
  prior.initialize()
  prior.play()
  visible.value = false

  await nextTick()

  expect(await prior.finished).toBe('superseded')
  await expect.poll(() => host!.querySelector('div')).toBeNull()
})

it('removes leaving content even when the browser rejects its animation timing', async () => {
  const invalid = {
    ...definition,
    leave: {
      ...definition.leave!,
      timing: { kind: 'tween', durationMs: -1, easing: 'linear' } as const,
    },
  }
  const { visible } = await mount(false, false, invalid)

  visible.value = false

  await nextTick()

  await expect.poll(() => host!.querySelector('div')).toBeNull()
})

it('releases completed group entries without removing sibling entry identities', async () => {
  const { visible, entries } = await mount(false, true)

  await expect.poll(() => host!.querySelector('div')!.getAnimations().length).toBe(0)
  expect(host!.querySelectorAll('div')).toHaveLength(4)

  visible.value = false

  await nextTick()

  await expect.poll(() => host!.querySelectorAll('div').length).toBe(0)
  expect(entries.every((entry) => entry.element === undefined)).toBe(true)
})

async function waitForRemoval() {
  await expect.poll(() => host!.querySelector('div')).toBeNull()
}

async function waitForAnimations() {
  await expect.poll(() => host!.querySelector('div')!.getAnimations().length).toBe(0)
}

it.each(['enter', 'leave'] as const)(
  'handles a superseded %s session without stale completion',
  async (phase) => {
    const motion =
      phase === 'enter'
        ? {
            ...definition,
            enter: {
              ...definition.enter!,
              timing: { kind: 'tween', durationMs: 10000, easing: 'linear' } as const,
            },
          }
        : definition
    const { visible, entries } = await mount(false, false, motion)

    if (phase === 'enter') {
      visible.value = false

      await nextTick()
      await waitForRemoval()

      visible.value = true

      await nextTick()
    }

    if (phase === 'leave') {
      await waitForAnimations()

      visible.value = false

      await nextTick()
    }

    const entry = entries.find((candidate) => candidate.element === host!.querySelector('div'))!
    const session = entry.session!

    session.cancel('superseded')

    await session.finished
    await Promise.resolve()

    expect(entry.session).toBeUndefined()
    expect(entry.element?.isConnected).toBe(true)
  },
)

it('does not erase a newer session when a superseded completion settles', async () => {
  const motion = {
    ...definition,
    enter: {
      ...definition.enter!,
      timing: { kind: 'tween', durationMs: 10000, easing: 'linear' } as const,
    },
  }
  const { visible, entries } = await mount(false, false, motion)

  visible.value = false

  await nextTick()

  await expect.poll(() => host!.querySelector('div')).toBeNull()

  visible.value = true

  await nextTick()

  const entry = entries.find((candidate) => candidate.element === host!.querySelector('div'))!
  const previous = entry.session!

  previous.cancel('superseded')

  const replacement = new LifecycleSession([], 'enter')

  entry.session = replacement

  await previous.finished
  await Promise.resolve()

  expect(entry.session).toBe(replacement)

  replacement.cancel('owner-teardown')
})
