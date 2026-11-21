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
  type DirectiveArguments,
} from 'vue'
import { PresenceOperation, type Definition } from '@liva/runtime'
import { createLivaPlugin, type InstanceBinding } from './runtime.ts'
import { LivaPresenceBoundary, type PresenceEntry } from './presence.ts'

const definition: Definition = {
  name: 'fade',
  layers: [
    {
      name: 'idle',
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
  enter: {
    timing: { kind: 'tween', durationMs: 50, easing: 'linear' },
    targets: [
      {
        name: 'box',
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
        ],
      },
    ],
  },
  leave: {
    timing: { kind: 'tween', durationMs: 50, easing: 'linear' },
    targets: [
      {
        name: 'box',
        properties: [
          {
            name: 'opacity',
            keyframes: [
              {
                offset: 1,
                value: {
                  kind: 'literal',
                  value: '0',
                },
              },
            ],
          },
        ],
      },
    ],
  },
}
let app: App | undefined
let host: HTMLElement | undefined

afterEach(() => {
  app?.unmount()
  host?.remove()
})

async function mount(persisted: boolean, group = false, motion = definition, rootOnTarget = false) {
  const visible = ref(true)
  const revision = ref(0)
  const entries: PresenceEntry[] = []
  const records: { event: string; binding: InstanceBinding }[] = []
  const component = defineComponent({
    livaDefinitions: [motion],
    setup() {
      const root = resolveDirective('liva')!
      const target = resolveDirective('liva-target')!

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

                    const directives: DirectiveArguments = [
                      [target, { owner: ['root'], entries: [entry] }, 'box', { compiled: true }],
                    ]

                    if (rootOnTarget)
                      directives.push([
                        root,
                        { value: {}, owner: ['root'], entries: [entry] },
                        'fade',
                        { compiled: true },
                      ])

                    const node = withDirectives(
                      h(
                        'div',
                        { ...entry.elementHooks, key, 'data-revision': revision.value },
                        'content',
                      ),
                      directives,
                    )

                    return [persisted ? withDirectives(node, [[vShow, visible.value]]) : node]
                  }),
              },
            ),
          ]),
          rootOnTarget ? [] : [[root, { value: {}, owner: ['root'] }, 'fade', { compiled: true }]],
        )
    },
  })

  host = document.createElement('div')
  document.body.append(host)
  app = createApp(defineComponent({ setup: () => () => [h(component), h(component)] })).use(
    createLivaPlugin({ observe: (event, binding) => records.push({ event, binding }) }),
  )
  app.mount(host)

  await nextTick()

  return { visible, revision, entries, records }
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

it('rebases interrupted enter from a Vue teardown snapshot before detached leave starts', async () => {
  const motion: Definition = {
    ...definition,
    enter: { ...definition.enter!, timing: { kind: 'tween', durationMs: 1000, easing: 'linear' } },
    leave: {
      timing: { kind: 'tween', durationMs: 1000, easing: 'linear' },
      targets: [
        {
          name: 'box',
          properties: [
            {
              name: 'opacity',
              keyframes: [
                { offset: 0, value: { kind: 'literal', value: '0.9' } },
                { offset: 1, value: { kind: 'literal', value: '0' } },
              ],
            },
          ],
        },
      ],
    },
  }
  const { visible, records } = await mount(false, false, motion, true)
  const element = host!.querySelector<HTMLElement>('div')!

  await expect.poll(() => element.getAnimations().length).toBe(1)

  const enter = element.getAnimations()[0]
  enter.pause()
  enter.currentTime = 400
  const displayed = Number(getComputedStyle(element).opacity)

  visible.value = false

  await nextTick()

  expect(records.filter((record) => record.event === 'unmount')).toHaveLength(2)
  expect(visible.value).toBe(false)
  expect(element.isConnected).toBe(true)

  const leave = element.getAnimations()[0]
  const effect = leave.effect

  if (!(effect instanceof KeyframeEffect)) throw new Error('Expected detached leave effect')

  // Browser opacity serialization retains at least five decimal places for this exact paused sample.
  expect(Number(effect.getKeyframes()[0].opacity)).toBeCloseTo(displayed, 5)
  expect(leave).not.toBe(enter)

  for (const target of host!.querySelectorAll('div')) {
    for (const animation of target.getAnimations()) animation.finish()
  }

  await expect.poll(() => host!.querySelector('div')).toBeNull()

  expect(records.every((record) => record.binding.runtime.onUpdate === undefined)).toBe(true)
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
  const prior = new PresenceOperation(entry.capture('enter'), 'enter')

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

  const replacement = new PresenceOperation([], 'enter')

  entry.session = replacement

  await previous.finished
  await Promise.resolve()

  expect(entry.session).toBe(replacement)

  replacement.cancel('owner-teardown')
})

