import {
  LivaInstance,
  LifecycleSession,
  waapiProperty,
  type Definition,
  type Expression,
  type RuntimeDiagnostic,
  type Timing,
} from '../../packages/runtime/src/index.ts'

import { decodeProperty } from '../../packages/runtime/src/motion/property-codec.ts'
import { PropertyMotion } from '../../packages/runtime/src/motion/property-motion.ts'

const literal = (value: string) => ({ kind: 'literal' as const, value })
const reference = (...path: string[]): Expression => ({ kind: 'reference', path })
const tween: Timing = { kind: 'tween', durationMs: 400, easing: 'linear' }
const physics: Timing = { kind: 'spring-physics', stiffness: 300, damping: 25, mass: 1 }

function setup(definition: Definition, inputs: Record<string, unknown> = {}, style = '') {
  const element = document.createElement('div')
  element.style.cssText = `position:relative;width:40px;height:40px;translate:0px 0px;${style}`
  document.body.append(element)
  const diagnostics: RuntimeDiagnostic[] = []
  const failures: unknown[] = []
  const instance = new LivaInstance(definition, inputs, (diagnostic) =>
    diagnostics.push(diagnostic),
  )
  instance.bind([
    ['box', element],
    ['self', element],
  ])
  const sessions: LifecycleSession[] = []

  return {
    element,
    instance,
    diagnostics,
    failures,
    start(phase: 'enter' | 'leave', reverse?: LifecycleSession) {
      const work = instance.captureLifecycle(phase, ['box'], element).map((item) =>
        reverse
          ? {
              ...item,
              track: {
                ...item.track,
                keyframes: item.track.keyframes.map((frame, index) =>
                  index === 0
                    ? {
                        ...frame,
                        value: getComputedStyle(element).getPropertyValue(item.track.property),
                      }
                    : frame,
                ),
              },
            }
          : item,
      )
      instance.releaseLifecycle(
        ['box'],
        element,
        work.map((item) => item.track.property),
      )
      reverse?.cancel('superseded')
      const session = new LifecycleSession(work, phase, (error) => failures.push(error))
      sessions.push(session)
      session.initialize()
      instance.retainLifecycle(phase, session)
      session.play()

      return session
    },
    cleanup() {
      for (const session of sessions) session.cancel('owner-teardown')

      instance.dispose()
      element.remove()
    },
  }
}

function effect(element: HTMLElement, property: string): Animation {
  const key = waapiProperty(property)
  const animation = element
    .getAnimations()
    .find(
      (candidate) =>
        candidate.effect instanceof KeyframeEffect &&
        candidate.effect.getKeyframes().some((frame) => frame[key] !== undefined),
    )

  if (!animation) throw new Error(`Missing ${property} animation`)

  return animation
}

function frames(animation: Animation) {
  if (!(animation.effect instanceof KeyframeEffect)) throw new Error('Expected keyframe effect')

  return animation.effect.getKeyframes()
}

function position(element: HTMLElement, animation: Animation, time: number) {
  animation.pause()
  animation.currentTime = time

  return parseFloat(getComputedStyle(element).translate)
}

/** Keeps actual native handles when the browser omits detached targets from getAnimations(). */
function observeNativeAnimations() {
  const NativeAnimation = globalThis.Animation
  const animations: Animation[] = []
  globalThis.Animation = new Proxy(NativeAnimation, {
    construct(target, args, constructor) {
      const animation: unknown = Reflect.construct(target, args, constructor)

      if (!(animation instanceof NativeAnimation)) throw new Error('Expected native animation')
      animations.push(animation)

      return animation
    },
  })

  return {
    animations,
    restore(this: void) {
      globalThis.Animation = NativeAnimation
    },
  }
}

async function paint() {
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  )
}

function base(property: string, value: string, timing?: Timing): Definition['layers'][number] {
  return {
    name: 'base',
    targets: [{ name: 'box', properties: [{ name: property, value: literal(value), timing }] }],
  }
}

