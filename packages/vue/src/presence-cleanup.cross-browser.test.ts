import { BrowserExecutor } from '@liva/runtime/core'
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
import { PresentationExecutor, type Definition, type RuntimeDiagnostic } from '@liva/runtime'
import { createLivaPlugin, type InstanceBinding } from './runtime.ts'
import { PresenceEntry } from './presence.ts'

const apps: App[] = []
const hosts: HTMLElement[] = []
const animations: Animation[] = []

afterEach(() => {
  for (const app of apps.splice(0)) app.unmount()
  for (const host of hosts.splice(0)) host.remove()
  for (const animation of animations.splice(0)) animation.cancel()
  vi.restoreAllMocks()
})

async function flush() {
  await nextTick()
  await Promise.resolve()
  await nextTick()
}

async function mount(
  component: ReturnType<typeof defineComponent>,
  observe: (event: 'mount' | 'update' | 'unmount', binding: InstanceBinding) => void,
) {
  const host = document.createElement('div')
  hosts.push(host)
  document.body.append(host)
  const diagnostics: RuntimeDiagnostic[] = []
  const errors: unknown[] = []
  const app = createApp(component).use(
    createLivaPlugin({ observe, onDiagnostic: (diagnostic) => diagnostics.push(diagnostic) }),
  )
  app.config.errorHandler = (error) => errors.push(error)
  apps.push(app)
  app.mount(host)
  await flush()

  return { app, host, diagnostics, errors }
}

function element(host: HTMLElement, name: string) {
  const found = host.querySelector(`[data-presence="${name}"]`)
  if (!(found instanceof HTMLElement)) throw new Error(`Missing ordinary receiver: ${name}`)

  return found
}

