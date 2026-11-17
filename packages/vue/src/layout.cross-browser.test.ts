import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import {
  createApp,
  KeepAlive,
  Suspense,
  Teleport,
  defineComponent,
  h,
  nextTick,
  ref,
  resolveDirective,
  withDirectives,
  type App,
  type VNode,
} from 'vue'
import {
  LayoutCoordinator,
  PresentationExecutor,
  type Definition,
  type LayoutAxes,
  type RuntimeDiagnostic,
} from '@liva/runtime'
import { createLivaPlugin } from './runtime.ts'
import { LivaPresenceBoundary, type PresenceEntry } from './presence.ts'
import { measure } from '../../runtime/src/builtins/measure.ts'
import { readLayoutBounds } from '../../runtime/src/layout/layout-bounds.ts'

const all: LayoutAxes = { x: true, y: true, width: true, height: true }
const apps: App[] = []
const hosts: HTMLElement[] = []
let time = 1000
let frames: Map<number, FrameRequestCallback>
let nextFrame = 0
let nativeFrame: (callback: FrameRequestCallback) => number

function definition(): Definition {
  return {
    name: 'item',
    layers: [
      {
        name: 'base',
        targets: [
          {
            name: 'self',
            properties: [
              {
                kind: 'layout',
                name: '$layout',
                axes: all,
                timing: { kind: 'tween', durationMs: 1000, easing: 'linear' },
              },
            ],
          },
        ],
      },
    ],
  }
}

type Bindings = {
  root(this: void, node: VNode, inputs?: Record<string, unknown>): VNode
  target(this: void, node: VNode, name: string): VNode
}

function motionComponent(source: Definition, render: (bindings: Bindings) => VNode | VNode[]) {
  return defineComponent({
    livaDefinitions: [source],
    setup() {
      const root = resolveDirective('liva')!
      const target = resolveDirective('liva-target')!
      const bindings: Bindings = {
        root: (node, inputs = {}) => withDirectives(node, [[root, inputs, source.name]]),
        target: (node, name) => withDirectives(node, [[target, undefined, name]]),
      }

      return () => render(bindings)
    },
  })
}

async function nativeTurn() {
  await new Promise<void>((resolve) => nativeFrame(() => resolve()))
}

function frame(milliseconds: number) {
  time += milliseconds
  const pending = [...frames.values()]
  frames.clear()

  for (const callback of pending) callback(time)
}

async function flush() {
  await nextTick()
  await Promise.resolve()
}

async function mount(component: ReturnType<typeof defineComponent>) {
  const host = document.createElement('div')
  document.body.append(host)
  hosts.push(host)
  const errors: RuntimeDiagnostic[] = []
  const app = createApp(component).use(
    createLivaPlugin({ onDiagnostic: (error) => errors.push(error) }),
  )
  apps.push(app)
  app.mount(host)
  await flush()

  return { host, errors, app }
}

function element(host: HTMLElement, selector = '[data-item]'): HTMLElement {
  const target = host.querySelector(selector)
  if (!(target instanceof HTMLElement)) throw new Error(`Missing ${selector}`)
  return target
}

function markers() {
  return [
    [0, 0],
    [100, 0],
    [100, 100],
    [0, 100],
  ].map(([x, y]) =>
    h('i', {
      'data-corner': '',
      style: { position: 'absolute', left: `${x}%`, top: `${y}%`, width: '0px', height: '0px' },
    }),
  )
}

function corners(target: HTMLElement) {
  return [...target.querySelectorAll('[data-corner]')].map((marker) => {
    const rect = marker.getBoundingClientRect()
    return { x: rect.x, y: rect.y }
  })
}

beforeEach(() => {
  time = 1000
  frames = new Map()
  nativeFrame = window.requestAnimationFrame.bind(window)
  vi.spyOn(performance, 'now').mockImplementation(() => time)
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    frames.set(++nextFrame, callback)
    return nextFrame
  })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
    frames.delete(id)
  })
})

afterEach(async () => {
  for (const app of apps.splice(0)) app.unmount()
  await flush()
  for (const host of hosts.splice(0)) host.remove()
  vi.restoreAllMocks()
})

