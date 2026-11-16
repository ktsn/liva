import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import {
  createApp,
  defineComponent,
  h,
  nextTick,
  ref,
  resolveDirective,
  withDirectives,
  type App,
} from 'vue'
import constrainedFixture from '../../../fixtures/constrained.json'
import fixture from '../../../fixtures/toggle.json'
import reactiveFixture from '../../../fixtures/reactive-toggle.json'
import { decodeBundle, type Definition, type RuntimeDiagnostic } from '@liva/runtime'
import * as functions from '../../runtime/src/builtins/index.ts'
import { createLivaPlugin, type InstanceBinding, type LivaOptions } from './runtime.ts'

vi.mock('../../runtime/src/builtins/index.ts', { spy: true })

const definition = decodeBundle(JSON.stringify(fixture)).definitions[0]
const apps: App[] = []
const hosts: HTMLElement[] = []

afterEach(() => {
  for (const app of apps.splice(0)) app.unmount()

  for (const host of hosts.splice(0)) host.remove()
})

async function mount(
  reactive = false,
  initial?: string | Record<string, unknown> | null,
  override?: Definition,
  source?: LivaOptions['source'],
) {
  const value = ref<string | Record<string, unknown> | null | undefined>(
    reactive ? { checked: false } : initial === undefined ? { mode: 'off' } : initial,
  )
  const name = ref(override?.name ?? 'toggle')
  const shown = ref(true)
  const target = ref('thumb')
  const records: { event: string; binding: InstanceBinding }[] = []
  const errors: RuntimeDiagnostic[] = []
  const def =
    override ??
    (reactive
      ? {
          ...decodeBundle(JSON.stringify(reactiveFixture)).definitions[0],
          events: [{ name: 'ready', when: { kind: 'reference', path: ['checked'] } as const }],
        }
      : definition)
  const component = defineComponent({
    livaDefinitions: [def],
    setup() {
      const liva = resolveDirective('liva')!
      const bind = resolveDirective('liva-target')!

      return () =>
        shown.value
          ? withDirectives(
              h('div', [
                withDirectives(h('div', { 'data-target': 'track' }), [[bind, undefined, 'track']]),
                withDirectives(h('div', { 'data-target': 'thumb' }), [
                  [bind, undefined, target.value],
                ]),
              ]),
              [[liva, value.value, name.value]],
            )
          : null
    },
  })
  const host = document.createElement('div')

  document.body.append(host)
  hosts.push(host)

  const app = createApp(component).use(
    createLivaPlugin({
      source,
      observe: (event, binding) => records.push({ event, binding }),
      onDiagnostic: (error) => errors.push(error),
    }),
  )

  apps.push(app)
  app.mount(host)

  await nextTick()
  await Promise.resolve()

  return { value, name, shown, target, records, errors, host, app }
}