describe('ordinary Presence capture teardown', () => {
  it.each([
    { scope: 'root', failing: 'self', notificationFails: false },
    { scope: 'named', failing: 'first', notificationFails: false },
    { scope: 'owned', failing: 'first', notificationFails: false },
    { scope: 'owned', failing: 'second', notificationFails: true },
  ])(
    'releases $scope registrations after the native $failing source read fails',
    async ({ scope, failing, notificationFails }) => {
      const shown = ref(true)
      const bindings = new Set<InstanceBinding>()
      const entries = new Map(
        ['self', 'first', 'second'].map((name) => [name, new PresenceEntry()]),
      )
      const source: Definition = {
        name: 'ordinary',
        layers: [
          {
            name: 'base',
            targets: ['self', 'first', 'second'].map((name) => ({
              name,
              properties: [{ name: 'opacity', value: { kind: 'literal', value: '.8' } }],
            })),
          },
        ],
        leave: {
          timing: { kind: 'tween', durationMs: 1000, easing: 'linear' },
          targets: ['self', 'first', 'second'].map((name) => ({
            name,
            properties: [
              {
                name: 'opacity',
                keyframes: [{ offset: 1, value: { kind: 'literal', value: '0' } }],
              },
            ],
          })),
        },
      }
      // Callers use only the three names initialized above; no paint/layout API is needed.
      const metadata = (name: string, included: boolean) => ({
        owner: ['root'],
        value: {},
        entries: included ? [entries.get(name)!] : undefined,
      })
      const component = defineComponent({
        livaDefinitions: [source],
        setup() {
          const root = resolveDirective('liva')!
          const target = resolveDirective('liva-target')!
          const child = (name: string) =>
            withDirectives(h('span', { 'data-presence': name }, name), [
              [target, metadata(name, scope !== 'root'), name, { compiled: true }],
            ])

          return () =>
            shown.value || scope === 'named'
              ? withDirectives(
                  h(
                    'div',
                    { 'data-presence': 'self' },
                    shown.value ? [child('first'), child('second')] : [],
                  ),
                  [[root, metadata('self', scope === 'root'), 'ordinary', { compiled: true }]],
                )
              : null
        },
      })
      const cause = new Error('Native ordinary source read failed')
      const notificationCause = new Error('Unmount observer failed')
      let failNotification = notificationFails
      const main = await mount(component, (event, binding) => {
        if (event === 'mount') bindings.add(binding)
        if (event === 'unmount') {
          bindings.delete(binding)
          if (failNotification) {
            failNotification = false
            throw notificationCause
          }
        }
      })
      const old = [...bindings]
      const receiver = element(main.host, failing)
      expect(getComputedStyle(receiver).opacity).toBe('0.8')
      const otherSource: Definition = {
        name: 'other',
        layers: [
          {
            name: 'base',
            targets: [
              {
                name: 'self',
                properties: [{ name: 'opacity', value: { kind: 'literal', value: '1' } }],
              },
            ],
          },
        ],
      }
      const otherComponent = defineComponent({
        livaDefinitions: [otherSource],
        setup() {
          const root = resolveDirective('liva')!
          return () => withDirectives(h('div', { 'data-presence': 'other' }), [[root, {}, 'other']])
        },
      })
      const otherBindings = new Set<InstanceBinding>()
      const other = await mount(otherComponent, (event, binding) => {
        if (event === 'mount') otherBindings.add(binding)
        if (event === 'unmount') otherBindings.delete(binding)
      })
      const otherElement = element(other.host, 'other')
      const otherAnimation = otherElement.animate([{ opacity: '.2' }, { opacity: '.8' }], {
        duration: 1000,
        fill: 'both',
      })
      animations.push(otherAnimation)
      void otherAnimation.finished.catch(() => {})
      otherAnimation.pause()
      otherAnimation.currentTime = 333
      const otherEffect = otherAnimation.effect
      const read = window.getComputedStyle.bind(window)
      let insideCapture = false
      let faultCount = 0
      const captures: string[][] = []
      // Retain only for explicit .call(this); the real capture still observes native CSS.
      // eslint-disable-next-line typescript/unbound-method
      const capture = BrowserExecutor.prototype.capturePresence
      vi.spyOn(BrowserExecutor.prototype, 'capturePresence').mockImplementation(function (
        this: PresentationExecutor,
        phase,
        names,
        options,
      ) {
        captures.push([...names])
        insideCapture = true
        try {
          return capture.call(this, phase, names, options)
        } finally {
          insideCapture = false
        }
      })
      vi.spyOn(window, 'getComputedStyle').mockImplementation((target, pseudo) => {
        if (insideCapture && target === receiver && faultCount === 0) {
          faultCount++
          throw cause
        }
        return read(target, pseudo)
      })

      shown.value = false
      await flush()

      expect(faultCount).toBe(1)
      expect(captures).toEqual(scope === 'root' ? [['self']] : [['first'], ['second']])
      expect([...entries.values()].every((entry) => entry.targets.size === 0)).toBe(true)
      expect(main.errors).toHaveLength(1)
      const failure = main.errors[0]
      expect(failure instanceof AggregateError ? failure.cause : failure).toBe(cause)
      expect(failure instanceof AggregateError ? failure.errors : []).toEqual(
        notificationFails ? [cause, notificationCause] : [],
      )
      expect(
        old.every((binding) => binding.runtime.isDisposed && binding.bounds() === undefined),
      ).toBe(scope !== 'named')
      expect(bindings.size).toBe(scope === 'named' ? 1 : 0)
      expect(otherBindings.size).toBe(1)
      expect(otherAnimation.effect).toBe(otherEffect)
      expect(otherAnimation.currentTime).toBe(333)
      expect(otherAnimation.playState).toBe('paused')

      shown.value = true
      await flush()
      expect(bindings.size).toBe(1)
      expect(getComputedStyle(element(main.host, failing)).opacity).toBe('0.8')
      apps.splice(apps.indexOf(main.app), 1)
      main.app.unmount()
      await flush()

      expect(bindings.size).toBe(0)
      expect(
        [...entries.values()].every(
          (entry) => entry.targets.size === 0 && entry.snapshots.size === 0,
        ),
      ).toBe(true)
      expect(main.host.getAnimations({ subtree: true })).toEqual([])
      expect(otherBindings.size).toBe(1)
      expect(otherAnimation.effect).toBe(otherEffect)
      expect(otherAnimation.currentTime).toBe(333)
      expect(main.diagnostics).toEqual([])
      expect(other.diagnostics).toEqual([])
      expect(other.errors).toEqual([])
      otherAnimation.cancel()
    },
  )
})
