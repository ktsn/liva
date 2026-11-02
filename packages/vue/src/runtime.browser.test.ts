import { afterEach, describe, expect, it } from 'vite-plus/test'
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
import fixture from '../../../fixtures/toggle.json'
import reactiveFixture from '../../../fixtures/reactive-toggle.json'
import { decodeBundle, type RuntimeDiagnostic } from '@liva/runtime'
import { createLivaPlugin, type InstanceBinding } from './runtime.ts'

const definition = decodeBundle(JSON.stringify(fixture)).definitions[0]
const apps: App[] = []
const hosts: HTMLElement[] = []

afterEach(() => {
  for (const app of apps.splice(0)) app.unmount()

  for (const host of hosts.splice(0)) host.remove()
})

async function mount(reactive = false, initial?: string) {
  const value = ref<string | Record<string, unknown> | undefined>(
    reactive ? { checked: false } : (initial ?? 'off'),
  )
  const name = ref('toggle')
  const shown = ref(true)
  const target = ref('thumb')
  const records: { event: string; binding: InstanceBinding }[] = []
  const errors: RuntimeDiagnostic[] = []
  const def = reactive
    ? {
        ...decodeBundle(JSON.stringify(reactiveFixture)).definitions[0],
        events: [{ name: 'ready', when: { kind: 'reference', path: ['checked'] } as const }],
      }
    : definition
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
  it('mounts targets, updates states, rejects unknown states and disposes removed roots', async () => {
    const { value, shown, records, errors, host } = await mount()
    const runtime = records[0].binding.runtime

    expect(records[0].event).toBe('mount')
    expect(host.querySelector<HTMLElement>('[data-target="thumb"]')!.style.scale).toBe('1')

    value.value = 'on'

    await nextTick()

    expect(runtime.state).toBe('on')
    expect(records.at(-1)?.binding.requestedState).toBe('on')

    value.value = 'missing'

    await nextTick()

    expect(errors.at(-1)?.code).toBe('runtime.state')
    expect(runtime.state).toBe('on')

    shown.value = false

    await nextTick()

    expect(records.at(-1)?.event).toBe('unmount')
    expect(runtime.animations).toEqual([])
    expect(host.querySelector('[data-target]')).toBeNull()
  })

  it('updates reactive parameters and reports invalid snapshots', async () => {
    const { value, records, errors, host } = await mount(true)
    const events: string[] = []

    host.addEventListener('liva-ready', (event) => events.push(event.type))
    value.value = { checked: true }

    await nextTick()

    expect(records.at(-1)?.binding.runtime.state).toBe('on')
    expect(records.at(-1)?.binding.requestedState).toBe('on')
    expect(events).toEqual(['liva-ready'])

    value.value = undefined

    await nextTick()

    expect(errors.at(-1)?.code).toBe('runtime.parameter')
  })

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

it('reports initial state failures without registering a runtime', async () => {
  const { errors, records } = await mount(false, 'missing')

  expect(errors).toContainEqual(expect.objectContaining({ code: 'vue.state' }))
  expect(records).toEqual([])
})