describe('Vue motion directives', () => {
  it.each([undefined, 'Accessible motion'])(
    'publishes label metadata after created-hook DOM setup and reads fresh bounds on demand: %s',
    async (label) => {
      const records: InstanceBinding[] = []
      const component = defineComponent({
        livaDefinitions: [{ name: 'metadata', layers: [] }],
        setup() {
          const directive = resolveDirective('liva')!

          return () =>
            withDirectives(h('div', { 'aria-label': label, style: { width: '24px' } }, 'Ready'), [
              [directive, undefined, 'metadata'],
            ])
        },
      })
      const host = document.createElement('div')
      document.body.append(host)
      hosts.push(host)
      const app = createApp(component).use(
        createLivaPlugin({
          observe(event, binding) {
            if (event === 'mount') records.push(binding)
          },
        }),
      )
      apps.push(app)

      app.mount(host)

      await nextTick()

      const binding = records[0]
      const element = host.firstElementChild
      if (!(element instanceof HTMLElement)) throw new Error('Expected mounted motion root')
      const read = vi.spyOn(element, 'getBoundingClientRect')

      expect(binding.label).toBe(label ?? 'metadata Ready')
      expect(Object.hasOwn(binding, 'root')).toBe(false)
      expect(Object.hasOwn(binding, 'executor')).toBe(false)
      expect(Object.values(binding).some((value) => value instanceof HTMLElement)).toBe(false)
      expect(read).not.toHaveBeenCalled()

      expect(binding.bounds()?.width).toBe(24)
      element.style.width = '48px'
      expect(binding.bounds()?.width).toBe(48)
      expect(read).toHaveBeenCalledTimes(2)

      app.unmount()

      apps.splice(apps.indexOf(app), 1)

      expect(binding.bounds()).toBeUndefined()
      expect(read).toHaveBeenCalledTimes(2)
      read.mockRestore()
    },
  )

  it('mounts targets, updates inputs, rejects invalid parameters and disposes removed roots', async () => {
    const { value, shown, records, errors, host } = await mount()
    const runtime = records[0].binding.runtime

    expect(records[0].event).toBe('mount')
    expect(host.querySelector<HTMLElement>('[data-target="thumb"]')!.style.scale).toBe('1')

    value.value = { mode: 'on' }

    await nextTick()

    expect(runtime.composition.states.toggle).toBe('on')

    value.value = { mode: false }

    await nextTick()

    expect(errors.at(-1)?.code).toBe('runtime.parameter')
    expect(runtime.composition.states.toggle).toBe('on')

    shown.value = false

    await nextTick()

    expect(records.at(-1)?.event).toBe('unmount')
    expect(runtime.isDisposed).toBe(true)
    expect(host.querySelector('[data-target]')).toBeNull()
  })

  it('unregisters observer metadata and bounds and cleans native effects after a call disposer fails', async () => {
    const failure = new Error('Call disposer failed')
    const factory = vi.spyOn(functions, 'callBuiltin').mockReturnValue({
      value: 1,
      bind: () => () => {},
      prepareUpdate: () => ({ value: 1, commit() {}, discard() {} }),
      dispose() {
        throw failure
      },
    })
    const source = {
      ...definition,
      letBindings: [
        {
          name: 'value',
          initializer: { kind: 'call' as const, function: 'resource', arguments: [] },
        },
      ],
    }

    try {
      const { records, errors, host, value, app } = await mount(false, undefined, source)
      const binding = records[0].binding
      value.value = { mode: 'on' }

      await nextTick()

      const effects = host.getAnimations({ subtree: true })
      for (const effect of effects) effect.pause()
      expect(effects.length).toBeGreaterThan(0)

      apps.splice(apps.indexOf(app), 1)
      app.unmount()

      expect(records.at(-1)?.event).toBe('unmount')
      expect(records.at(-1)?.binding).toBe(binding)
      expect(binding.bounds()).toBeUndefined()
      expect(host.getAnimations({ subtree: true })).toEqual([])
      expect(errors.map(({ code, error }) => ({ code, error }))).toEqual([
        { code: 'vue.disposal', error: failure },
      ])
    } finally {
      factory.mockRestore()
    }
  })

  it('reports source metadata extraction failure before constructing application resources', async () => {
    const failure = new Error('Source metadata failed')
    const factory = vi.spyOn(functions, 'callBuiltin')
    const source: Definition = {
      name: 'metadata-failure',
      layers: [],
      letBindings: [
        { name: 'value', initializer: { kind: 'call', function: 'resource', arguments: [] } },
      ],
    }

    try {
      const { records, errors } = await mount(false, {}, source, () => {
        throw failure
      })

      expect(records).toEqual([])
      expect(factory).not.toHaveBeenCalled()
      expect(errors.map(({ code, error }) => ({ code, error }))).toEqual([
        { code: 'vue.initialization', error: failure },
      ])
    } finally {
      factory.mockRestore()
    }
  })

  it.each([false, true])(
    'cleans assembled runtime calls after attachment failure with cleanup failure=%s',
    async (cleanupFails) => {
      const failure = new Error('Media query setup failed')
      const cleanupFailure = new Error('Call cleanup failed')
      const dispose = vi.fn<() => void>(() => {
        if (cleanupFails) throw cleanupFailure
      })
      const factory = vi.spyOn(functions, 'callBuiltin').mockReturnValue({
        value: 1,
        bind: () => () => {},
        prepareUpdate: () => {
          throw new Error('No updates in this scenario')
        },
        dispose,
      })
      const media = vi.spyOn(window, 'matchMedia').mockImplementationOnce(() => {
        throw failure
      })
      const source: Definition = {
        name: 'initialization',
        layers: [],
        letBindings: [
          { name: 'value', initializer: { kind: 'call', function: 'source', arguments: [] } },
        ],
      }

      try {
        const { records, errors } = await mount(false, {}, source)
        const expected = [
          ...(cleanupFails ? [{ code: 'vue.initialization-cleanup', error: cleanupFailure }] : []),
          { code: 'vue.initialization', error: failure },
        ]

        expect(records).toEqual([])
        expect(dispose).toHaveBeenCalledTimes(1)
        expect(errors.map(({ code, error }) => ({ code, error }))).toEqual(expected)
      } finally {
        media.mockRestore()
        factory.mockRestore()
      }
    },
  )

  it('drives compiler-declared string choices through Vue and preserves the last valid state', async () => {
    const source = decodeBundle(JSON.stringify(constrainedFixture)).definitions[0]

    const { value, errors, host } = await mount(false, { position: 'end', axis: 'x' }, source)
    const thumb = host.querySelector<HTMLElement>('[data-target="thumb"]')

    expect(thumb?.style.opacity).toBe('0.25')
    expect(thumb?.style.getPropertyValue('--position')).toBe('end')

    value.value = { position: 'start', axis: 'x' }

    await nextTick()

    expect(thumb?.style.opacity).toBe('1')
    expect(thumb?.style.getPropertyValue('--position')).toBe('start')

    value.value = { position: 'end', axis: 'y' }

    await nextTick()

    expect(errors.at(-1)?.code).toBe('runtime.parameter')
    expect(thumb?.style.opacity).toBe('1')
    expect(thumb?.style.getPropertyValue('--position')).toBe('start')
    expect(thumb?.style.getPropertyValue('--axis')).toBe('x')

    value.value = { position: 'end', axis: 'x' }

    await nextTick()

    expect(thumb?.style.opacity).toBe('0.25')
    expect(thumb?.style.getPropertyValue('--position')).toBe('end')
  })

  it('updates reactive parameters and reports invalid snapshots', async () => {
    const { value, records, errors, host } = await mount(true)
    const events: string[] = []

    host.addEventListener('liva-ready', (event) => events.push(event.type))
    value.value = { checked: true }

    await nextTick()

    expect(records.at(-1)?.binding.runtime.composition.states.toggle).toBe('on')
    expect(events).toEqual(['liva-ready'])

    value.value = undefined

    await nextTick()

    expect(errors.at(-1)?.code).toBe('runtime.parameter')
  })

  it.each(['missing', null])(
    'reports invalid initialization inputs without registering a runtime: %j',
    async (inputs) => {
      const { errors, records } = await mount(false, inputs)

      expect(records).toEqual([])
      expect(errors).toContainEqual(
        expect.objectContaining({
          code: 'vue.initialization',
          error: expect.objectContaining({ message: 'Motion inputs must be a parameter object' }),
        }),
      )
    },
  )

  it('reports missing definitions, recovers on updates and reconciles removed target names', async () => {
    const { name, target, records, errors } = await mount()

    name.value = 'missing'

    await nextTick()

    expect(errors.at(-1)?.code).toBe('vue.definition')

    name.value = 'toggle'

    await nextTick()

    expect(records.at(-1)?.event).toBe('mount')

    target.value = ''

    await nextTick()
    await Promise.resolve()

    expect(errors.at(-1)?.code).toBe('runtime.targets')
  })
})

