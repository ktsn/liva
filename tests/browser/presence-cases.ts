import {
  LivaInstance,
  LifecycleSession,
  waapiProperty,
  type Definition,
  type Expression,
  type RuntimeDiagnostic,
  type Timing,
} from '../../packages/runtime/src/index.ts'

import { PropertyMotion } from '../../packages/runtime/src/motion/property-motion.ts'

const literal = (value: string) => ({ kind: 'literal' as const, value })
const reference = (...path: string[]): Expression => ({ kind: 'reference', path })
const tween: Timing = { kind: 'tween', durationMs: 400, easing: 'linear' }
const physics: Timing = { kind: 'spring-physics', stiffness: 300, damping: 25, mass: 1 }

function setup(definition: Definition, inputs: Record<string, unknown> = {}) {
  const element = document.createElement('div')
  element.style.cssText = 'position:relative;width:40px;height:40px;translate:0px 0px;'
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
  async controllerOwnership() {
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
                  { name: 'width', value: { kind: 'binding', expression: reference('movement') } },
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
                { name: 'inline-size', keyframes: [{ offset: 1, value: literal('100px') }] },
              ],
            },
          ],
        },
      },
      { input: 0 },
    )

    const other = document.createElement('div')
    other.style.width = '40px'
    document.body.append(other)
    fixture.instance.bind([
      ['box', fixture.element],
      ['box', other],
    ])

    try {
      fixture.instance.updateParameters({ input: 10 })
      const session = fixture.start('leave')
      const animation = effect(fixture.element, 'width')
      await animation.ready
      animation.pause()
      animation.currentTime = 100
      const held = getComputedStyle(fixture.element).width
      const otherHeld = getComputedStyle(other).width
      fixture.instance.updateParameters({ input: 40 })
      const retained = effect(fixture.element, 'width') === animation
      const unchanged = getComputedStyle(fixture.element).width === held
      const otherStable = getComputedStyle(other).width === otherHeld
      session.cancel('superseded')
      const released = parseFloat(getComputedStyle(other).width)
      fixture.instance.updateParameters({ input: 50 })
      const resumed = parseFloat(getComputedStyle(other).width)

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
}
