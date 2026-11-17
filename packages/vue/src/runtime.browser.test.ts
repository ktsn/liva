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
import { createLivaPlugin, type InstanceBinding } from './runtime.ts'

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
      observe: (event, binding) => records.push({ event, binding }),
      onDiagnostic: (error) => errors.push(error),
    }),
  )

  apps.push(app)
  app.mount(host)

  await nextTick()
  await Promise.resolve()

  return { value, name, shown, target, records, errors, host }
}

describe('Vue motion directives', () => {
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
    expect(records[0].binding.executor.animations).toEqual([])
    expect(host.querySelector('[data-target]')).toBeNull()
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

      expect(errors).toContainEqual(
        expect.objectContaining({
          code: 'vue.initialization',
          error: expect.objectContaining({ message: 'Motion inputs must be a parameter object' }),
        }),
      )
      expect(records).toEqual([])
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