export const presenceCases = {
  async retarget() {
    const fixture = setup(
      {
        name: 'retarget',
        parameters: [{ name: 'active', type: 'boolean' }],
        layers: [
          base('opacity', '1', { ...tween, durationMs: 800 }),
          {
            name: 'selected',
            when: reference('active'),
            targets: [
              {
                name: 'box',
                properties: [
                  { name: 'opacity', value: literal('0.6'), timing: { ...tween, durationMs: 80 } },
                ],
              },
            ],
          },
        ],
        enter: {
          timing: tween,
          targets: [
            {
              name: 'box',
              properties: [{ name: 'opacity', keyframes: [{ offset: 0, value: literal('0') }] }],
            },
          ],
        },
      },
      { active: false },
    )

    try {
      const session = fixture.start('enter')
      const first = effect(fixture.element, 'opacity')
      await first.ready
      first.pause()
      first.currentTime = 100
      const start = getComputedStyle(fixture.element).opacity
      const initialDuration = first.effect?.getTiming().duration
      const obsolete = first.finished.catch(() => undefined)
      let settled = false
      void session.finished.then(() => {
        settled = true

        return undefined
      })

      fixture.instance.updateParameters({ active: true })
      const replacement = effect(fixture.element, 'opacity')
      replacement.pause()
      replacement.currentTime = 0
      await obsolete
      const premature = settled
      const sampled = getComputedStyle(fixture.element).opacity
      const duration = replacement.effect?.getTiming().duration
      const end = frames(replacement).at(-1)?.opacity
      replacement.finish()
      const result = await session.finished

      return {
        start,
        sampled,
        initialDuration,
        duration,
        end,
        premature,
        result,
        final: fixture.element.style.opacity,
        composition: fixture.instance.composition,
        diagnostics: fixture.diagnostics.length,
        failures: fixture.failures.length,
      }
    } finally {
      fixture.cleanup()
    }
  },

  async timing() {
    const fixture = setup({
      name: 'timing',
      layers: [
        base('opacity', '1', { ...tween, durationMs: 800 }),
        {
          name: 'scale',
          targets: [
            {
              name: 'box',
              properties: [
                { name: 'scale', value: literal('1') },
                { name: 'translate', value: literal('0px') },
              ],
            },
          ],
        },
      ],
      enter: {
        timing: { ...tween, durationMs: 400 },
        targets: [
          {
            name: 'box',
            timing: { ...tween, durationMs: 240 },
            timingProperties: ['opacity', 'scale'],
            properties: [
              {
                name: 'opacity',
                timing: { ...tween, durationMs: 160 },
                keyframes: [{ offset: 0, value: literal('0') }],
              },
              { name: 'scale', keyframes: [{ offset: 0, value: literal('0.5') }] },
              { name: 'translate', keyframes: [{ offset: 0, value: literal('20px') }] },
            ],
          },
        ],
      },
    })

    try {
      const session = fixture.start('enter')
      const durations = ['opacity', 'scale', 'translate'].map(
        (property) => effect(fixture.element, property).effect?.getTiming().duration,
      )

      for (const animation of fixture.element.getAnimations()) animation.finish()

      await session.finished

      return durations
    } finally {
      fixture.cleanup()
    }
  },

  async liveLeave() {
    const fixture = setup(
      {
        name: 'live',
        parameters: [{ name: 'exit', type: 'number' }],
        layers: [base('opacity', '1')],
        leave: {
          timing: tween,
          targets: [
            {
              name: 'box',
              properties: [
                {
                  name: 'opacity',
                  keyframes: [
                    { offset: 1, value: { kind: 'template', parts: [reference('exit')] } },
                  ],
                },
              ],
            },
          ],
        },
      },
      { exit: 0.2 },
    )

    try {
      const session = fixture.start('leave')
      const first = effect(fixture.element, 'opacity')
      await first.ready
      first.pause()
      first.currentTime = 100
      const start = getComputedStyle(fixture.element).opacity
      const obsolete = first.finished.catch(() => undefined)
      let settled = false
      void session.finished.then(() => {
        settled = true

        return undefined
      })

      fixture.instance.updateParameters({ exit: 0.6 })
      const replacement = effect(fixture.element, 'opacity')
      replacement.pause()
      replacement.currentTime = 0
      await obsolete
      const initial = getComputedStyle(fixture.element).opacity
      const end = frames(replacement).at(-1)?.opacity
      const premature = settled
      replacement.finish()
      const result = await session.finished

      return {
        start,
        initial,
        end,
        premature,
        result,
        errors: fixture.diagnostics.length + fixture.failures.length,
      }
    } finally {
      fixture.cleanup()
    }
  },

  async detachedEnvironment(detached: boolean) {
    const fixture = setup({
      name: 'detached',
      letBindings: [
        {
          name: 'bounds',
          initializer: {
            kind: 'call',
            function: 'measure',
            arguments: [{ name: 'target', value: reference('box') }],
          },
        },
      ],
      layers: [
        base('opacity', '1'),
        {
          name: 'observed',
          targets: [
            {
              name: 'box',
              properties: [
                {
                  name: '--observed',
                  value: { kind: 'template', parts: [reference('bounds', 'width')] },
                },
              ],
            },
          ],
        },
      ],
      leave: {
        timing: tween,
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
                      kind: 'template',
                      parts: [
                        {
                          kind: 'binary',
                          operator: '/',
                          left: reference('bounds', 'width'),
                          right: { kind: 'number', value: 100 },
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    })
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Forwarded with the real observer receiver.
    const nativeUnobserve = ResizeObserver.prototype.unobserve
    let sourceReleased = false
    ResizeObserver.prototype.unobserve = function (element) {
      nativeUnobserve.call(this, element)
      if (element === fixture.element) sourceReleased = true
    }
    let session: LifecycleSession | undefined
    const { animations, restore } = observeNativeAnimations()

    try {
      await paint()
      const work = fixture.instance.captureLifecycle('leave', ['box'], fixture.element)
      fixture.element.style.width = '60px'
      await paint()

      if (fixture.element.style.getPropertyValue('--observed') !== '60')
        throw new Error('Measurement was not accepted before disposal')

      fixture.instance.dispose()
      fixture.element.style.width = '80px'

      if (detached) fixture.element.remove()

      await paint()
      session = new LifecycleSession(work, 'leave')
      session.initialize()
      session.play()
      const animation = animations.find(
        (candidate) =>
          candidate.effect instanceof KeyframeEffect && candidate.effect.target === fixture.element,
      )

      if (!animation) throw new Error('Missing detached native effect')
      const end = frames(animation).at(-1)?.opacity
      animation.finish()
      const result = await session.finished

      return {
        end,
        result,
        sourceReleased,
        remaining: fixture.element.getAnimations().length,
        errors: fixture.diagnostics.length,
      }
    } finally {
      ResizeObserver.prototype.unobserve = nativeUnobserve
      restore()
      session?.cancel('owner-teardown')
      fixture.cleanup()
    }
  },

  async momentum() {
    const fixture = setup(
      {
        name: 'momentum',
        parameters: [{ name: 'active', type: 'boolean' }],
        layers: [
          base('translate', '0px 0px', physics),
          {
            name: 'selected',
            when: reference('active'),
            targets: [
              {
                name: 'box',
                properties: [{ name: 'translate', value: literal('100px 0px'), timing: physics }],
              },
            ],
          },
        ],
        enter: {
          timing: physics,
          targets: [
            {
              name: 'box',
              properties: [
                { name: 'translate', keyframes: [{ offset: 0, value: literal('0px 0px') }] },
              ],
            },
          ],
        },
        leave: {
          timing: physics,
          targets: [
            {
              name: 'box',
              properties: [
                { name: 'translate', keyframes: [{ offset: 1, value: literal('-100px 0px') }] },
              ],
            },
          ],
        },
      },
      { active: false },
    )

    try {
      fixture.instance.updateParameters({ active: true })
      const first = effect(fixture.element, 'translate')
      await first.ready
      const ordinary = position(fixture.element, first, 60)
      const leave = fixture.start('leave')
      const second = effect(fixture.element, 'translate')
      await second.ready
      const leaveStart = position(fixture.element, second, 0)
      const leaveNext = position(fixture.element, second, 1)
      const returning = position(fixture.element, second, 120)
      const enter = fixture.start('enter', leave)
      const third = effect(fixture.element, 'translate')
      await third.ready
      const enterStart = position(fixture.element, third, 0)
      const enterNext = position(fixture.element, third, 1)
      third.finish()
      const result = await enter.finished

      return {
        ordinary,
        leaveStart,
        leaveNext,
        returning,
        enterStart,
        enterNext,
        result,
        errors: fixture.diagnostics.length + fixture.failures.length,
      }
    } finally {
      fixture.cleanup()
    }
  },

  async settledGap() {
    const fixture = setup(
      {
        name: 'gap',
        parameters: [{ name: 'active', type: 'boolean' }],
        layers: [
          base('opacity', '1', tween),
          {
            name: 'selected',
            when: reference('active'),
            targets: [
              {
                name: 'box',
                properties: [{ name: 'opacity', value: literal('0.6'), timing: tween }],
              },
            ],
          },
        ],
        enter: {
          timing: tween,
          targets: [
            {
              name: 'box',
              properties: [{ name: 'opacity', keyframes: [{ offset: 0, value: literal('0') }] }],
            },
          ],
        },
      },
      { active: false },
    )

    try {
      const session = fixture.start('enter')
      const first = effect(fixture.element, 'opacity')
      first.finish()
      await first.finished

      fixture.instance.updateParameters({ active: true })
      const replacement = effect(fixture.element, 'opacity')
      await session.finished

      const retained = fixture.element.getAnimations().includes(replacement)
      replacement.finish()
      await replacement.finished

      return {
        retained,
        result: fixture.element.style.opacity,
        errors: fixture.diagnostics.length + fixture.failures.length,
      }
    } finally {
      fixture.cleanup()
    }
  },
  async freshStart() {
    const fixture = setup(
      {
        name: 'fresh-start',
        parameters: [{ name: 'start', type: 'number' }],
        layers: [base('opacity', '1')],
        enter: {
          timing: tween,
          targets: [
            {
              name: 'box',
              properties: [
                {
                  name: 'opacity',
                  keyframes: [
                    { offset: 0, value: { kind: 'template', parts: [reference('start')] } },
                  ],
                },
              ],
            },
          ],
        },
      },
      { start: 0 },
    )
    let session: LifecycleSession | undefined

    try {
      const work = fixture.instance.captureLifecycle('enter', ['box'], fixture.element)
      fixture.instance.updateParameters({ start: 0.3 })
      session = new LifecycleSession(work, 'enter')
      session.initialize()
      const initialized = getComputedStyle(fixture.element).opacity
      session.play()
      const animation = effect(fixture.element, 'opacity')
      animation.pause()
      animation.currentTime = 0
      const first = frames(animation)[0].opacity
      animation.finish()
      await session.finished

      return { initialized, first, errors: fixture.diagnostics.length }
    } finally {
      session?.cancel('owner-teardown')
      fixture.cleanup()
    }
  },

  async directHandoff(expired: boolean, newer: boolean) {
    let clock = 1000
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Restored to its original receiver in finally.
    const nativeNow = performance.now
    Object.defineProperty(performance, 'now', { configurable: true, value: () => clock })
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Forwarded with the original receiver.
    const nativeEnd = PropertyMotion.prototype.endControl
    PropertyMotion.prototype.endControl = function (...args) {
      nativeEnd.apply(this, args)
      // Release and final planning are separate phases on the same monotonic clock.
      clock = expired ? 1100 : 1081
    }
    const fixture = setup(
      {
        name: 'direct-handoff',
        parameters: [{ name: 'input', type: 'number' }],
        letBindings: [
          {
            name: 'movement',
            initializer: {
              kind: 'call',
              function: 'link',
              arguments: [
                { name: 'input', value: reference('input') },
                { name: 'component', value: { kind: 'string', value: 'x' } },
              ],
            },
          },
        ],
        layers: [
          {
            name: 'base',
            targets: [
              {
                name: 'box',
                properties: [
                  {
                    name: 'translate',
                    value: { kind: 'binding', expression: reference('movement') },
                  },
                ],
              },
            ],
          },
        ],
        leave: {
          timing: physics,
          targets: [
            {
              name: 'box',
              properties: [
                { name: 'translate', keyframes: [{ offset: 1, value: literal('-100px 0px') }] },
              ],
            },
          ],
        },
      },
      { input: 0 },
    )
    let session: LifecycleSession | undefined

    try {
      clock = 1010
      fixture.instance.updateParameters({ input: 10 })
      clock = 1070
      const work = fixture.instance.captureLifecycle('leave', ['box'], fixture.element)

      if (newer) {
        clock = 1075
        fixture.instance.updateParameters({ input: -30 })
      }

      clock = 1080
      fixture.instance.releaseLifecycle(['box'], fixture.element, ['translate'])
      session = new LifecycleSession(work, 'leave')
      session.initialize()
      fixture.instance.retainLifecycle('leave', session)
      session.play()
      const animation = effect(fixture.element, 'translate')
      await animation.ready
      const start = position(fixture.element, animation, 0)
      const next = position(fixture.element, animation, 1)
      animation.finish()
      await session.finished

      return { start, next, errors: fixture.diagnostics.length }
    } finally {
      session?.cancel('owner-teardown')
      fixture.cleanup()
      Object.defineProperty(performance, 'now', { configurable: true, value: nativeNow })
      PropertyMotion.prototype.endControl = nativeEnd
    }
  },

  async lowerUpdates() {
    const fixture = setup(
      {
        name: 'lower',
        parameters: [{ name: 'active', type: 'boolean' }],
        layers: [
          base('opacity', '1'),
          {
            name: 'selected',
            when: reference('active'),
            targets: [
              {
                name: 'box',
                properties: [
                  { name: 'opacity', value: literal('0.7'), timing: tween },
                  { name: 'scale', value: literal('1.5'), timing: tween },
                ],
              },
            ],
          },
        ],
        leave: {
          timing: tween,
          targets: [
            {
              name: 'box',
              properties: [{ name: 'opacity', keyframes: [{ offset: 1, value: literal('0') }] }],
            },
          ],
        },
      },
      { active: false },
    )

    try {
      const session = fixture.start('leave')
      const leaving = effect(fixture.element, 'opacity')
      await leaving.ready
      leaving.pause()
      leaving.currentTime = 100
      const before = getComputedStyle(fixture.element).opacity
      fixture.instance.updateParameters({ active: true })
      const retained = effect(fixture.element, 'opacity') === leaving
      const scale = effect(fixture.element, 'scale')
      scale.finish()
      const after = getComputedStyle(fixture.element).opacity
      leaving.finish()
      await session.finished

      return {
        retained,
        before,
        after,
        scale: fixture.element.style.scale,
        errors: fixture.diagnostics.length + fixture.failures.length,
      }
    } finally {
      fixture.cleanup()
    }
  },

  async authoredEndpoint(presence: boolean) {
    const target = (value: string) => [
      { name: 'box', properties: [{ name: 'translate', value: literal(value), timing: physics }] },
    ]
    const fixture = setup(
      {
        name: 'endpoint',
        parameters: [
          { name: 'active', type: 'boolean' },
          { name: 'next', type: 'boolean' },
        ],
        layers: [
          {
            name: 'base',
            targets: [],
            states: [
              { name: 'start', targets: target('0px 0px') },
              { name: 'middle', targets: target('100px 0px') },
              { name: 'end', targets: target('200px 0px') },
            ],
            initialState: 'start',
            transitions: [
              {
                from: 'start',
                to: 'middle',
                when: reference('active'),
                transition: { timing: physics, targets: [] },
              },
              {
                from: 'middle',
                to: 'end',
                when: reference('next'),
                transition: {
                  timing: physics,
                  targets: [
                    {
                      name: 'box',
                      properties: [
                        {
                          name: 'translate',
                          keyframes: [{ offset: 1, value: literal('50px 0px') }],
                        },
                      ],
                    },
                  ],
                },
              },
            ],
          },
        ],
        enter: {
          timing: physics,
          targets: [
            {
              name: 'box',
              properties: [
                {
                  name: 'translate',
                  keyframes: [
                    { offset: 0, value: literal('0px 0px') },
                    { offset: 1, value: literal('50px 0px') },
                  ],
                },
              ],
            },
          ],
        },
      },
      { active: false, next: false },
    )
    let session: LifecycleSession | undefined

    try {
      fixture.instance.updateParameters({ active: true, next: false })
      const first = effect(fixture.element, 'translate')
      await first.ready
      let incoming = position(fixture.element, first, 60)

      if (presence) {
        const work = fixture.instance
          .captureLifecycle('enter', ['box'], fixture.element)
          .map((item) => ({
            ...item,
            track: {
              ...item.track,
              keyframes: item.track.keyframes.map((frame, index) =>
                index === 0
                  ? {
                      ...frame,
                      value: getComputedStyle(fixture.element).getPropertyValue(
                        item.track.property,
                      ),
                    }
                  : frame,
              ),
            },
          }))
        fixture.instance.releaseLifecycle(['box'], fixture.element, ['translate'])
        session = new LifecycleSession(work, 'enter')
        session.initialize()
        fixture.instance.retainLifecycle('enter', session)
        session.play()
      } else fixture.instance.updateParameters({ active: true, next: true })

      const animation = effect(fixture.element, 'translate')
      await animation.ready
      const start = position(fixture.element, animation, 0)
      const last = frames(animation).at(-1)?.translate
      animation.finish()

      if (session) await session.finished
      else await animation.finished

      return {
        incoming,
        start,
        last,
        final: fixture.element.style.translate,
        diagnostics: fixture.diagnostics.map((diagnostic) => diagnostic.code),
        failures: fixture.failures.length,
      }
    } finally {
      fixture.cleanup()
    }
  },

  async relativeRetarget() {
    const parent = document.createElement('div')
    parent.style.width = '200px'
    document.body.append(parent)
    const fixture = setup({
      name: 'relative',
      layers: [
        base('translate', '0px 0px'),
        {
          name: 'history',
          initialState: 's0',
          targets: [],
          states: Array.from({ length: 10 }, (_, index) => ({ name: `s${index}`, targets: [] })),
          transitions: Array.from({ length: 9 }, (_, index) => ({
            from: `s${index}`,
            to: `s${index + 1}`,
            when: { kind: 'boolean' as const, value: true },
            transition: { targets: [] },
          })),
        },
      ],
      leave: {
        timing: physics,
        targets: [
          {
            name: 'box',
            properties: [
              { name: 'translate', keyframes: [{ offset: 1, value: literal('50% 0px') }] },
            ],
          },
        ],
      },
    })
    parent.append(fixture.element)

    try {
      const session = fixture.start('leave')
      const history = JSON.stringify(fixture.instance.composition)
      const first = effect(fixture.element, 'translate')
      await first.ready
      first.pause()
      first.currentTime = 40
      first.play()
      let settled = false
      void session.finished.then(() => {
        settled = true

        return undefined
      })
      fixture.element.style.width = '80px'
      await paint()
      const replacement = effect(fixture.element, 'translate')
      const changed = replacement !== first
      const end = frames(replacement).at(-1)?.translate
      const premature = settled
      const historyStable = history === JSON.stringify(fixture.instance.composition)
      fixture.instance.updateParameters({})
      const guardActive = history !== JSON.stringify(fixture.instance.composition)
      replacement.finish()
      await session.finished

      return {
        changed,
        end,
        premature,
        historyStable,
        guardActive,
        errors: fixture.diagnostics.length + fixture.failures.length,
      }
    } finally {
      fixture.cleanup()
      parent.remove()
    }
  },

  async lateReduced() {
    const fixture = setup({
      name: 'late-reduced',
      layers: [base('opacity', '1')],
      leave: {
        timing: tween,
        targets: [
          {
            name: 'box',
            properties: [{ name: 'opacity', keyframes: [{ offset: 1, value: literal('0') }] }],
          },
        ],
      },
    })
    let session: LifecycleSession | undefined

    try {
      const work = fixture.instance.captureLifecycle('leave', ['box'], fixture.element)
      fixture.instance.dispose()
      session = new LifecycleSession(work, 'leave')
      session.initialize()
      session.play()
      const animation = effect(fixture.element, 'opacity')
      await animation.ready
      animation.pause()
      animation.currentTime = 100
      fixture.element.dataset.presenceReady = 'true'
      const result = await session.finished

      return {
        result,
        remaining: fixture.element.getAnimations().length,
        restored: fixture.element.style.opacity,
        errors: fixture.diagnostics.length,
      }
    } finally {
      session?.cancel('owner-teardown')
      fixture.cleanup()
    }
  },
  async multiOwner() {
    const definition: Definition = {
      name: 'multi',
      parameters: [{ name: 'exit', type: 'number' }],
      layers: [base('opacity', '1')],
      leave: {
        timing: tween,
        targets: [
          {
            name: 'box',
            properties: [
              {
                name: 'opacity',
                keyframes: [{ offset: 1, value: { kind: 'template', parts: [reference('exit')] } }],
              },
            ],
          },
        ],
      },
    }
    const first = setup(definition, { exit: 0.2 })
    const second = setup(definition, { exit: 0.3 })
    const repeated = document.createElement('div')
    document.body.append(repeated)
    first.instance.bind([
      ['box', first.element],
      ['box', repeated],
    ])
    let session: LifecycleSession | undefined

    try {
      const work = [
        ...first.instance.captureLifecycle('leave', ['box'], first.element),
        ...first.instance.captureLifecycle('leave', ['box'], repeated),
        ...second.instance.captureLifecycle('leave', ['box'], second.element),
      ]
      session = new LifecycleSession(
        work.map((item) => ({ ...item, track: { ...item.track } })),
        'leave',
      )
      session.initialize()
      first.instance.retainLifecycle('leave', session)
      second.instance.retainLifecycle('leave', session)
      session.play()
      const original = effect(first.element, 'opacity')
      const oldRepeated = effect(repeated, 'opacity')
      const other = effect(second.element, 'opacity')
      oldRepeated.pause()
      other.pause()
      original.finish()
      await original.finished
      let settled = false
      void session.finished.then(() => {
        settled = true
        return undefined
      })

      const oldCancelled = oldRepeated.finished.catch(() => undefined)

      first.instance.updateParameters({ exit: 0.6 })
      const replacement = effect(first.element, 'opacity')
      const replacementRepeated = effect(repeated, 'opacity')
      replacement.pause()
      replacementRepeated.pause()
      other.finish()
      await other.finished
      await oldCancelled
      const premature = settled
      const endpoints = [replacement, replacementRepeated].map(
        (animation) => frames(animation).at(-1)?.opacity,
      )
      replacement.finish()
      replacementRepeated.finish()
      const result = await session.finished

      return {
        premature,
        endpoints,
        result,
        remaining: [first.element, repeated, second.element].reduce(
          (total, element) => total + element.getAnimations().length,
          0,
        ),
        errors: first.diagnostics.length + second.diagnostics.length,
      }
    } finally {
      session?.cancel('owner-teardown')
      first.cleanup()
      second.cleanup()
      repeated.remove()
    }
  },
  async directExpiry(expired: boolean) {
    let clock = 1000
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Restored on performance in finally.
    const nativeNow = performance.now
    Object.defineProperty(performance, 'now', { configurable: true, value: () => clock })
    const fixture = setup(
      {
        name: 'expiry',
        parameters: [{ name: 'input', type: 'number' }],
        layers: [
          {
            name: 'base',
            targets: [
              {
                name: 'box',
                properties: [
                  {
                    name: 'translate',
                    value: { kind: 'template', parts: [reference('input'), 'px 0px'] },
                  },
                ],
              },
            ],
          },
        ],
        leave: {
          timing: physics,
          targets: [
            {
              name: 'box',
              properties: [
                { name: 'translate', keyframes: [{ offset: 1, value: literal('-100px 0px') }] },
              ],
            },
          ],
        },
      },
      { input: 0 },
    )
    let session: LifecycleSession | undefined

    try {
      clock = 1010
      fixture.instance.updateParameters({ input: 10 })
      clock = 1070
      const work = fixture.instance.captureLifecycle('leave', ['box'], fixture.element)
      clock = 1080
      fixture.instance.dispose()
      clock = expired ? 1100 : 1081
      session = new LifecycleSession(work, 'leave')
      // Playing without initialize is supported by the direct session API.
      session.play()
      const animation = effect(fixture.element, 'translate')
      await animation.ready
      const start = position(fixture.element, animation, 0)
      const next = position(fixture.element, animation, 1)
      animation.finish()
      await session.finished

      return { start, next, errors: fixture.diagnostics.length }
    } finally {
      session?.cancel('owner-teardown')
      fixture.cleanup()
      Object.defineProperty(performance, 'now', { configurable: true, value: nativeNow })
    }
  },
  async controllerOwnership(mode: 'exact' | 'component' | 'enter' = 'exact') {
    const property = mode === 'component' ? 'left' : 'width'
    const phase = mode === 'enter' ? 'enter' : 'leave'
    const fixture = setup(
      {
        name: 'ownership',
        parameters: [{ name: 'input', type: 'number' }],
        letBindings: [
          {
            name: 'movement',
            initializer: {
              kind: 'call',
              function: 'link',
              arguments: [{ name: 'input', value: reference('input') }],
            },
          },
        ],
        layers: [
          {
            name: 'base',
            targets: [
              {
                name: 'box',
                properties: [
                  {
                    name: mode === 'component' ? 'inset-inline-start' : 'width',
                    value: { kind: 'binding', expression: reference('movement') },
                  },
                ],
              },
            ],
          },
        ],
        [phase]: {
          timing: tween,
          targets: [
            {
              name: 'box',
              properties: [
                {
                  name: mode === 'component' ? 'left' : 'inline-size',
                  keyframes: [{ offset: 1, value: literal('100px') }],
                },
              ],
            },
          ],
        },
      },
      { input: 0 },
      mode === 'component' ? 'left:0px;' : '',
    )

    const other = document.createElement('div')
    other.style.cssText = 'position:relative;width:40px;left:0px;'
    document.body.append(other)
    fixture.instance.bind([
      ['box', fixture.element],
      ['box', other],
    ])

    try {
      fixture.instance.updateParameters({ input: 10 })
      const session = fixture.start(phase)
      const animation = effect(fixture.element, property)
      await animation.ready
      animation.pause()
      animation.currentTime = 100
      const held = getComputedStyle(fixture.element).getPropertyValue(property)
      const otherHeld = getComputedStyle(other).getPropertyValue(property)
      fixture.instance.updateParameters({ input: 40 })
      const retained = effect(fixture.element, property) === animation
      const unchanged = getComputedStyle(fixture.element).getPropertyValue(property) === held
      const otherStable = getComputedStyle(other).getPropertyValue(property) === otherHeld
      session.cancel('superseded')
      const released = parseFloat(getComputedStyle(other).getPropertyValue(property))
      fixture.instance.updateParameters({ input: 50 })
      const resumed = parseFloat(getComputedStyle(other).getPropertyValue(property))

      return {
        retained,
        unchanged,
        otherStable,
        increment: resumed - released,
        errors: fixture.diagnostics.length + fixture.failures.length,
      }
    } finally {
      fixture.cleanup()
      other.remove()
    }
  },
  async relativeRole(completion: boolean) {
    const fixture = setup({
      name: 'relative-role',
      layers: [base('translate', completion ? '100% 0px' : '100px 0px')],
      enter: {
        timing: physics,
        targets: [
          {
            name: 'box',
            properties: [
              {
                name: 'translate',
                keyframes: [
                  { offset: 0, value: literal('0px 0px') },
                  { offset: 1, value: literal(completion ? '50px 0px' : '50% 0px') },
                ],
              },
            ],
          },
        ],
      },
    })
    let session: LifecycleSession | undefined

    try {
      const work = fixture.instance.captureLifecycle('enter', ['box'], fixture.element)
      fixture.instance.dispose()
      session = new LifecycleSession(work, 'enter')
      session.initialize()
      session.play()
      const first = effect(fixture.element, 'translate')
      await first.ready
      fixture.element.style.width = '80px'
      await paint()
      const replacement = effect(fixture.element, 'translate')
      const changed = replacement !== first
      const end = frames(replacement).at(-1)?.translate
      replacement.finish()
      const result = await session.finished

      return {
        changed,
        end,
        result,
        final: fixture.element.style.translate,
        errors: fixture.diagnostics.length,
      }
    } finally {
      session?.cancel('owner-teardown')
      fixture.cleanup()
    }
  },

  async replacementDuringLeave() {
    const fixture = setup(
      {
        name: 'replace',
        parameters: [{ name: 'exit', type: 'number' }],
        layers: [base('opacity', '1')],
        leave: {
          timing: tween,
          targets: [
            {
              name: 'box',
              properties: [
                {
                  name: 'opacity',
                  keyframes: [
                    { offset: 1, value: { kind: 'template', parts: [reference('exit')] } },
                  ],
                },
              ],
            },
          ],
        },
      },
      { exit: 0.2 },
    )

    try {
      const session = fixture.start('leave')
      const first = effect(fixture.element, 'opacity')
      await first.ready
      first.pause()
      first.currentTime = 100
      fixture.instance.replaceDefinition({ name: 'new', layers: [base('scale', '1.5')] })
      const retained = effect(fixture.element, 'opacity') === first
      const end = frames(first).at(-1)?.opacity
      const scale = fixture.element.style.scale
      first.finish()
      const result = await session.finished

      return {
        retained,
        end,
        scale,
        result,
        errors: fixture.diagnostics.length + fixture.failures.length,
      }
    } finally {
      fixture.cleanup()
    }
  },
  async shorthandHandoff() {
    const fixture = setup(
      {
        name: 'shorthand',
        parameters: [{ name: 'active', type: 'boolean' }],
        layers: [
          base('inset', '0px', physics),
          {
            name: 'selected',
            when: reference('active'),
            targets: [
              {
                name: 'box',
                properties: [{ name: 'inset', value: literal('100px'), timing: physics }],
              },
            ],
          },
        ],
        leave: {
          timing: physics,
          targets: [
            {
              name: 'box',
              properties: [
                { name: 'left', keyframes: [{ offset: 1, value: literal('-100px') }] },
                {
                  name: 'inset-inline-start',
                  keyframes: [{ offset: 1, value: literal('-100px') }],
                },
              ],
            },
          ],
        },
      },
      { active: false },
    )

    try {
      fixture.instance.updateParameters({ active: true })
      const ordinary = fixture.element.getAnimations()

      for (const animation of ordinary) {
        await animation.ready
        animation.pause()
        animation.currentTime = 60
      }

      const incoming = parseFloat(getComputedStyle(fixture.element).left)
      const session = fixture.start('leave')
      const remainingOrdinary = fixture.instance.animations.length
      const leaving = effect(fixture.element, 'left')
      await leaving.ready
      leaving.pause()
      leaving.currentTime = 0
      const start = parseFloat(getComputedStyle(fixture.element).left)
      leaving.currentTime = 1
      const next = parseFloat(getComputedStyle(fixture.element).left)

      for (const animation of fixture.element.getAnimations()) animation.finish()

      const result = await session.finished

      return {
        incoming,
        start,
        next,
        remainingOrdinary,
        result,
        errors: fixture.diagnostics.length + fixture.failures.length,
      }
    } finally {
      fixture.cleanup()
    }
  },
  async detachedLive() {
    const fixture = setup(
      {
        name: 'detached-live',
        parameters: [
          { name: 'exit', type: 'number' },
          { name: 'active', type: 'boolean' },
        ],
        layers: [
          base('opacity', '1'),
          {
            name: 'new',
            when: reference('active'),
            targets: [
              { name: 'box', properties: [{ name: 'scale', value: literal('2'), timing: tween }] },
            ],
          },
        ],
        leave: {
          timing: tween,
          targets: [
            {
              name: 'box',
              properties: [
                {
                  name: 'opacity',
                  keyframes: [
                    { offset: 1, value: { kind: 'template', parts: [reference('exit')] } },
                  ],
                },
              ],
            },
          ],
        },
      },
      { exit: 0.2, active: false },
    )
    fixture.element.style.scale = '1'
    const { animations, restore } = observeNativeAnimations()

    try {
      const session = fixture.start('leave')
      fixture.element.remove()
      fixture.instance.updateParameters({ exit: 0.6, active: true })
      const active = animations.filter((animation) => animation.playState !== 'idle')
      const endpoints = active.flatMap((animation) =>
        frames(animation)
          .slice(-1)
          .map((frame) => ({ opacity: frame.opacity, scale: frame.scale })),
      )

      for (const animation of active) animation.finish()

      return {
        endpoints,
        result: await session.finished,
        errors: fixture.diagnostics.length + fixture.failures.length,
      }
    } finally {
      restore()
      fixture.cleanup()
    }
  },

  async unsupportedColor() {
    const fixture = setup({
      name: 'color',
      layers: [base('color', 'red')],
      leave: {
        timing: physics,
        targets: [
          {
            name: 'box',
            properties: [{ name: 'color', keyframes: [{ offset: 1, value: literal('blue') }] }],
          },
        ],
      },
    })

    try {
      const session = fixture.start('leave')
      const animation = effect(fixture.element, 'color')
      const keyframes = frames(animation)
      animation.finish()

      return {
        count: keyframes.length,
        endpoint: keyframes.at(-1)?.color,
        result: await session.finished,
        final: fixture.element.style.color,
        errors: fixture.diagnostics.length + fixture.failures.length,
      }
    } finally {
      fixture.cleanup()
    }
  },
  async previewDuringEnter() {
    const fixture = setup({
      name: 'preview',
      layers: [base('opacity', '1', tween)],
      enter: {
        timing: tween,
        targets: [
          {
            name: 'box',
            properties: [{ name: 'opacity', keyframes: [{ offset: 0, value: literal('0') }] }],
          },
        ],
      },
    })

    try {
      const session = fixture.start('enter')
      fixture.instance.previewComposition(
        fixture.instance.composition,
        fixture.instance.composition,
      )
      const result = await session.finished
      const manual = fixture.instance.animations.length
      const paused = fixture.instance.animations.every(
        (animation) => animation.playState === 'paused',
      )
      fixture.instance.endCompositionPreview()

      return {
        result,
        manual,
        paused,
        remaining: fixture.element.getAnimations().length,
        final: fixture.element.style.opacity,
        errors: fixture.diagnostics.length + fixture.failures.length,
      }
    } finally {
      fixture.cleanup()
    }
  },

  async timingUpdateValidation() {
    const fixture = setup(
      {
        name: 'timing-update',
        parameters: [{ name: 'duration', type: 'number' }],
        layers: [base('opacity', '1')],
        leave: {
          timingExpression: {
            kind: 'call',
            function: 'tween',
            arguments: [
              { name: 'duration', value: reference('duration') },
              { name: 'easing', value: reference('linear') },
            ],
          },
          targets: [
            {
              name: 'box',
              properties: [{ name: 'opacity', keyframes: [{ offset: 1, value: literal('0') }] }],
            },
          ],
        },
      },
      { duration: 400 },
    )

    try {
      const session = fixture.start('leave')
      const first = effect(fixture.element, 'opacity')
      await first.ready
      first.pause()
      first.currentTime = 100
      let notifications = 0
      fixture.instance.onUpdate = () => {
        notifications++
      }
      fixture.instance.updateParameters({ duration: -1 })
      const retained = effect(fixture.element, 'opacity') === first
      const rejectedNotifications = notifications
      fixture.instance.updateParameters({ duration: 200 })
      const replacement = effect(fixture.element, 'opacity')
      replacement.pause()
      replacement.currentTime = 0
      const start = getComputedStyle(fixture.element).opacity
      const duration = replacement.effect?.getTiming().duration
      replacement.finish()
      const result = await session.finished

      return {
        retained,
        rejectedNotifications,
        notifications,
        start,
        duration,
        result,
        diagnostics: fixture.diagnostics.length,
        failures: fixture.failures.length,
      }
    } finally {
      fixture.cleanup()
    }
  },
  async laterTrajectory() {
    const fixture = setup(
      {
        name: 'later-trajectory',
        parameters: [{ name: 'active', type: 'boolean' }],
        layers: [
          base('translate', '0px 0px', physics),
          {
            name: 'selected',
            when: reference('active'),
            targets: [
              {
                name: 'box',
                properties: [{ name: 'translate', value: literal('100px 0px'), timing: physics }],
              },
            ],
          },
        ],
        leave: {
          timing: physics,
          targets: [
            {
              name: 'box',
              properties: [
                { name: 'translate', keyframes: [{ offset: 1, value: literal('-100px 0px') }] },
              ],
            },
          ],
        },
      },
      { active: false },
    )
    let session: LifecycleSession | undefined

    try {
      fixture.instance.updateParameters({ active: true })
      const first = effect(fixture.element, 'translate')
      await first.ready
      position(fixture.element, first, 10)
      const work = fixture.instance.captureLifecycle('leave', ['box'], fixture.element)
      first.playbackRate = 2
      const latest = position(fixture.element, first, 300)
      session = new LifecycleSession(work, 'leave')
      session.initialize()
      fixture.instance.retainLifecycle('leave', session)
      session.play()
      const replacement = effect(fixture.element, 'translate')
      await replacement.ready
      const start = position(fixture.element, replacement, 0)
      const next = position(fixture.element, replacement, 1)
      replacement.finish()
      const result = await session.finished

      return {
        latest,
        start,
        next,
        result,
        errors: fixture.diagnostics.length + fixture.failures.length,
      }
    } finally {
      session?.cancel('owner-teardown')
      fixture.cleanup()
    }
  },
  async failedPreparation(explicit: boolean, disposed: boolean, existing = false) {
    // Observe actual native registrations, including listener reacquisition when
    // work starts after disposal; no event or media-query behavior is simulated.
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Forwarded with the native receiver.
    const nativeAdd = MediaQueryList.prototype.addEventListener
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Forwarded with the native receiver.
    const nativeRemove = MediaQueryList.prototype.removeEventListener
    const listeners = new Set<unknown>()
    MediaQueryList.prototype.addEventListener = function (
      this: MediaQueryList,
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) {
      nativeAdd.call(this, type, listener, options)

      if (type === 'change' && this.media === '(prefers-reduced-motion: reduce)')
        listeners.add(listener)
    }
    MediaQueryList.prototype.removeEventListener = function (
      this: MediaQueryList,
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | EventListenerOptions,
    ) {
      nativeRemove.call(this, type, listener, options)

      if (type === 'change' && this.media === '(prefers-reduced-motion: reduce)')
        listeners.delete(listener)
    }
    const fixture = setup(
      {
        name: 'failed-start',
        parameters: [{ name: 'duration', type: 'number' }],
        layers: [base('opacity', '1')],
        leave: {
          timingExpression: {
            kind: 'call',
            function: 'tween',
            arguments: [{ name: 'duration', value: reference('duration') }],
          },
          targets: [
            {
              name: 'box',
              properties: [{ name: 'opacity', keyframes: [{ offset: 1, value: literal('0') }] }],
            },
          ],
        },
      },
      { duration: 100 },
    )
    let session: LifecycleSession | undefined

    try {
      const continuing = existing ? fixture.start('leave') : undefined
      const previous = continuing ? effect(fixture.element, 'opacity') : undefined

      if (previous) {
        await previous.ready

        previous.pause()
        previous.currentTime = 25
        fixture.instance.replaceDefinition({ ...fixture.instance.definition, name: 'replacement' })
      }

      const work = fixture.instance.captureLifecycle('leave', ['box'], fixture.element)
      fixture.instance.updateParameters({ duration: -1 })

      if (disposed) fixture.instance.dispose()

      session = new LifecycleSession(work, 'leave', (error) => fixture.failures.push(error))
      let initializationError: unknown

      if (explicit) {
        try {
          session.initialize()
        } catch (error) {
          initializationError = error
        }
      }

      session.play()
      const result = await session.finished
      session.cancel('owner-teardown')
      session.play()
      session.initialize()
      fixture.instance.dispose()
      const continued =
        previous === undefined ||
        (fixture.element.getAnimations().includes(previous) && listeners.size === 1)

      if (previous) previous.finish()

      const continuingResult = continuing ? await continuing.finished : 'completed'
      const reported = fixture.failures[0]

      return {
        result,
        stillFailed: await session.finished,
        reports: fixture.failures.length,
        causePreserved: !explicit || initializationError === reported,
        explicitThrew: initializationError instanceof Error,
        message: reported instanceof Error ? reported.message : '',
        remainingListeners: listeners.size,
        remainingEffects: fixture.element.getAnimations().length,
        diagnostics: fixture.diagnostics.length,
        continued,
        continuingResult,
      }
    } finally {
      session?.cancel('owner-teardown')
      fixture.cleanup()
      MediaQueryList.prototype.addEventListener = nativeAdd
      MediaQueryList.prototype.removeEventListener = nativeRemove
    }
  },
  async retiredOwnership(concurrent: boolean, complete: boolean) {
    const first = document.createElement('div')
    const second = document.createElement('div')
    first.style.opacity = '0.3'
    second.style.opacity = '0.4'
    document.body.append(first, second)
    const diagnostics: RuntimeDiagnostic[] = []
    const instance = new LivaInstance(
      {
        name: 'retired-receivers',
        layers: [
          {
            name: 'base',
            targets: [
              { name: 'first', properties: [{ name: 'opacity', value: literal('1') }] },
              { name: 'second', properties: [{ name: 'opacity', value: literal('0.8') }] },
            ],
          },
        ],
        leave: {
          timing: { ...tween, durationMs: 1000 },
          targets: ['first', 'second'].map((name) => ({
            name,
            properties: [{ name: 'opacity', keyframes: [{ offset: 1, value: literal('0') }] }],
          })),
        },
      },
      {},
      (diagnostic) => diagnostics.push(diagnostic),
    )
    instance.bind([
      ['first', first],
      ['second', second],
    ])
    const firstWork = instance.captureLifecycle('leave', ['first'], first)
    const secondWork = instance.captureLifecycle('leave', ['second'], second)
    const sessions: LifecycleSession[] = []

    const start = (work: typeof firstWork) => {
      const session = new LifecycleSession(work, 'leave')
      sessions.push(session)
      session.initialize()
      instance.retainLifecycle('leave', session)
      session.play()

      for (const item of work) {
        const animation = effect(item.element, item.track.property)
        animation.pause()
        animation.currentTime = 0
      }

      return session
    }
    const end = async (session: LifecycleSession, element: HTMLElement) => {
      if (complete) effect(element, 'opacity').finish()
      else session.cancel('owner-teardown')

      return session.finished
    }

    try {
      const firstSession = start(firstWork)
      const secondSession = concurrent ? start(secondWork) : undefined
      instance.dispose()
      await end(firstSession, first)
      const firstRestored = first.style.opacity
      const external = concurrent ? first : second
      external.style.opacity = '0.8'

      if (secondSession) await end(secondSession, second)

      const replay = start(concurrent ? firstWork : secondWork)
      const result = await end(replay, external)

      return {
        firstRestored,
        external: external.style.opacity,
        other: (concurrent ? second : first).style.opacity,
        result,
        remaining: first.getAnimations().length + second.getAnimations().length,
        diagnostics: diagnostics.length,
      }
    } finally {
      for (const session of sessions) session.cancel('owner-teardown')

      instance.dispose()
      first.remove()
      second.remove()
    }
  },

  async retiredProperty(complete: boolean) {
    const element = document.createElement('div')
    element.style.cssText = 'opacity:0.3;scale:0.4;'
    document.body.append(element)
    const instance = new LivaInstance({
      name: 'retired-properties',
      layers: [
        {
          name: 'base',
          targets: [
            {
              name: 'box',
              properties: [
                { name: 'opacity', value: literal('1') },
                { name: 'scale', value: literal('1') },
              ],
            },
          ],
        },
      ],
      leave: {
        timing: { ...tween, durationMs: 1000 },
        targets: [
          {
            name: 'box',
            properties: ['opacity', 'scale'].map((name) => ({
              name,
              keyframes: [{ offset: 1, value: literal('0') }],
            })),
          },
        ],
      },
    })
    instance.bind([['box', element]])
    const work = instance.captureLifecycle('leave', ['box'], element)
    const sessions = ['opacity', 'scale'].map((property) => {
      const session = new LifecycleSession(
        work.filter((item) => item.track.property === property),
        'leave',
      )
      session.initialize()
      instance.retainLifecycle('leave', session)
      session.play()
      const animation = effect(element, property)
      animation.pause()
      animation.currentTime = 0

      return session
    })
    const end = async (session: LifecycleSession, property: string) => {
      if (complete) effect(element, property).finish()
      else session.cancel('owner-teardown')

      return session.finished
    }

    try {
      instance.dispose()
      await end(sessions[0], 'opacity')
      const restored = element.style.opacity
      // Match the old operation's last inline value: its ended ownership must
      // not make this later external write appear to remain runtime-owned.
      element.style.opacity = '0'
      const result = await end(sessions[1], 'scale')

      return {
        restored,
        opacity: element.style.opacity,
        scale: element.style.scale,
        result,
        remaining: element.getAnimations().length,
      }
    } finally {
      for (const session of sessions) session.cancel('owner-teardown')

      instance.dispose()
      element.remove()
    }
  },
  async releasedAfterDisposal(
    axis: 'x' | 'y',
    mode: 'fresh' | 'near-expiry' | 'boundary' | 'stationary',
  ) {
    let time = 1000
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Restored on its native receiver in finally.
    const nativeNow = performance.now
    Object.defineProperty(performance, 'now', { configurable: true, value: () => time })
    const component = axis === 'x' ? 0 : 1
    const destination = mode === 'stationary' ? -100 : 100
    const fixture = setup(
      {
        name: 'released-after-disposal',
        parameters: [
          { name: 'input', type: 'number' },
          { name: 'sensitivity', type: 'number' },
        ],
        letBindings: [
          {
            name: 'movement',
            initializer: {
              kind: 'call',
              function: 'link',
              arguments: [
                { name: 'input', value: reference('input') },
                { name: 'sensitivity', value: reference('sensitivity') },
                { name: 'component', value: { kind: 'string', value: axis } },
              ],
            },
          },
        ],
        layers: [
          {
            name: 'base',
            targets: [
              {
                name: 'box',
                properties: [
                  {
                    name: 'translate',
                    value: { kind: 'binding', expression: reference('movement') },
                  },
                ],
              },
            ],
          },
        ],
        leave: {
          timing: physics,
          targets: [
            {
              name: 'box',
              properties: [
                {
                  name: 'translate',
                  keyframes: [
                    {
                      offset: 1,
                      value: literal(
                        axis === 'x' ? `${destination}px 0px` : `0px ${destination}px`,
                      ),
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
      { input: 0, sensitivity: 1 },
    )
    let session: LifecycleSession | undefined

    const positionAt = (animation: Animation, milliseconds: number) => {
      animation.pause()
      animation.currentTime = milliseconds
      const decoded = decodeProperty(fixture.element, 'translate')

      if (!decoded) throw new Error('Expected readable translate')

      return { selected: decoded.values[component], other: decoded.values[component === 0 ? 1 : 0] }
    }

    try {
      time = 1010
      fixture.instance.updateParameters({ input: 10, sensitivity: 1 })
      time = 1070
      const work = fixture.instance.captureLifecycle('leave', ['box'], fixture.element)
      time = 1075
      fixture.instance.updateParameters(
        mode === 'stationary' ? { input: 10, sensitivity: 0 } : { input: -30, sensitivity: 1 },
      )
      time = 1080
      fixture.instance.dispose()
      time = mode === 'near-expiry' ? 1154 : mode === 'boundary' ? 1155 : 1081
      session = new LifecycleSession(work, 'leave', (error) => fixture.failures.push(error))
      session.initialize()
      session.play()
      const animation = effect(fixture.element, 'translate')
      await animation.ready

      const start = positionAt(animation, 0)
      const next = positionAt(animation, 1)
      animation.finish()
      const result = await session.finished

      return {
        start: start.selected,
        direction: Math.sign(next.selected - start.selected),
        other: next.other,
        result,
        errors: fixture.diagnostics.length + fixture.failures.length,
      }
    } finally {
      session?.cancel('owner-teardown')
      fixture.cleanup()
      Object.defineProperty(performance, 'now', { configurable: true, value: nativeNow })
    }
  },
  async candidateApplicability(mode: 'takeover' | 'remaining' | 'mixed') {
    const mixed = mode === 'mixed'
    const duration = reference('duration')
    const fixture = setup(
      {
        name: 'candidate-applicability',
        parameters: [
          { name: 'duration', type: 'number' },
          { name: 'takeover', type: 'boolean' },
          { name: 'replaceScale', type: 'boolean' },
        ],
        layers: [
          {
            name: 'base',
            targets: [
              {
                name: 'box',
                properties: [
                  { name: 'opacity', value: literal('1') },
                  ...(mixed ? [{ name: 'scale', value: literal('1') }] : []),
                ],
              },
            ],
          },
          {
            name: 'takeover',
            when: reference('takeover'),
            targets: [
              {
                name: 'box',
                properties: [
                  { name: 'opacity', value: literal('0.9'), timing: { ...tween, durationMs: 80 } },
                ],
              },
            ],
          },
          {
            name: 'scaleTakeover',
            when: reference('replaceScale'),
            targets: [
              {
                name: 'box',
                properties: [
                  { name: 'scale', value: literal('1.5'), timing: { ...tween, durationMs: 80 } },
                ],
              },
            ],
          },
          {
            name: 'history',
            initialState: 'idle',
            targets: [],
            states: ['idle', 'next', 'final'].map((name) => ({ name, targets: [] })),
            transitions: [
              {
                from: 'idle',
                to: 'next',
                when: reference('takeover'),
                transition: { targets: [] },
              },
              {
                from: 'next',
                to: 'final',
                when: { kind: 'boolean', value: true },
                transition: { targets: [] },
              },
            ],
          },
        ],
        enter: {
          timingExpression: {
            kind: 'call',
            function: 'tween',
            arguments: [
              { name: 'duration', value: duration },
              { name: 'easing', value: reference('linear') },
            ],
          },
          targets: [
            {
              name: 'box',
              properties: [
                { name: 'opacity', keyframes: [{ offset: 0, value: literal('0') }] },
                ...(mixed
                  ? [{ name: 'scale', keyframes: [{ offset: 0, value: literal('0.5') }] }]
                  : []),
              ],
            },
          ],
        },
      },
      { duration: 400, takeover: false, replaceScale: false },
    )

    try {
      const session = fixture.start('enter')
      const originals = fixture.element.getAnimations()
      await Promise.all(originals.map((animation) => animation.ready))

      for (const animation of originals) {
        animation.pause()
        animation.currentTime = 100
      }

      let updates = 0
      fixture.instance.onUpdate = () => {
        updates++
      }
      fixture.instance.updateParameters({
        duration: -1,
        takeover: mode !== 'remaining',
        replaceScale: false,
      })
      const firstAccepted = updates === 1
      const rejectedHistory = fixture.instance.composition.states.history
      let retryRetained = true

      if (mode !== 'takeover') {
        fixture.instance.updateParameters({ duration: 400, takeover: false, replaceScale: false })
        retryRetained = originals.every((animation) =>
          fixture.element.getAnimations().includes(animation),
        )
      }

      if (mixed)
        fixture.instance.updateParameters({ duration: -1, takeover: true, replaceScale: true })

      const current = fixture.element.getAnimations()
      const durations = current.map((animation) => animation.effect?.getTiming().duration)
      const history = fixture.instance.composition.states.history

      for (const animation of current) animation.finish()

      const result = await session.finished

      return {
        firstAccepted,
        rejectedHistory,
        retryRetained,
        durations,
        history,
        result,
        diagnostics: fixture.diagnostics.length,
        failures: fixture.failures.length,
        final: fixture.element.style.opacity,
      }
    } finally {
      fixture.cleanup()
    }
  },

  async canonicalTakeover(mode: 'physical' | 'logical' | 'repeated') {
    const property = mode === 'physical' ? 'left' : 'inset-inline-start'
    const fixture = setup(
      {
        name: 'canonical-takeover',
        parameters: [{ name: 'active', type: 'boolean' }],
        layers: [
          base('inset', '0px'),
          {
            name: 'takeover',
            when: reference('active'),
            targets: [
              {
                name: 'box',
                properties: [
                  { name: property, value: literal('200px'), timing: { ...tween, durationMs: 80 } },
                ],
              },
            ],
          },
        ],
        enter: {
          timing: tween,
          targets: [
            {
              name: 'box',
              properties: [{ name: 'inset', keyframes: [{ offset: 0, value: literal('100px') }] }],
            },
          ],
        },
      },
      { active: false },
    )
    const other = document.createElement('div')
    other.style.cssText = 'position:relative;width:40px;height:40px;writing-mode:vertical-rl;'
    const elements = mode === 'repeated' ? [fixture.element, other] : [fixture.element]
    const properties = ['top', 'right', 'bottom', 'left']
    let session: LifecycleSession | undefined

    if (mode === 'repeated') {
      document.body.append(other)
      fixture.instance.bind(elements.map((element) => ['box', element] as const))
    }

    try {
      const work = elements.flatMap((element) =>
        fixture.instance.captureLifecycle('enter', ['box'], element),
      )
      session = new LifecycleSession(work, 'enter', (error) => fixture.failures.push(error))
      session.initialize()
      fixture.instance.retainLifecycle('enter', session)
      session.play()
      const originals = elements.map((element) => properties.map((name) => effect(element, name)))
      await Promise.all(originals.flat().map((animation) => animation.ready))

      for (const animation of originals.flat()) {
        animation.pause()
        animation.currentTime = 100
      }

      const affected = elements.map((_element, index) =>
        mode === 'repeated' && index === 1 ? 'top' : 'left',
      )
      const oldRejections = Promise.all(
        originals.map((animations, index) =>
          animations[properties.indexOf(affected[index])].finished.catch(() => undefined),
        ),
      )
      let completed = false
      void session.finished.then(() => {
        completed = true
        return undefined
      })
      fixture.instance.updateParameters({ active: true })
      const replacement = elements.map((element, index) => effect(element, affected[index]))

      for (const animation of replacement) {
        animation.pause()
        animation.currentTime = 0
      }

      await oldRejections
      const start = elements.map((element, index) =>
        getComputedStyle(element).getPropertyValue(affected[index]),
      )
      const ends = replacement.map(
        (animation, index) => frames(animation).at(-1)?.[affected[index]],
      )
      const durations = replacement.map((animation) => animation.effect?.getTiming().duration)
      const preserved = elements.every((element, index) =>
        properties.every(
          (name, component) =>
            name === affected[index] || effect(element, name) === originals[index][component],
        ),
      )

      for (const animation of replacement) animation.finish()

      await Promise.all(replacement.map((animation) => animation.finished))
      const premature = completed

      for (const animations of originals)
        for (const animation of animations) if (animation.playState !== 'idle') animation.finish()

      const result = await session.finished

      return {
        start,
        ends,
        durations,
        preserved,
        premature,
        result,
        final: elements.map((element, index) =>
          getComputedStyle(element).getPropertyValue(affected[index]),
        ),
        remaining: elements.reduce((count, element) => count + element.getAnimations().length, 0),
        diagnostics: fixture.diagnostics.length + fixture.failures.length,
      }
    } finally {
      session?.cancel('owner-teardown')
      fixture.cleanup()
      other.remove()
    }
  },

  async unchangedCanonicalObservation() {
    const fixture = setup(
      {
        name: 'unchanged-canonical',
        parameters: [{ name: 'unused', type: 'number' }],
        layers: [
          base('inset', '0px'),
          {
            name: 'unrelated',
            targets: [
              {
                name: 'other',
                properties: [
                  { name: 'opacity', value: { kind: 'template', parts: [reference('unused')] } },
                ],
              },
            ],
          },
        ],
        enter: {
          timing: tween,
          targets: [
            {
              name: 'box',
              properties: [{ name: 'inset', keyframes: [{ offset: 0, value: literal('100px') }] }],
            },
          ],
        },
      },
      { unused: 0 },
    )
    const original = globalThis.getComputedStyle
    let reads = 0

    try {
      const session = fixture.start('enter')
      const animations = fixture.element.getAnimations()
      await Promise.all(animations.map((animation) => animation.ready))

      for (const animation of animations) animation.pause()

      globalThis.getComputedStyle = (...args) => {
        reads++

        return original(...args)
      }

      for (let unused = 1; unused <= 3; unused++) fixture.instance.updateParameters({ unused })

      globalThis.getComputedStyle = original
      const preserved = animations.every((animation) =>
        fixture.element.getAnimations().includes(animation),
      )

      for (const animation of animations) animation.finish()

      return { reads, preserved, result: await session.finished }
    } finally {
      globalThis.getComputedStyle = original
      fixture.cleanup()
    }
  },

  async canonicalReference() {
    const parent = document.createElement('div')
    parent.style.cssText = 'position:relative;width:200px;height:100px;'
    document.body.append(parent)
    const fixture = setup({
      name: 'canonical-reference',
      layers: [base('inset', '0px')],
      leave: {
        timing: physics,
        targets: [
          {
            name: 'box',
            properties: [{ name: 'inset', keyframes: [{ offset: 1, value: literal('10%') }] }],
          },
        ],
      },
    })
    fixture.element.style.position = 'absolute'
    parent.append(fixture.element)

    try {
      const session = fixture.start('leave')
      const first = effect(fixture.element, 'left')
      await first.ready

      parent.style.width = '400px'
      await paint()
      const replacement = effect(fixture.element, 'left')
      const changed = replacement !== first
      const left = frames(replacement).at(-1)?.left
      const top = frames(effect(fixture.element, 'top')).at(-1)?.top

      for (const animation of fixture.element.getAnimations()) animation.finish()

      return {
        changed,
        left,
        top,
        result: await session.finished,
        diagnostics: fixture.diagnostics.length + fixture.failures.length,
      }
    } finally {
      fixture.cleanup()
      parent.remove()
    }
  },
}