describe('Vue coordinated layout projection', () => {
  it('installs position/size correction before paint while destination dimensions stay in layout', async () => {
    const expanded = ref(false)
    const { host, errors } = await mount(
      motionComponent(definition(), ({ root }) =>
        root(
          h('div', {
            'data-item': '',
            style: {
              marginLeft: expanded.value ? '120px' : '20px',
              width: expanded.value ? '200px' : '100px',
              height: expanded.value ? '80px' : '40px',
            },
          }),
        ),
      ),
    )
    const target = element(host)
    const before = target.getBoundingClientRect()
    expect(target.style.transform).toBe('')

    expanded.value = true
    await flush()
    const first = target.getBoundingClientRect()
    expect(first.x).toBeCloseTo(before.x, 3)
    expect(first.width).toBeCloseTo(100, 3)
    expect(first.height).toBeCloseTo(40, 3)
    expect(target.style.width).toBe('200px')
    expect(target.style.height).toBe('80px')

    frame(500)
    expect(target.getBoundingClientRect().width).toBeCloseTo(150, 3)
    expect(target.getBoundingClientRect().x).toBeCloseTo(before.x + 50, 3)
    frame(500)
    expect(target.style.transform).toBe('')
    expect(target.getBoundingClientRect().width).toBe(200)
    expect(errors).toEqual([])
  })

  it('captures keyed neighbors without requiring their components to render', async () => {
    const order = ref([0, 1, 2])
    const renders = [0, 0, 0]
    const item = defineComponent({
      props: { id: { type: Number, required: true } },
      livaDefinitions: [definition()],
      setup(props) {
        const directive = resolveDirective('liva')!
        return () => {
          renders[props.id]++
          return withDirectives(
            h('div', {
              'data-item': props.id,
              style: { width: '100px', height: `${30 + props.id * 10}px` },
            }),
            [[directive, {}, 'item']],
          )
        }
      },
    })
    const { host, errors } = await mount(
      defineComponent({
        setup: () => () =>
          h(
            'div',
            order.value.map((id) => h(item, { id, key: id })),
          ),
      }),
    )
    const targets = order.value.map((id) => element(host, `[data-item="${id}"]`))
    const before = targets.map((target) => target.getBoundingClientRect().y)

    order.value = [2, 0, 1]
    await flush()
    expect(renders).toEqual([1, 1, 1])
    expect(targets.map((target) => target.getBoundingClientRect().y)).toEqual(before)
    expect([...host.querySelectorAll('[data-item]')]).toEqual([targets[2], targets[0], targets[1]])

    frame(1000)
    expect(targets.map((target) => target.style.transform)).toEqual(['', '', ''])
    expect(errors).toEqual([])
  })

  it('preserves the full displayed child shape when enabling under an active anisotropic parent and affine intermediate', async () => {
    const expanded = ref(false)
    const enabled = ref(false)
    const source: Definition = {
      ...definition(),
      parameters: [{ name: 'enabled', type: 'boolean' }],
      layers: [
        ...definition().layers,
        {
          name: 'child',
          when: { kind: 'reference', path: ['enabled'] },
          targets: [
            {
              name: 'child',
              properties: [
                {
                  kind: 'layout',
                  name: '$layout',
                  axes: all,
                  timing: { kind: 'tween', durationMs: 1000, easing: 'linear' },
                },
              ],
            },
          ],
        },
      ],
    }
    const { host, errors } = await mount(
      motionComponent(source, ({ root, target }) =>
        root(
          h(
            'div',
            {
              'data-item': '',
              style: {
                width: expanded.value ? '200px' : '100px',
                height: expanded.value ? '240px' : '80px',
              },
            },
            [
              h(
                'div',
                {
                  style: {
                    width: '100px',
                    height: '60px',
                    transform: 'rotate(25deg) skewX(12deg)',
                    transformOrigin: '0 0',
                  },
                },
                [
                  target(
                    h(
                      'div',
                      {
                        'data-child': '',
                        style: {
                          position: 'relative',
                          width: enabled.value ? '60px' : '40px',
                          height: '20px',
                        },
                      },
                      markers(),
                    ),
                    'child',
                  ),
                ],
              ),
            ],
          ),
          { enabled: enabled.value },
        ),
      ),
    )
    const child = element(host, '[data-child]')
    expanded.value = true
    await flush()
    frame(250)
    const before = child.getBoundingClientRect()
    const previousCorners = corners(child)

    enabled.value = true
    await flush()
    const first = child.getBoundingClientRect()
    expect(first.x).toBeCloseTo(before.x, 3)
    expect(first.y).toBeCloseTo(before.y, 3)
    expect(first.width).toBeCloseTo(before.width, 3)
    expect(first.height).toBeCloseTo(before.height, 3)
    corners(child).forEach((point, index) => {
      expect(point.x).toBeCloseTo(previousCorners[index].x, 3)
      expect(point.y).toBeCloseTo(previousCorners[index].y, 3)
    })
    expect(errors).toEqual([])
  })
  it('captures fresh disabled-period geometry when enabling and resizing in one Vue update', async () => {
    const width = ref(40)
    const enabled = ref(false)
    const source: Definition = {
      ...definition(),
      parameters: [{ name: 'enabled', type: 'boolean' }],
      layers: [{ ...definition().layers[0], when: { kind: 'reference', path: ['enabled'] } }],
    }
    const { host, errors } = await mount(
      motionComponent(source, ({ root }) =>
        root(h('div', { 'data-item': '', style: { width: `${width.value}px`, height: '20px' } }), {
          enabled: enabled.value,
        }),
      ),
    )
    const target = element(host)
    target.style.width = '60px'
    frame(1000)
    expect(target.style.transform).toBe('')

    enabled.value = true
    width.value = 80
    await flush()
    expect(target.getBoundingClientRect().width).toBeCloseTo(60, 3)
    frame(1000)
    expect(target.getBoundingClientRect().width).toBe(80)
    expect(errors).toEqual([])
  })

  it('reports scheduler restoration output failure, releases projection and stops pending work', async () => {
    const width = ref(100)
    const { host, errors } = await mount(
      motionComponent(definition(), ({ root }) =>
        root(h('div', { 'data-item': '', style: { width: `${width.value}px`, height: '40px' } })),
      ),
    )
    width.value = 200
    await flush()
    const target = element(host)
    const cause = new Error('Style output failed')
    const write = vi.spyOn(target.style, 'setProperty').mockImplementationOnce(() => {
      throw cause
    })

    // Force the shared observation callback, rather than relying only on the
    // coordinator's projection RAF catch. Restoration runs after publications.
    window.dispatchEvent(new Event('resize'))
    frame(0)
    expect(target.style.transform).toBe('')
    expect(errors.at(-1)?.error).toBe(cause)
    write.mockRestore()
    const reads = vi.spyOn(target, 'getBoundingClientRect')
    frame(500)
    expect(reads).not.toHaveBeenCalled()
  })

  it('preserves an active trajectory across an unrelated Vue update', async () => {
    const width = ref(100)
    const unrelated = ref(0)
    const { host, errors } = await mount(
      motionComponent(definition(), ({ root }) => [
        h('span', unrelated.value),
        root(h('div', { 'data-item': '', style: { width: `${width.value}px`, height: '40px' } })),
      ]),
    )
    const target = element(host)
    width.value = 200
    await flush()
    frame(250)
    expect(target.getBoundingClientRect().width).toBeCloseTo(125, 3)

    unrelated.value++
    await flush()
    frame(250)
    expect(target.getBoundingClientRect().width).toBeCloseTo(150, 3)
    frame(500)
    expect(target.style.transform).toBe('')
    expect(errors).toEqual([])
  })
  it.each(
    ['WAAPI', 'CSS animation', 'CSS transition'].flatMap((kind) =>
      [false, true].map((important) => ({ kind, important })),
    ),
  )(
    'preserves an active ancestor effect through synchronous collection: %j',
    async ({ kind, important }) => {
      const width = ref(100)
      const { host, errors } = await mount(
        motionComponent(definition(), ({ root }) => [
          h(
            'style',
            `.liva-observation-ancestor { transform: rotate(0deg) ${important ? '!important' : ''}; } .liva-observation-ancestor.active { transform: rotate(40deg) ${important ? '!important' : ''}; } @keyframes liva-layout-observation { from { transform: rotate(0deg); } to { transform: rotate(40deg); } }`,
          ),
          h(
            'div',
            {
              'data-ancestor': '',
              class: 'liva-observation-ancestor',
              style: {
                width: '300px',
                height: '100px',
                transformOrigin: '0 0',
              },
            },
            [
              root(
                h('div', { 'data-item': '', style: { width: `${width.value}px`, height: '40px' } }),
              ),
            ],
          ),
        ]),
      )
      const ancestor = element(host, '[data-ancestor]')
      const events: string[] = []
      for (const name of [
        'transitionrun',
        'transitionstart',
        'transitioncancel',
        'transitionend',
        'animationstart',
        'animationcancel',
        'animationend',
      ])
        ancestor.addEventListener(name, (event) => events.push(event.type))
      let animation: Animation

      if (kind === 'WAAPI') {
        animation = ancestor.animate(
          [{ transform: 'rotate(0deg)' }, { transform: 'rotate(40deg)' }],
          { duration: 1000, easing: 'linear', fill: 'both' },
        )
      } else {
        if (kind === 'CSS animation') {
          ancestor.style.animation = 'liva-layout-observation 1000ms linear both'
        } else {
          ancestor.style.transition = 'transform 1000ms linear'
          getComputedStyle(ancestor).getPropertyValue('transform')
          ancestor.classList.add('active')
        }
        const effects = ancestor.getAnimations()
        animation = effects[0]
      }
      expect(ancestor.getAnimations()).toHaveLength(1)
      void animation.finished.catch(() => undefined)
      await animation.ready
      animation.pause()
      animation.currentTime = 250
      const completion = animation.finished
      const effect = animation.effect
      const keyframes = effect instanceof KeyframeEffect ? effect.getKeyframes() : []
      const presentation = getComputedStyle(ancestor).transform
      const endTime = effect?.getComputedTiming().endTime
      const sourceCss = ancestor.style.cssText
      await nativeTurn()
      await nativeTurn()
      events.length = 0

      width.value = 200
      await flush()

      expect(ancestor.getAnimations()).toHaveLength(1)
      expect(ancestor.getAnimations()[0]).toBe(animation)
      expect(effect instanceof KeyframeEffect ? effect.getKeyframes() : []).toEqual(keyframes)
      expect(animation.effect).toBe(effect)
      expect(animation.playState).toBe('paused')
      expect(animation.currentTime).toBe(250)
      expect(animation.finished).toBe(completion)
      expect(getComputedStyle(ancestor).transform).toBe(presentation)
      expect(ancestor.style.cssText).toBe(sourceCss)
      expect(effect?.getComputedTiming().endTime).toBe(endTime)
      await nativeTurn()
      await nativeTurn()
      expect(events).toEqual([])
      animation.finish()
      await completion
      expect(animation.playState).toBe('finished')
      await nativeTurn()
      await nativeTurn()
      const endEvent =
        kind === 'CSS transition'
          ? 'transitionend'
          : kind === 'CSS animation'
            ? 'animationend'
            : undefined
      expect(events.filter((name) => name === endEvent)).toHaveLength(endEvent ? 1 : 0)
      expect(events.some((name) => name.endsWith('cancel'))).toBe(false)
      expect(errors).toEqual([])
    },
  )
  it.each(
    ['width', 'height', 'both'].flatMap((axis) =>
      [false, true].map((retarget) => ({ axis, retarget })),
    ),
  )(
    'settles fixed-basis spring size overshoot without losing validity during capture/compensation: %j',
    async ({ axis, retarget }) => {
      const size = ref(100)
      const timing = { kind: 'spring-physics', stiffness: 300, damping: 25, mass: 1 } as const
      const source: Definition = {
        ...definition(),
        layers: [
          {
            name: 'base',
            targets: [
              {
                name: 'self',
                properties: [{ kind: 'layout', name: '$layout', axes: all, timing }],
              },
              {
                name: 'child',
                properties: [{ kind: 'layout', name: '$layout', axes: all, timing }],
              },
            ],
          },
        ],
      }
      const { host, errors } = await mount(
        motionComponent(source, ({ root, target }) =>
          root(
            h(
              'div',
              {
                'data-item': '',
                style: {
                  width: `${axis === 'height' ? 20 : size.value}px`,
                  height: `${axis === 'width' ? 20 : size.value}px`,
                },
              },
              [
                target(
                  h('div', { 'data-child': '', style: { width: '8px', height: '8px' } }),
                  'child',
                ),
              ],
            ),
          ),
        ),
      )
      const parent = element(host)
      const child = element(host, '[data-child]')
      size.value = 1
      await flush()
      expect(parent.style.transform).not.toBe('')

      if (retarget) {
        // Let the shared clock reach the invalid solver sample before Vue's next
        // capture, without a preceding projection RAF publishing that sample.
        time += 220
        size.value = 40
        await flush()
      } else {
        frame(220)
      }

      const rect = parent.getBoundingClientRect()
      expect(rect.width).toBeCloseTo(axis === 'height' ? 20 : 1, 3)
      expect(rect.height).toBeCloseTo(axis === 'width' ? 20 : 1, 3)
      expect(child.getBoundingClientRect().width).toBeCloseTo(8, 3)
      expect(child.getBoundingClientRect().height).toBeCloseTo(8, 3)
      expect(parent.style.transform === '').toBe(!retarget)
      expect(child.style.transform === '').toBe(!retarget)
      expect(errors).toEqual([])
    },
  )
  it.each([false, true])(
    'does not start or alter an idle transform transition declaration (important=%s)',
    async (important) => {
      const width = ref(100)
      const { host, errors } = await mount(
        motionComponent(definition(), ({ root }) => [
          h(
            'style',
            `.liva-idle-ancestor { transform: rotate(25deg) skewX(12deg) ${important ? '!important' : ''}; transition: transform 1000ms linear; }`,
          ),
          h(
            'div',
            {
              'data-ancestor': '',
              class: 'liva-idle-ancestor',
              style: { width: '300px', height: '100px', transformOrigin: '0 0' },
            },
            [
              root(
                h('div', { 'data-item': '', style: { width: `${width.value}px`, height: '40px' } }),
              ),
            ],
          ),
        ]),
      )
      const ancestor = element(host, '[data-ancestor]')
      const events: string[] = []
      for (const name of ['transitionrun', 'transitionstart', 'transitioncancel', 'transitionend'])
        ancestor.addEventListener(name, (event) => events.push(event.type))
      const css = ancestor.style.cssText
      const presentation = getComputedStyle(ancestor).transform
      expect(ancestor.getAnimations()).toHaveLength(0)

      width.value = 200
      await flush()
      await nativeTurn()
      await nativeTurn()

      expect(ancestor.getAnimations()).toHaveLength(0)
      expect(ancestor.style.cssText).toBe(css)
      expect(getComputedStyle(ancestor).transform).toBe(presentation)
      expect(events).toEqual([])
      expect(errors).toEqual([])
    },
  )

  it('keeps source children, selectors and attributes unchanged during observation', async () => {
    const width = ref(100)
    const { host, errors } = await mount(
      motionComponent(definition(), ({ root }) => [
        h(
          'style',
          '.liva-source-ancestor:has(svg) { padding-left: 99px; } [data-empty-target]:empty { margin-left: 11.25px; }',
        ),
        h(
          'div',
          {
            'data-ancestor': '',
            class: 'liva-source-ancestor',
            style: {
              width: '300px',
              height: '100px',
              transform: 'rotate(25deg) skewX(12deg)',
              transformOrigin: '0 0',
            },
          },
          [
            root(
              h('div', {
                'data-item': '',
                'data-empty-target': '',
                style: { width: `${width.value}px`, height: '40px' },
              }),
            ),
          ],
        ),
      ]),
    )
    const ancestor = element(host, '[data-ancestor]')
    const target = element(host)
    const before = ancestor.outerHTML
    const mutations: MutationRecord[] = []
    // Retain the method only for explicit .call(this) inside the spy wrapper.
    // eslint-disable-next-line typescript/unbound-method
    const begin = LayoutCoordinator.prototype.begin
    const observe = vi.spyOn(LayoutCoordinator.prototype, 'begin').mockImplementation(function (
      this: LayoutCoordinator,
    ) {
      const observer = new MutationObserver(() => {})
      observer.observe(ancestor, {
        subtree: true,
        attributes: true,
        childList: true,
        characterData: true,
      })
      try {
        begin.call(this)
        mutations.push(...observer.takeRecords())
      } finally {
        observer.disconnect()
      }
      expect(ancestor.outerHTML).toBe(before)
      expect(target.matches(':empty')).toBe(true)
      expect(ancestor.matches(':has(svg)')).toBe(false)
    })

    width.value = 200
    await flush()

    expect(mutations).toEqual([])
    expect(errors).toEqual([])
    observe.mockRestore()
  })

  it.each([
    { translate: '50% 25%' },
    { rotate: '25deg' },
    { rotate: '25deg', transform: 'none !important' },
    { scale: '1.5 .75' },
    { translate: '50% 25%', rotate: '25deg', scale: '1.5 .75', transform: 'skewX(12deg)' },
  ])('preserves existing individual ancestor transform geometry: %j', async (transform) => {
    const width = ref(100)
    const { host, errors } = await mount(
      motionComponent(definition(), ({ root }) =>
        h(
          'div',
          {
            style: { width: '300px', height: '100px', transformOrigin: '20% 80%', ...transform },
          },
          [
            root(
              h(
                'div',
                {
                  'data-item': '',
                  style: { position: 'relative', width: `${width.value}px`, height: '40px' },
                },
                markers(),
              ),
            ),
          ],
        ),
      ),
    )
    const target = element(host)
    const before = corners(target)

    width.value = 200
    await flush()

    corners(target).forEach((point, index) => {
      expect(point.x).toBeCloseTo(before[index].x, 3)
      expect(point.y).toBeCloseTo(before[index].y, 3)
    })
    expect(errors).toEqual([])
  })
  it.each(
    ['auto', 'scroll', 'hidden'].flatMap((overflow) =>
      [false, true].map((active) => ({ overflow, active })),
    ),
  )(
    'preserves scroll positions, viewport dimensions and events during capture with %j',
    async ({ overflow, active }) => {
      const coordinators: LayoutCoordinator[] = []
      // Retain the method only for explicit .call(this) inside the spy wrapper.
      // eslint-disable-next-line typescript/unbound-method
      const begin = LayoutCoordinator.prototype.begin
      vi.spyOn(LayoutCoordinator.prototype, 'begin').mockImplementation(function (
        this: LayoutCoordinator,
      ) {
        coordinators.push(this)
        begin.call(this)
      })
      const { host, errors } = await mount(
        motionComponent(definition(), ({ root }) =>
          h(
            'div',
            {
              'data-scroller': '',
              style: {
                width: '160px',
                height: '100px',
                overflow,
                scrollbarGutter: 'stable both-edges',
              },
            },
            [
              root(
                h('div', {
                  'data-item': '',
                  style: {
                    width: '120px',
                    height: '80px',
                    transform: 'scale(2)',
                    transformOrigin: '0 0',
                  },
                }),
              ),
            ],
          ),
        ),
      )
      const scroller = element(host, '[data-scroller]')
      const target = element(host)
      const animation = active
        ? target.animate([{ transform: 'scale(2)' }, { transform: 'scale(3)' }], {
            duration: 1000,
            fill: 'both',
          })
        : undefined
      if (animation) {
        await animation.ready
        animation.pause()
        animation.currentTime = 250
      }
      const sourceCss = scroller.outerHTML
      scroller.scrollLeft = 40
      scroller.scrollTop = 20
      await nativeTurn()
      await nativeTurn()
      const events: string[] = []
      scroller.addEventListener('scroll', () => events.push('scroll'))
      const snapshot = () => ({
        x: scroller.scrollLeft,
        y: scroller.scrollTop,
        width: scroller.clientWidth,
        height: scroller.clientHeight,
        scrollWidth: scroller.scrollWidth,
        scrollHeight: scroller.scrollHeight,
      })
      const before = snapshot()
      expect(before.x).toBe(40)
      expect(before.y).toBe(20)
      const coordinator = coordinators.at(-1)
      expect(coordinator).toBeDefined()

      // The plugin's mount hook above supplied this exact application owner.
      coordinator!.begin()
      expect(snapshot()).toEqual(before)
      await nativeTurn()
      await nativeTurn()

      expect(snapshot()).toEqual(before)
      expect(events).toEqual([])
      expect(scroller.outerHTML).toBe(sourceCss)
      expect(target.getAnimations()).toHaveLength(active ? 1 : 0)
      expect(target.getAnimations()[0]).toBe(animation)
      expect(animation?.currentTime).toBe(active ? 250 : undefined)
      animation?.cancel()
      coordinator!.finish()
      expect(errors).toEqual([])
    },
  )

  it('keeps absolute percentage children visually stable and measure() in the natural containing block', async () => {
    const expanded = ref(false)
    const source: Definition = {
      ...definition(),
      layers: [
        {
          name: 'base',
          targets: ['self', 'child'].map((name) => ({
            name,
            properties: [
              {
                kind: 'layout',
                name: '$layout',
                axes: all,
                timing: { kind: 'tween', durationMs: 1000, easing: 'linear' },
              },
            ],
          })),
        },
      ],
    }
    const { host, errors } = await mount(
      motionComponent(source, ({ root, target }) =>
        h(
          'div',
          {
            'data-reference': '',
            style: { position: 'relative', width: '400px', height: '300px' },
          },
          [
            root(
              h(
                'div',
                {
                  'data-item': '',
                  style: {
                    width: expanded.value ? '200px' : '100px',
                    height: expanded.value ? '120px' : '80px',
                  },
                },
                [
                  target(
                    h(
                      'div',
                      {
                        'data-child': '',
                        style: {
                          position: 'absolute',
                          left: '25%',
                          top: '20%',
                          width: '50%',
                          height: '50%',
                        },
                      },
                      markers(),
                    ),
                    'child',
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    )
    const reference = element(host, '[data-reference]')
    const parent = element(host)
    const child = element(host, '[data-child]')
    const twin = reference.cloneNode(true)
    if (!(twin instanceof HTMLElement)) throw new Error('Expected HTML twin')
    host.append(twin)
    const twinChild = element(twin, '[data-child]')
    const expected = readLayoutBounds(twinChild, twin)
    const displayed = corners(child)
    const read = measure({ target: { name: 'child' } })
    const release = read.bind(
      new Map([
        ['self', reference],
        ['child', child],
      ]),
      () => {},
    )
    let releaseLate: (() => void) | undefined

    try {
      expanded.value = true
      await flush()
      expect(parent.style.transform).not.toBe('')
      expect(child.style.transform).not.toBe('')
      // Generated transforms establish a different actual containing block. The
      // public reactive geometry must still describe the untransformed twin.
      expect(getComputedStyle(child).width).toBe('100px')
      const late = measure({ target: { name: 'child' } })
      releaseLate = late.bind(
        new Map([
          ['self', reference],
          ['child', child],
        ]),
        () => {},
      )
      expect(late.value).toEqual(expected)

      for (const elapsed of [0, 500, 500]) {
        frame(elapsed)
        await flush()
        expect(read.value).toEqual(expected)
        expect(late.value).toEqual(expected)
        corners(child).forEach((point, index) => {
          expect(point.x).toBeCloseTo(displayed[index].x, 3)
          expect(point.y).toBeCloseTo(displayed[index].y, 3)
        })
      }

      expect(parent.style.transform).toBe('')
      expect(child.style.transform).toBe('')
      expect(getComputedStyle(child).width).toBe('200px')
      expect(errors).toEqual([])
    } finally {
      releaseLate?.()
      release()
      twin.remove()
    }
  })

  it('captures a teleported root before Vue moves it between containers', async () => {
    const moved = ref(false)
    const first = document.createElement('div')
    const second = document.createElement('div')
    first.style.cssText = 'position:absolute;left:10px;top:10px'
    second.style.cssText = 'position:absolute;left:210px;top:10px'
    document.body.append(first, second)
    hosts.push(first, second)
    const item = motionComponent(definition(), ({ root }) =>
      root(
        h('div', {
          'data-item': '',
          style: { width: '100px', height: '40px' },
        }),
      ),
    )
    const component = defineComponent({
      setup: () => () => h(Teleport, { to: moved.value ? second : first }, [h(item)]),
    })
    const { errors } = await mount(component)
    const target = element(first)
    const before = target.getBoundingClientRect()

    moved.value = true
    await flush()

    expect(target.parentElement).toBe(second)
    expect(target.getBoundingClientRect().x).toBeCloseTo(before.x, 3)
    expect(target.style.transform).not.toBe('')
    frame(500)
    expect(target.getBoundingClientRect().x).toBeCloseTo(before.x + 100, 3)
    frame(500)
    expect(target.getBoundingClientRect().x).toBeCloseTo(before.x + 200, 3)
    expect(target.style.transform).toBe('')
    expect(errors).toEqual([])
  })

  it('captures neighbors before KeepAlive deactivation and reactivation', async () => {
    const shown = ref(true)
    const item = motionComponent(definition(), ({ root }) =>
      root(
        h('div', {
          'data-item': '',
          style: { width: '100px', height: '40px' },
        }),
      ),
    )
    const empty = defineComponent({ setup: () => () => null })
    const neighbor = motionComponent({ ...definition(), name: 'neighbor' }, ({ root }) =>
      root(
        h('div', {
          'data-neighbor': '',
          style: { width: '100px', height: '40px' },
        }),
      ),
    )
    const component = defineComponent({
      setup: () => () =>
        h('div', { style: { display: 'flex' } }, [
          h(KeepAlive, null, { default: () => h(shown.value ? item : empty) }),
          h(neighbor),
        ]),
    })
    const { host, errors } = await mount(component)
    const target = element(host)
    const sibling = element(host, '[data-neighbor]')
    const before = sibling.getBoundingClientRect().x

    shown.value = false
    await flush()
    expect(target.isConnected).toBe(false)
    expect(target.style.transform).toBe('')
    expect(sibling.style.transform).not.toBe('')
    expect(sibling.getBoundingClientRect().x).toBeCloseTo(before, 3)
    frame(1000)
    expect(sibling.getBoundingClientRect().x).toBeCloseTo(before - 100, 3)

    shown.value = true
    await flush()
    expect(element(host)).toBe(target)
    expect(target.style.transform).toBe('')
    expect(sibling.getBoundingClientRect().x).toBeCloseTo(before - 100, 3)
    frame(1000)
    expect(sibling.getBoundingClientRect().x).toBeCloseTo(before, 3)
    expect(errors).toEqual([])
  })

  it('captures neighbors before an async Suspense branch replaces its fallback', async () => {
    // Promise executors run synchronously before the async component is created.
    let resolveReady!: () => void
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve
    })
    const item = motionComponent(definition(), ({ root }) =>
      root(
        h('div', {
          'data-item': '',
          style: { width: '100px', height: '40px' },
        }),
      ),
    )
    const delayed = defineComponent({
      async setup() {
        await ready
        return () => h(item)
      },
    })
    const neighbor = motionComponent({ ...definition(), name: 'neighbor' }, ({ root }) =>
      root(
        h('div', {
          'data-neighbor': '',
          style: { width: '100px', height: '40px' },
        }),
      ),
    )
    const component = defineComponent({
      setup: () => () =>
        h('div', { style: { display: 'flex' } }, [
          h(Suspense, null, {
            default: () => h(delayed),
            fallback: () => h('div', { style: { width: '40px', height: '40px' } }),
          }),
          h(neighbor),
        ]),
    })
    const { host, errors } = await mount(component)
    const sibling = element(host, '[data-neighbor]')
    const before = sibling.getBoundingClientRect().x

    resolveReady()
    await ready
    await flush()
    await flush()

    expect(element(host).style.transform).toBe('')
    expect(sibling.style.transform).not.toBe('')
    expect(sibling.getBoundingClientRect().x).toBeCloseTo(before, 3)
    frame(500)
    expect(sibling.getBoundingClientRect().x).toBeCloseTo(before + 30, 3)
    frame(500)
    expect(sibling.getBoundingClientRect().x).toBeCloseTo(before + 60, 3)
    expect(errors).toEqual([])
  })

  it.each([false, true])(
    'captures before real Presence removal and releases retained DOM when capture fails=%s',
    async (captureFailure) => {
      const shown = ref(true)
      let entry: PresenceEntry | undefined
      const owner: Definition = {
        name: 'owner',
        layers: [
          {
            name: 'base',
            targets: [
              {
                name: 'leaver',
                properties: [{ name: 'opacity', value: { kind: 'literal', value: '1' } }],
              },
            ],
          },
        ],
        leave: {
          timing: { kind: 'tween', durationMs: 10000, easing: 'linear' },
          targets: [
            {
              name: 'leaver',
              properties: [
                {
                  name: 'opacity',
                  keyframes: [{ offset: 1, value: { kind: 'literal', value: '0' } }],
                },
              ],
            },
          ],
        },
      }
      const neighbor = motionComponent(definition(), ({ root }) =>
        root(
          h('div', {
            'data-neighbor': '',
            style: { width: '100px', height: '40px' },
          }),
        ),
      )
      const component = defineComponent({
        livaDefinitions: [owner],
        setup() {
          const root = resolveDirective('liva')!
          const target = resolveDirective('liva-target')!
          const entryDirective = resolveDirective('liva-entry')!
          return () =>
            withDirectives(
              h('div', { style: { display: 'flex' } }, [
                h(LivaPresenceBoundary, null, {
                  default: ({ item }: { item: (key: unknown) => PresenceEntry }) => {
                    entry = item('leaver')
                    return shown.value
                      ? withDirectives(
                          h('div', {
                            key: 'leaver',
                            'data-leaver': '',
                            style: { width: '100px', height: '40px' },
                          }),
                          [
                            [
                              target,
                              { owner: ['root'], entries: [entry] },
                              'leaver',
                              { compiled: true },
                            ],
                            [entryDirective, entry],
                          ],
                        )
                      : null
                  },
                }),
                h(neighbor),
              ]),
              [[root, { value: {}, owner: ['root'] }, 'owner', { compiled: true }]],
            )
        },
      })
      const { host, errors } = await mount(component)
      const sibling = element(host, '[data-neighbor]')
      const leaving = element(host, '[data-leaver]')
      const before = sibling.getBoundingClientRect().x

      shown.value = false
      await flush()
      expect(leaving.isConnected).toBe(true)
      expect(sibling.style.transform).toBe('')
      const session = entry?.session
      expect(session).toBeDefined()
      const cause = new Error('Pre-removal geometry capture failed')
      if (captureFailure)
        vi.spyOn(sibling, 'getBoundingClientRect').mockImplementationOnce(() => {
          throw cause
        })
      const animations = leaving.getAnimations()
      expect(animations).toHaveLength(1)
      for (const animation of animations) animation.finish()
      await session!.finished
      await flush()
      await flush()

      expect(leaving.isConnected).toBe(false)
      expect(entry?.session).toBeUndefined()
      expect(errors.map((error) => error.error)).toEqual(captureFailure ? [cause] : [])
      expect(sibling.style.transform === '').toBe(captureFailure)
      expect(sibling.getBoundingClientRect().x).toBeCloseTo(before - (captureFailure ? 100 : 0), 3)
      frame(500)
      expect(sibling.getBoundingClientRect().x).toBeCloseTo(before - (captureFailure ? 100 : 50), 3)
      frame(500)
      expect(sibling.getBoundingClientRect().x).toBeCloseTo(before - 100, 3)
    },
  )
  it('does not start on external changes and settles active projection on a real fractional change', async () => {
    const width = ref(100)
    const { host, errors } = await mount(
      motionComponent(definition(), ({ root }) =>
        root(
          h('div', {
            'data-item': '',
            style: { width: `${width.value}px`, height: '40px' },
          }),
        ),
      ),
    )
    const target = element(host)
    target.style.width = '150px'
    window.dispatchEvent(new Event('resize'))
    frame(0)
    expect(target.style.transform).toBe('')

    width.value = 200
    await flush()
    expect(target.getBoundingClientRect().width).toBeCloseTo(150, 3)
    frame(100)
    expect(target.getBoundingClientRect().width).toBeCloseTo(155, 3)
    window.dispatchEvent(new Event('resize'))
    frame(0)
    expect(target.style.transform).not.toBe('')

    target.style.marginLeft = '.125px'
    window.dispatchEvent(new Event('resize'))
    frame(0)
    expect(target.style.transform).toBe('')
    expect(target.getBoundingClientRect().width).toBeCloseTo(200, 3)
    expect(errors).toEqual([])
  })

  it('samples retained projection without geometry reads and leaves no idle frame loop', async () => {
    const width = ref(100)
    const { host, errors } = await mount(
      motionComponent(definition(), ({ root }) =>
        root(
          h('div', {
            'data-item': '',
            style: { width: `${width.value}px`, height: '40px' },
          }),
        ),
      ),
    )
    const target = element(host)
    width.value = 200
    await flush()
    // Drain initialization/DOM invalidations before isolating transform-only work.
    frame(0)
    await flush()
    frame(0)
    await flush()
    const targetRead = vi.spyOn(target, 'getBoundingClientRect')
    const ancestorRead = vi.spyOn(host, 'getBoundingClientRect')

    for (let index = 0; index < 10; index++) {
      frame(16)
      await flush()
    }

    expect(targetRead).not.toHaveBeenCalled()
    expect(ancestorRead).not.toHaveBeenCalled()
    frame(1000)
    await flush()
    frame(0)
    await flush()
    expect(frames.size).toBe(0)
    targetRead.mockClear()
    ancestorRead.mockClear()
    frame(1000)
    expect(targetRead).not.toHaveBeenCalled()
    expect(ancestorRead).not.toHaveBeenCalled()
    expect(errors).toEqual([])
  })

  it.each([
    { transform: 'matrix3d(1,0,0,0,0,1,0,0,0,0,2,0,0,0,0,1)' },
    { perspective: '1000px' },
    { zoom: '2' },
    { transform: 'scale(0)' },
    { transformBox: 'stroke-box' },
    { transformBox: 'content-box', transform: 'rotate(10deg)', padding: '10px' },
  ])(
    'retains the original unsupported geometry verdict and recovers after it is removed: %j',
    async (unsupported) => {
      const supported = ref(false)
      const width = ref(100)
      const { host, errors } = await mount(
        motionComponent(definition(), ({ root }) =>
          h(
            'div',
            {
              style: { width: '400px', height: '200px', ...(supported.value ? {} : unsupported) },
            },
            [
              root(
                h('div', { 'data-item': '', style: { width: `${width.value}px`, height: '40px' } }),
              ),
            ],
          ),
        ),
      )
      const target = element(host)

      width.value = 200
      await flush()
      expect(target.style.transform).toBe('')
      supported.value = true
      width.value = 300
      await flush()
      expect(target.style.transform).toBe('')
      width.value = 400
      await flush()
      expect(target.style.transform).not.toBe('')
      expect(target.getBoundingClientRect().width).toBeCloseTo(300, 3)
      frame(1000)
      expect(target.getBoundingClientRect().width).toBeCloseTo(400, 3)
      expect(errors).toEqual([])
    },
  )
  it.each([true, false])(
    'retains child compensation across different timing and ownership boundaries (child ends first=%s)',
    async (childFirst) => {
      const expanded = ref(false)
      const source: Definition = {
        ...definition(),
        layers: [
          {
            name: 'base',
            targets: ['child', 'self'].map((name) => ({
              name,
              properties: [
                {
                  kind: 'layout',
                  name: '$layout',
                  axes: all,
                  timing: {
                    kind: 'tween',
                    durationMs: (name === 'child') === childFirst ? 250 : 1000,
                    easing: 'linear',
                  },
                },
              ],
            })),
          },
        ],
      }
      const { host, errors } = await mount(
        motionComponent(source, ({ root, target }) =>
          root(
            h(
              'div',
              {
                'data-item': '',
                style: { width: expanded.value ? '200px' : '100px', height: '100px' },
              },
              [
                target(
                  h('div', {
                    'data-child': '',
                    style: { width: expanded.value ? '40px' : '20px', height: '20px' },
                  }),
                  'child',
                ),
                h('div', { 'data-unregistered': '', style: { width: '20px', height: '20px' } }),
              ],
            ),
          ),
        ),
      )
      const child = element(host, '[data-child]')
      const unregistered = element(host, '[data-unregistered]')

      expanded.value = true
      await flush()
      expect(child.getBoundingClientRect().width).toBeCloseTo(20, 3)
      expect(unregistered.getBoundingClientRect().width).toBeCloseTo(10, 3)
      frame(250)
      expect(child.getBoundingClientRect().width).toBeCloseTo(childFirst ? 40 : 25, 3)
      expect(child.style.transform).not.toBe('')
      frame(250)
      expect(child.getBoundingClientRect().width).toBeCloseTo(childFirst ? 40 : 30, 3)
      frame(500)
      expect(child.style.transform).toBe('')
      expect(child.getBoundingClientRect().width).toBeCloseTo(40, 3)
      expect(unregistered.getBoundingClientRect().width).toBeCloseTo(20, 3)
      expect(errors).toEqual([])
    },
  )

  it('uses browser easing and carries displayed edge velocity into a spring retarget', async () => {
    const width = ref(100)
    const spring = ref(false)
    const easing = 'cubic-bezier(.25, .1, .25, 1)'
    const source: Definition = {
      ...definition(),
      parameters: [{ name: 'spring', type: 'boolean' }],
      layers: [
        {
          name: 'base',
          targets: [
            {
              name: 'self',
              properties: [
                {
                  kind: 'layout',
                  name: '$layout',
                  axes: all,
                  timing: { kind: 'tween', durationMs: 1000, easing },
                },
              ],
            },
          ],
        },
        {
          name: 'spring',
          when: { kind: 'reference', path: ['spring'] },
          targets: [
            {
              name: 'self',
              properties: [
                {
                  kind: 'layout',
                  name: '$layout',
                  axes: all,
                  timing: { kind: 'spring-physics', stiffness: 300, damping: 25, mass: 1 },
                },
              ],
            },
          ],
        },
      ],
    }
    const { host, errors } = await mount(
      motionComponent(source, ({ root }) =>
        root(
          h('div', {
            'data-item': '',
            style: { width: `${width.value}px`, height: '40px' },
          }),
          { spring: spring.value },
        ),
      ),
    )
    const target = element(host)
    const control = document.createElement('div')
    control.style.cssText = 'width:100px;height:40px'
    host.append(control)
    const effect = control.animate([{ width: '100px' }, { width: '200px' }], {
      duration: 1000,
      easing,
      fill: 'both',
    })
    await effect.ready
    effect.pause()
    effect.currentTime = 250

    try {
      width.value = 200
      await flush()
      frame(249)
      // In this axis-aligned scene the browser's used matrix times its local
      // width gives displayed CSS pixels without quantizing two DOMRect edges.
      const usedWidth = () =>
        new DOMMatrix(getComputedStyle(target).transform).a *
        parseFloat(getComputedStyle(target).width)
      const earlier = usedWidth()
      frame(1)
      const before = target.getBoundingClientRect().width
      const beforeUsed = usedWidth()
      expect(before).toBeCloseTo(control.getBoundingClientRect().width, 1)
      const incoming = beforeUsed - earlier
      spring.value = true
      width.value = 300
      await flush()
      expect(target.getBoundingClientRect().width).toBeCloseTo(before, 3)
      frame(1)
      const outgoing = usedWidth() - beforeUsed
      // With k=300, damping=25 and a <120px remaining distance, one millisecond
      // contributes <.018px displacement from acceleration. The .03px budget
      // also covers backward/forward differencing and CSS matrix serialization.
      // Exact same-time DOM presentation is checked separately above.
      expect(Math.abs(outgoing - incoming)).toBeLessThan(0.03)
      frame(2000)
      expect(target.getBoundingClientRect().width).toBeCloseTo(300, 3)
      expect(target.style.transform).toBe('')
      expect(errors).toEqual([])
    } finally {
      effect.cancel()
      control.remove()
    }
  })
  it.each([false, true])(
    'settles active size correction when selection disables or removes size (position remains=%s)',
    async (position) => {
      const width = ref(100)
      const disabled = ref(false)
      const source: Definition = {
        ...definition(),
        parameters: [{ name: 'disabled', type: 'boolean' }],
        layers: [
          definition().layers[0],
          {
            name: 'disabled',
            when: { kind: 'reference', path: ['disabled'] },
            targets: [
              {
                name: 'self',
                properties: [
                  {
                    kind: 'layout',
                    name: '$layout',
                    axes: { x: position, y: position, width: false, height: false },
                  },
                ],
              },
            ],
          },
        ],
      }
      const { host, errors } = await mount(
        motionComponent(source, ({ root }) =>
          root(
            h('div', {
              'data-item': '',
              style: { width: `${width.value}px`, height: '40px' },
            }),
            { disabled: disabled.value },
          ),
        ),
      )
      const target = element(host)
      width.value = 200
      await flush()
      frame(250)
      expect(target.getBoundingClientRect().width).toBeCloseTo(125, 3)

      disabled.value = true
      await flush()
      expect(target.style.transform).toBe('')
      expect(target.getBoundingClientRect().width).toBeCloseTo(200, 3)
      disabled.value = false
      width.value = 250
      await flush()
      expect(target.getBoundingClientRect().width).toBeCloseTo(200, 3)
      frame(1000)
      expect(target.getBoundingClientRect().width).toBeCloseTo(250, 3)
      expect(errors).toEqual([])
    },
  )

  it('overrides target CSS rotation while active and releases to the current class', async () => {
    const width = ref(100)
    const changed = ref(false)
    const { host, errors } = await mount(
      motionComponent(definition(), ({ root }) => [
        h(
          'style',
          '.liva-layout-css-before { transform: rotate(20deg) !important; } .liva-layout-css-after { transform: rotate(35deg) !important; }',
        ),
        root(
          h('div', {
            'data-item': '',
            class: changed.value ? 'liva-layout-css-after' : 'liva-layout-css-before',
            style: { width: `${width.value}px`, height: '40px' },
          }),
        ),
      ]),
    )
    const target = element(host)
    expect(new DOMMatrix(getComputedStyle(target).transform).b).not.toBe(0)

    width.value = 200
    await flush()
    expect(new DOMMatrix(getComputedStyle(target).transform).b).toBe(0)
    expect(target.style.getPropertyPriority('transform')).toBe('important')
    frame(250)
    changed.value = true
    await flush()
    expect(new DOMMatrix(getComputedStyle(target).transform).b).toBe(0)
    frame(750)

    expect(target.style.transform).toBe('')
    expect(new DOMMatrix(getComputedStyle(target).transform).b).toBeCloseTo(
      Math.sin((35 * Math.PI) / 180),
      5,
    )
    expect(errors).toEqual([])
  })

  it('keeps app-scoped active trajectories independent while sharing document measurement', async () => {
    const firstWidth = ref(100)
    const secondWidth = ref(100)
    const component = (width: typeof firstWidth) =>
      motionComponent(definition(), ({ root }) =>
        root(h('div', { 'data-item': '', style: { width: `${width.value}px`, height: '40px' } })),
      )
    const first = await mount(component(firstWidth))
    const second = await mount(component(secondWidth))
    const firstTarget = element(first.host)
    const secondTarget = element(second.host)

    secondWidth.value = 200
    await flush()
    frame(250)
    expect(secondTarget.getBoundingClientRect().width).toBeCloseTo(125, 3)
    firstWidth.value = 300
    await flush()
    expect(firstTarget.getBoundingClientRect().width).toBeCloseTo(100, 3)
    expect(secondTarget.getBoundingClientRect().width).toBeCloseTo(125, 3)
    frame(250)
    expect(firstTarget.getBoundingClientRect().width).toBeCloseTo(150, 3)
    expect(secondTarget.getBoundingClientRect().width).toBeCloseTo(150, 3)
    frame(1000)
    expect(firstTarget.style.transform).toBe('')
    expect(secondTarget.style.transform).toBe('')
    expect([...first.errors, ...second.errors]).toEqual([])
  })

  it('coordinates nested motion components before a common first frame', async () => {
    const expanded = ref(false)
    const child = motionComponent({ ...definition(), name: 'child' }, ({ root }) =>
      root(
        h('div', {
          'data-child': '',
          style: { width: expanded.value ? '40px' : '20px', height: '20px' },
        }),
      ),
    )
    const parent = motionComponent(definition(), ({ root }) =>
      root(
        h(
          'div',
          {
            'data-item': '',
            style: { width: expanded.value ? '200px' : '100px', height: '100px' },
          },
          [h(child)],
        ),
      ),
    )
    const { host, errors } = await mount(parent)
    const target = element(host, '[data-child]')

    expanded.value = true
    await flush()
    expect(target.getBoundingClientRect().width).toBeCloseTo(20, 3)
    frame(500)
    expect(target.getBoundingClientRect().width).toBeCloseTo(30, 3)
    frame(500)
    expect(target.getBoundingClientRect().width).toBeCloseTo(40, 3)
    expect(target.style.transform).toBe('')
    expect(errors).toEqual([])
  })
  it.each([false, true])(
    'keeps target transform ownership separate from absolute-child containing-block changes (initial transform=%s)',
    async (initialTransform) => {
      const output = vi.spyOn(PresentationExecutor.prototype, 'layoutTransform')
      const width = ref(200)
      const transformed = ref(initialTransform)
      const source: Definition = {
        ...definition(),
        layers: [
          {
            name: 'base',
            targets: ['self', 'child'].map((name) => ({
              name,
              properties: [
                {
                  kind: 'layout',
                  name: '$layout',
                  axes: all,
                  timing: { kind: 'tween', durationMs: 1000, easing: 'linear' },
                },
              ],
            })),
          },
        ],
      }
      const { host, errors } = await mount(
        motionComponent(source, ({ root, target }) => [
          h(
            'style',
            '.liva-cb-transform { transform: rotate(0deg) !important; } .liva-cb-natural { transform: none !important; }',
          ),
          h(
            'div',
            {
              'data-reference': '',
              style: { position: 'relative', width: '400px', height: '300px' },
            },
            [
              root(
                h(
                  'div',
                  {
                    'data-item': '',
                    class: transformed.value ? 'liva-cb-transform' : 'liva-cb-natural',
                    style: { width: `${width.value}px`, height: '100px' },
                  },
                  [
                    target(
                      h(
                        'div',
                        {
                          'data-child': '',
                          style: {
                            position: 'absolute',
                            left: '25%',
                            top: '20%',
                            width: '50%',
                            height: '50%',
                          },
                        },
                        markers(),
                      ),
                      'child',
                    ),
                  ],
                ),
              ),
            ],
          ),
        ]),
      )
      const reference = element(host, '[data-reference]')
      const parent = element(host)
      const child = element(host, '[data-child]')
      const twin = reference.cloneNode(true)
      if (!(twin instanceof HTMLElement)) throw new Error('Expected HTML twin')
      host.append(twin)
      const twinParent = element(twin)
      const twinChild = element(twin, '[data-child]')
      twinParent.style.width = '300px'
      twinParent.className = initialTransform ? 'liva-cb-natural' : 'liva-cb-transform'
      const expected = readLayoutBounds(twinChild, twin)
      const read = measure({ target: { name: 'child' } })
      const release = read.bind(
        new Map([
          ['self', reference],
          ['child', child],
        ]),
        () => {},
      )

      try {
        width.value = 300
        await flush()
        frame(250)
        const before = corners(child)
        const oldWidth = child.getBoundingClientRect().width
        expect(oldWidth).toBe(initialTransform ? 112.5 : 200)
        transformed.value = !initialTransform
        await flush()
        expect(parent.getBoundingClientRect().width).toBeCloseTo(225, 3)
        corners(child).forEach((point, index) => {
          expect(point.x).toBeCloseTo(before[index].x, 3)
          expect(point.y).toBeCloseTo(before[index].y, 3)
        })
        frame(0)
        await flush()
        expect(read.value).toEqual(expected)
        frame(750)
        expect(parent.style.transform).toBe('')
        const desiredWidth = oldWidth + (expected.width - oldWidth) * 0.75
        const desiredHeight = initialTransform ? 125 : 75
        const desiredX = initialTransform ? 89.0625 : 81.25
        const desiredY = initialTransform ? 50 : 30
        const naturalX = initialTransform ? 100 : 75
        const naturalY = initialTransform ? 60 : 20
        twinChild.style.transformOrigin = '0 0'
        twinChild.style.transform = `matrix(${desiredWidth / expected.width}, 0, 0, ${desiredHeight / expected.height}, ${desiredX - naturalX}, ${desiredY - naturalY})`
        const published = output.mock.calls
          .toReversed()
          .find(([receiver, transform]) => receiver === child && transform !== undefined)?.[1]
        if (!published) throw new Error('Expected active child projection output')
        // Inspect the actual published numeric matrix before CSSOM shortens its
        // decimal serialization; the independent native control below verifies rendering.
        const numericWidth = new DOMMatrix(published).a * parseFloat(getComputedStyle(child).width)
        expect(numericWidth).toBeCloseTo(desiredWidth, 3)
        // At 178.125px Firefox exposes 178.13333px for both this independently
        // authored native control and the projection. Compare native corners in
        // the same local reference basis; do not relax the .0005px bound.
        expect(child.getBoundingClientRect().width).toBeCloseTo(
          twinChild.getBoundingClientRect().width,
          3,
        )
        const originalReference = reference.getBoundingClientRect()
        const twinReference = twin.getBoundingClientRect()
        const controlCorners = corners(twinChild)
        corners(child).forEach((point, index) => {
          expect(point.x - originalReference.x).toBeCloseTo(
            controlCorners[index].x - twinReference.x,
            3,
          )
          expect(point.y - originalReference.y).toBeCloseTo(
            controlCorners[index].y - twinReference.y,
            3,
          )
        })
        twinChild.style.transform = ''

        frame(250)
        expect(child.style.transform).toBe('')
        expect(readLayoutBounds(child, reference)).toEqual(expected)
        expect(errors).toEqual([])
      } finally {
        release()
        twin.remove()
      }
    },
  )

  it('ignores hidden external target rotation changes while detecting real fractional layout movement', async () => {
    const width = ref(100)
    const { host, errors } = await mount(
      motionComponent(definition(), ({ root }) => [
        h(
          'style',
          '.liva-hidden-before { transform: rotate(20deg) !important; } .liva-hidden-after { transform: rotate(35deg) !important; }',
        ),
        root(
          h('div', {
            'data-item': '',
            class: 'liva-hidden-before',
            style: { width: `${width.value}px`, height: '40px' },
          }),
        ),
      ]),
    )
    const target = element(host)
    width.value = 200
    await flush()
    frame(250)
    target.className = 'liva-hidden-after'
    window.dispatchEvent(new Event('resize'))
    frame(0)
    expect(target.style.transform).not.toBe('')
    expect(new DOMMatrix(getComputedStyle(target).transform).a).toBeCloseTo(0.625, 5)
    target.style.marginLeft = '.125px'
    window.dispatchEvent(new Event('resize'))
    frame(0)
    expect(target.style.transform).toBe('')
    expect(new DOMMatrix(getComputedStyle(target).transform).b).toBeCloseTo(
      Math.sin((35 * Math.PI) / 180),
      5,
    )
    expect(errors).toEqual([])
  })
  it.each(['capture', 'destination'] as const)(
    'reports original %s failure and accepts a later Vue update',
    async (phase) => {
      const width = ref(100)
      const { host, errors, app } = await mount(
        motionComponent(definition(), ({ root }) =>
          root(h('div', { 'data-item': '', style: { width: `${width.value}px`, height: '40px' } })),
        ),
      )
      const target = element(host)
      const handled: unknown[] = []
      app.config.errorHandler = (error) => {
        handled.push(error)
      }
      width.value = 200
      await flush()
      frame(250)
      const cause = new Error(`${phase} failed`)
      const read = target.getBoundingClientRect.bind(target)
      let fail = true
      vi.spyOn(target, 'getBoundingClientRect').mockImplementation(() => {
        if (fail && (phase === 'capture' || target.style.width === '300px')) {
          fail = false
          throw cause
        }
        return read()
      })

      width.value = 300
      await flush()
      await flush()

      expect(errors.map((error) => error.error)).toEqual([cause])
      expect(handled).toEqual(phase === 'capture' ? [cause] : [])
      expect(target.style.transform).toBe('')
      width.value = 400
      await flush()
      expect(target.getBoundingClientRect().width).toBeCloseTo(300, 3)
      frame(1000)
      expect(target.getBoundingClientRect().width).toBeCloseTo(400, 3)
    },
  )

  it('reports registration cleanup failure and still disposes the removed executor', async () => {
    const width = ref(100)
    const shown = ref(true)
    let armed = false
    const child = defineComponent({
      livaDefinitions: [definition()],
      beforeUnmount() {
        armed = true
      },
      setup() {
        const directive = resolveDirective('liva')!
        return () =>
          withDirectives(
            h('div', { 'data-item': '', style: { width: `${width.value}px`, height: '40px' } }),
            [[directive, {}, 'item']],
          )
      },
    })
    const component = defineComponent({ setup: () => () => (shown.value ? h(child) : null) })
    const { host, errors } = await mount(component)
    const target = element(host)
    width.value = 200
    await flush()
    const cause = new Error('Registration restoration failed')
    // Retain only for explicit .call(this) in the fault-injection wrapper.
    // eslint-disable-next-line typescript/unbound-method
    const restore = PresentationExecutor.prototype.layoutTransform
    let fail = true
    vi.spyOn(PresentationExecutor.prototype, 'layoutTransform').mockImplementation(function (
      this: PresentationExecutor,
      receiver,
      transform,
    ) {
      if (receiver === target && armed && transform === undefined && fail) {
        fail = false
        throw cause
      }
      restore.call(this, receiver, transform)
    })

    shown.value = false
    await flush()

    expect(errors.map((error) => ({ code: error.code, error: error.error }))).toEqual([
      { code: 'vue.layout-disposal', error: cause },
    ])
    expect(target.style.transform).toBe('')
    expect(target.getAnimations()).toEqual([])
    expect(frames.size).toBe(0)
  })
  it.each(
    [false, true].flatMap((important) =>
      ['idle', 'paused', 'running'].map((mode) => ({ important, mode })),
    ),
  )(
    'owns target transform output over CSS transitions and releases current CSS without touching opacity: %j',
    async ({ important, mode }) => {
      const width = ref(100)
      const source: Definition = {
        ...definition(),
        layers: [
          {
            name: 'base',
            targets: [
              {
                name: 'self',
                properties: [
                  {
                    kind: 'layout',
                    name: '$layout',
                    axes: { x: false, y: false, width: true, height: false },
                    timing: { kind: 'tween', durationMs: 1000, easing: 'linear' },
                  },
                ],
              },
            ],
          },
        ],
      }
      const priority = important ? '!important' : ''
      const { host, errors } = await mount(
        motionComponent(source, ({ root }) => [
          h(
            'style',
            `.liva-owned-transition { transform:translateX(0px) ${priority}; opacity:1; transition:transform 1000ms linear, opacity 1000ms linear; } .liva-owned-transition.shifted { transform:translateX(80px) ${priority}; opacity:.5; } .liva-owned-transition.current { transform:translateX(120px) ${priority}; }`,
          ),
          root(
            h('div', {
              'data-item': '',
              class: 'liva-owned-transition',
              style: { width: `${width.value}px`, height: '40px', transformOrigin: '0 0' },
            }),
          ),
        ]),
      )
      const target = element(host)
      let opacity: Animation | undefined
      const events: string[] = []
      target.addEventListener('transitioncancel', (event) => events.push(event.propertyName))

      if (mode !== 'idle') {
        getComputedStyle(target).getPropertyValue('transform')
        target.classList.add('shifted')
        await nativeTurn()
        const effects = target
          .getAnimations()
          .filter((animation): animation is CSSTransition => animation instanceof CSSTransition)
        const transform = effects.find((animation) => animation.transitionProperty === 'transform')
        opacity = effects.find((animation) => animation.transitionProperty === 'opacity')
        if (!transform || !opacity)
          throw new Error('Expected real source transform and opacity transitions')
        await Promise.all(effects.map((animation) => animation.ready))
        if (mode === 'paused') {
          transform.pause()
          transform.currentTime = 400
          opacity.pause()
          opacity.currentTime = 250
        }
      }
      const opacityEffect = opacity?.effect
      const opacityTime = opacity?.currentTime
      const opacityStart = opacity?.startTime
      const completion = opacity?.finished
      const reference = document.createElement('div')
      reference.style.cssText = 'width:200px;height:40px;transform-origin:0 0'
      host.append(reference)
      const native = reference.animate([{ transform: 'scaleX(.5)' }, { transform: 'scaleX(1)' }], {
        duration: 1000,
        fill: 'both',
        easing: 'linear',
      })
      native.pause()
      native.currentTime = 0

      try {
        width.value = 200
        await flush()
        expect(target.getBoundingClientRect().width).toBeCloseTo(
          reference.getBoundingClientRect().width,
          3,
        )
        for (const delta of [250, 250]) {
          frame(delta)
          native.currentTime = time - 1000
          expect(target.getBoundingClientRect().width).toBeCloseTo(
            reference.getBoundingClientRect().width,
            3,
          )
        }
        target.classList.add('current')
        await flush()
        frame(500)
        expect(target.style.transform).toBe('')
        expect(target.getBoundingClientRect().width).toBeCloseTo(200, 3)
        expect(new DOMMatrix(getComputedStyle(target).transform).e).toBeCloseTo(120, 3)
        expect(target.getAnimations()).toHaveLength(mode === 'idle' ? 0 : 1)
        expect(target.getAnimations()[0]).toBe(opacity)
        expect(opacity?.effect).toBe(opacityEffect)
        expect(opacity?.startTime).toBe(opacityStart)
        expect(opacity?.finished).toBe(completion)
        expect(events.filter((property) => property === 'opacity')).toEqual([])
        expect(mode === 'paused' ? opacity?.currentTime : undefined).toBe(
          mode === 'paused' ? opacityTime : undefined,
        )
        if (mode === 'running') {
          await nativeTurn()
          await nativeTurn()
        }
        expect(mode === 'running' ? Number(opacity?.currentTime) > Number(opacityTime) : true).toBe(
          true,
        )
        if (opacity) {
          opacity.finish()
          await completion
        }
        expect(errors).toEqual([])
      } finally {
        native.cancel()
        reference.remove()
      }
    },
  )
  it('retries a failed transient observation cancellation through coordinator recovery and disposal', async () => {
    const width = ref(100)
    const { host, errors, app } = await mount(
      motionComponent(definition(), ({ root }) =>
        h(
          'div',
          {
            'data-ancestor': '',
            style: {
              width: '400px',
              height: '200px',
              transform: 'rotate(25deg)',
              transformOrigin: '0 0',
            },
          },
          [
            root(
              h('div', { 'data-item': '', style: { width: `${width.value}px`, height: '40px' } }),
            ),
          ],
        ),
      ),
    )
    const target = element(host)
    const handled: unknown[] = []
    app.config.errorHandler = (error) => {
      handled.push(error)
    }
    width.value = 200
    await flush()
    frame(250)
    const cause = new Error('Transient observation cancellation failed once')
    const held: Animation[] = []
    let restoring = false
    let fail = true
    // Retain native methods only for explicit .call(this) in the wrappers below.
    // eslint-disable-next-line typescript/unbound-method
    const observeLayout = PresentationExecutor.prototype.layoutMeasure
    // eslint-disable-next-line typescript/unbound-method
    const cancel = Animation.prototype.cancel
    vi.spyOn(PresentationExecutor.prototype, 'layoutMeasure').mockImplementation(function (
      this: PresentationExecutor,
      receiver,
      properties,
    ) {
      const restore = observeLayout.call(this, receiver, properties)
      return () => {
        restoring = true
        try {
          restore()
        } finally {
          restoring = false
        }
      }
    })
    vi.spyOn(Animation.prototype, 'cancel').mockImplementation(function (this: Animation) {
      const first =
        this.effect instanceof KeyframeEffect ? this.effect.getKeyframes()[0] : undefined
      if (
        restoring &&
        fail &&
        first &&
        'rotate' in first &&
        'translate' in first &&
        'scale' in first
      ) {
        fail = false
        held.push(this)
        throw cause
      }
      cancel.call(this)
    })

    width.value = 300
    await flush()
    await flush()

    expect(held).toHaveLength(1)
    expect(held[0].playState).toBe('idle')
    expect(errors.map((error) => error.error)).toEqual([cause])
    expect(handled).toEqual([cause])
    width.value = 400
    await flush()
    frame(1000)
    expect(held[0].playState).toBe('idle')
    expect(target.style.transform).toBe('')
    app.unmount()
    apps.splice(apps.indexOf(app), 1)
    expect(held[0].playState).toBe('idle')
    expect(target.getAnimations()).toEqual([])
  })
})