describe('built-in self target', () => {
  it('binds each root independently and restores styles when a root is replaced or disposed', async () => {
    const shown = ref(true)
    const key = ref(0)
    const errors: RuntimeDiagnostic[] = []
    const component = defineComponent({
      livaDefinitions: [
        {
          name: 'root',
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
                        value: '.4',
                      },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
      setup() {
        const liva = resolveDirective('liva')!

        return () =>
          shown.value
            ? [0, 1].map((id) =>
                withDirectives(
                  h('div', {
                    key: `${id}:${key.value}`,
                    'data-root': id,
                    style: { opacity: '0.9' },
                  }),
                  [[liva, undefined, 'root']],
                ),
              )
            : null
      },
    })
    const host = document.createElement('div')
    const app = createApp(component).use(
      createLivaPlugin({ onDiagnostic: (error) => errors.push(error) }),
    )
    hosts.push(host)
    apps.push(app)
    document.body.append(host)
    app.mount(host)

    await nextTick()
    await Promise.resolve()

    const original = host.querySelectorAll<HTMLElement>('[data-root]')

    expect([...original].map((root) => root.style.opacity)).toEqual(['0.4', '0.4'])

    key.value++

    await nextTick()
    await Promise.resolve()

    expect([...original].map((root) => root.style.opacity)).toEqual(['0.9', '0.9'])
    expect(
      [...host.querySelectorAll<HTMLElement>('[data-root]')].map((root) => root.style.opacity),
    ).toEqual(['0.4', '0.4'])

    shown.value = false

    await nextTick()

    expect(host.querySelector('[data-root]')).toBeNull()
    expect(errors).toEqual([])
  })
})