it.each([false, true])(
  'animates implicit self and an optional root alias through enter/leave (alias=%s)',
  async (alias) => {
    const visible = ref(true)
    const errors: unknown[] = []
    const motion: Definition = {
      name: 'selfFade',
      layers: [
        {
          name: 'base',
          targets: [
            {
              name: 'self',
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
            ...(alias
              ? [
                  {
                    name: 'box',
                    properties: [
                      {
                        name: 'scale',
                        value: {
                          kind: 'literal' as const,
                          value: '1',
                        },
                      },
                    ],
                  },
                ]
              : []),
          ],
        },
      ],
      enter: {
        timing: { kind: 'tween', durationMs: 50, easing: 'linear' },
        targets: [
          {
            name: 'self',
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
            ],
          },
          ...(alias
            ? [
                {
                  name: 'box',
                  properties: [
                    {
                      name: 'scale',
                      keyframes: [{ offset: 0, value: { kind: 'literal' as const, value: '.8' } }],
                    },
                  ],
                },
              ]
            : []),
        ],
      },
      leave: {
        timing: { kind: 'tween', durationMs: 100, easing: 'linear' },
        targets: [
          {
            name: 'self',
            properties: [
              {
                name: 'opacity',
                keyframes: [
                  {
                    offset: 1,
                    value: {
                      kind: 'literal',
                      value: '0',
                    },
                  },
                ],
              },
            ],
          },
          ...(alias
            ? [
                {
                  name: 'box',
                  properties: [
                    {
                      name: 'scale',
                      keyframes: [{ offset: 1, value: { kind: 'literal' as const, value: '.8' } }],
                    },
                  ],
                },
              ]
            : []),
        ],
      },
    }
    const component = defineComponent({
      livaDefinitions: [motion],
      setup() {
        const root = resolveDirective('liva')!
        const target = resolveDirective('liva-target')!
        const entryDirective = resolveDirective('liva-entry')!

        return () =>
          h(
            LivaPresenceBoundary,
            {},
            {
              default: ({ item }: { item: (key: unknown) => PresenceEntry }) => {
                const entry = item('root')

                return visible.value
                  ? withDirectives(
                      withDirectives(
                        h('button', { key: 'root', 'data-self': '' }, 'Self'),
                        alias
                          ? [
                              [
                                target,
                                { owner: ['self'], entries: [entry] },
                                'box',
                                { compiled: true },
                              ],
                            ]
                          : [],
                      ),
                      [
                        [
                          root,
                          { value: {}, owner: ['self'], entries: [entry] },
                          'selfFade',
                          { compiled: true },
                        ],
                        [entryDirective, entry],
                      ],
                    )
                  : null
              },
            },
          )
      },
    })
    host = document.createElement('div')
    document.body.append(host)
    app = createApp(component).use(
      createLivaPlugin({ onDiagnostic: (error) => errors.push(error) }),
    )
    app.mount(host)

    await nextTick()
    await expect.poll(() => host!.querySelector('button')!.getAnimations().length).toBe(0)

    expect(host.querySelector<HTMLElement>('button')!.style.opacity).toBe('1')
    expect(host.querySelector<HTMLElement>('button')!.style.scale).toBe(alias ? '1' : '')

    visible.value = false

    await nextTick()

    expect(host.querySelector('button')).not.toBeNull()

    await expect.poll(() => host!.querySelector('button')).toBeNull()

    visible.value = true

    await nextTick()
    await expect.poll(() => host!.querySelector('button')!.getAnimations().length).toBe(0)

    expect(host.querySelector<HTMLElement>('button')!.style.opacity).toBe('1')
    expect(host.querySelector<HTMLElement>('button')!.style.scale).toBe(alias ? '1' : '')
    expect(errors).toEqual([])
  },
)
