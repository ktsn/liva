import { createBrowserRuntimeHarness } from '../__test__/helpers/browser-runtime.ts'
import * as functions from '../builtins/index.ts'
import { cdp } from 'vite-plus/test/browser'
import type { CDPSession } from '@vitest/browser-playwright'
import fixture from '../../../../fixtures/toggle.json'
import { decodeBundle, type Definition as PropertyIRDefinition } from '../model/definition.ts'

import {
  assembleRuntime,
  nativeEffects,
  type RuntimeAssembly,
} from '../__test__/helpers/assembly.ts'
import { capturePresence } from '../__test__/helpers/presence.ts'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { PresenceOperation, createPresenceCapture } from './presence-operation.ts'
import { evaluate } from '../evaluation/expression.ts'
import { PropertyMotion } from '../motion/property-motion.ts'
import { timingValue } from '../evaluation/timing-values.ts'
import { Runtime } from './runtime.ts'
import { PresentationExecutor } from './presentation-executor.ts'
import type { Definition, Timing, Frame } from '../model/definition.ts'

vi.mock('../builtins/index.ts', { spy: true })

const elements: HTMLElement[] = []
const sessions: PresenceOperation[] = []
const instances: RuntimeAssembly[] = []

function setup(
  phase: 'enter' | 'leave',
  timing: Timing = { kind: 'tween', durationMs: 30, easing: 'linear' },
  options: {
    property?: string
    start?: string
    end?: string
    baseline?: string
    style?: string
    frames?: readonly Frame[]
  } = {},
) {
  const element = document.createElement('div')
  const property = options.property ?? 'opacity'
  const baseline = options.baseline ?? (phase === 'enter' ? '1' : '0.7')

  element.style.cssText = options.style ?? 'opacity:0.7'
  document.body.append(element)
  elements.push(element)

  const definition: Definition = {
    name: 'captured-effects',
    layers: [
      {
        name: 'base',
        targets: [
          {
            name: 'box',
            properties: [{ name: property, value: { kind: 'literal', value: baseline } }],
          },
        ],
      },
    ],
    [phase]: {
      timing,
      targets: [
        {
          name: 'box',
          properties: [
            {
              name: property,
              keyframes: options.frames ?? [
                { offset: 0, value: { kind: 'literal', value: options.start ?? '0' } },
                { offset: 1, value: { kind: 'literal', value: options.end ?? '1' } },
              ],
            },
          ],
        },
      ],
    },
  }
  const instance = assembleRuntime(definition)

  instances.push(instance)
  instance.executor.bind([['box', element]])

  const captures = capturePresence(instance, phase, ['box'])
  const errors: unknown[] = []
  const session = new PresenceOperation(captures, phase, (error) => errors.push(error))

  sessions.push(session)

  return { element, instance, session, errors }
}

afterEach(() => {
  for (const session of sessions.splice(0)) session.cancel('owner-teardown')

  for (const instance of instances.splice(0)) instance.runtime.dispose()

  for (const element of elements.splice(0)) element.remove()
})

describe('lifecycle effects', () => {
  it.each(['completed', 'cancelled'] as const)(
    'releases disposed retain registrations when empty leave work is %s',
    async (ending) => {
      const media = matchMedia('(prefers-reduced-motion: reduce)')
      const factory = vi.spyOn(window, 'matchMedia').mockReturnValue(media)
      const added = vi.spyOn(media, 'addEventListener')
      const removed = vi.spyOn(media, 'removeEventListener')
      const instance = assembleRuntime({ name: 'empty', layers: [] })
      const session = new PresenceOperation(capturePresence(instance, 'leave', []), 'leave')

      sessions.push(session)
      session.initialize()

      try {
        if (ending === 'completed') session.play()

        instance.runtime.dispose()

        expect(removed).not.toHaveBeenCalled()

        if (ending === 'cancelled') session.cancel('owner-teardown')

        expect(await session.finished).toBe(ending === 'completed' ? 'completed' : 'owner-teardown')

        for (const registration of added.mock.calls)
          expect(removed).toHaveBeenCalledWith(...registration)
      } finally {
        session.cancel('owner-teardown')
        instance.runtime.dispose()
        added.mockRestore()
        removed.mockRestore()
        factory.mockRestore()
      }
    },
  )

  it('releases a disposed empty participant when a sibling leave completes', async () => {
    const media = matchMedia('(prefers-reduced-motion: reduce)')
    const factory = vi.spyOn(window, 'matchMedia').mockReturnValue(media)
    const added = vi.spyOn(media, 'addEventListener')
    const removed = vi.spyOn(media, 'removeEventListener')
    const instance = assembleRuntime({ name: 'external', layers: [] })
    const owner = setup('leave', { kind: 'tween', durationMs: 1000, easing: 'linear' })
    const { element, errors } = owner
    const session = new PresenceOperation(
      [
        ...capturePresence(instance, 'leave', []),
        ...capturePresence(owner.instance, 'leave', ['box']),
      ],
      'leave',
      (error) => errors.push(error),
    )

    sessions.push(session)
    session.initialize()

    try {
      session.play()
      instance.runtime.dispose()

      expect(removed).not.toHaveBeenCalled()
      expect(session.isFinished).toBe(false)

      element.getAnimations()[0].finish()

      expect(await session.finished).toBe('completed')

      owner.instance.runtime.dispose()

      for (const registration of added.mock.calls)
        expect(removed).toHaveBeenCalledWith(...registration)

      expect(element.style.opacity).toBe('0.7')
      expect(errors).toEqual([])
    } finally {
      session.cancel('owner-teardown')
      instance.runtime.dispose()
      added.mockRestore()
      removed.mockRestore()
      factory.mockRestore()
    }
  })

  it.each(['enter', 'leave'] as const)(
    'Instant %s completes without leaving effects or ownership',
    async (phase) => {
      const timing = timingValue(evaluate({ kind: 'reference', path: ['instant'] }, {}))
      const { element, session } = setup(phase, timing)

      session.initialize()
      session.play()

      expect(await session.finished).toBe('completed')
      expect(element.getAnimations()).toEqual([])
      expect(element.style.opacity).toBe(phase === 'enter' ? '1' : '0.7')
    },
  )

  it.each(['enter', 'leave'] as const)('completes %s and releases effects', async (phase) => {
    const { element, session } = setup(phase)

    session.initialize()
    session.initialize()

    expect(element.style.opacity).toBe('0')

    session.play()
    session.play()

    expect(await session.finished).toBe('completed')
    expect(element.style.opacity).toBe(phase === 'enter' ? '1' : '0.7')
    expect(element.getAnimations()).toEqual([])

    session.initialize()
    session.play()
  })

  it.each(['superseded', 'owner-teardown'] as const)('restores styles when %s', async (reason) => {
    const { element, session, instance } = setup('enter')

    session.initialize()
    session.play()
    session.cancel(reason)

    expect(await session.finished).toBe(reason)
    expect(element.style.opacity).toBe('1')
    expect(element.getAnimations()).toEqual([])

    instance.runtime.dispose()

    expect(element.style.opacity).toBe('0.7')
  })

  it('reports cancelled browser effects as failed', async () => {
    const { element, session } = setup('leave')

    session.initialize()
    session.play()
    element.getAnimations()[0].cancel()

    expect(await session.finished).toBe('failed')
    expect(element.style.opacity).toBe('0.7')
  })

  it('settles zero-duration work and rejects invalid animation timing', async () => {
    const zero = setup('enter', { kind: 'tween', durationMs: 0, easing: 'linear' })

    zero.session.initialize()
    zero.session.play()

    expect(await zero.session.finished).toBe('completed')
    expect(zero.element.style.opacity).toBe('1')

    const invalid = setup('enter', { kind: 'tween', durationMs: -1, easing: 'linear' })

    invalid.session.initialize()
    invalid.session.play()

    expect(await invalid.session.finished).toBe('failed')
    expect(invalid.element.style.opacity).toBe('1')
    expect(invalid.errors[0]).toBeInstanceOf(Error)
  })

  it.each(['initialize', 'play'] as const)(
    'preserves the original error and releases failed %s initialization',
    async (operation) => {
      const { element, session, errors } = setup('enter')
      const failure = new Error('initial style write failed')
      const write = vi.spyOn(element.style, 'setProperty').mockImplementationOnce(() => {
        throw failure
      })

      try {
        let thrown: unknown

        try {
          session[operation]()
        } catch (error) {
          thrown = error
        }

        expect(thrown).toBe(operation === 'initialize' ? failure : undefined)
        expect(await session.finished).toBe('failed')
        expect(errors).toEqual([failure])
        expect(element.getAnimations()).toEqual([])
      } finally {
        write.mockRestore()
      }
    },
  )

  it.each([
    { operation: 'initialize', index: 0 },
    { operation: 'initialize', index: 1 },
    { operation: 'play', index: 0 },
    { operation: 'play', index: 1 },
  ] as const)(
    'cleans every owner after participant $index fails during $operation',
    async ({ operation, index }) => {
      const definition: Definition = {
        name: 'grouped-failure',
        layers: [
          {
            name: 'base',
            targets: [
              {
                name: 'box',
                properties: [{ name: 'opacity', value: { kind: 'literal', value: '1' } }],
              },
            ],
          },
        ],
        enter: {
          timing: { kind: 'tween', durationMs: 1000, easing: 'linear' },
          targets: [
            {
              name: 'box',
              properties: [
                {
                  name: 'opacity',
                  keyframes: [{ offset: 0, value: { kind: 'literal', value: '0' } }],
                },
              ],
            },
          ],
        },
      }
      const owners = Array.from({ length: 2 }, () => {
        const element = document.createElement('div')

        document.body.append(element)
        elements.push(element)

        const instance = assembleRuntime(definition)

        instance.executor.bind([['box', element]])

        return { instance, element }
      })
      const failures: unknown[] = []
      const session = new PresenceOperation(
        owners.flatMap(({ instance }) => capturePresence(instance, 'enter', ['box'])),
        'enter',
        (error) => failures.push(error),
      )

      sessions.push(session)

      const failure = new Error('participant preparation failed')
      const OriginalAnimation = window.Animation
      let restore: () => void

      if (operation === 'initialize') {
        const write = vi
          .spyOn(owners[index].element.style, 'setProperty')
          .mockImplementationOnce(() => {
            throw failure
          })

        restore = () => write.mockRestore()
      } else {
        session.initialize()

        const create = vi.spyOn(window, 'Animation')

        if (index === 1)
          create.mockImplementationOnce(function (effect, timeline) {
            return new OriginalAnimation(effect, timeline)
          })

        create.mockImplementationOnce(function () {
          throw failure
        })
        restore = () => create.mockRestore()
      }

      try {
        let thrown: unknown

        try {
          session[operation]()
        } catch (error) {
          thrown = error
        }

        expect(thrown).toBe(operation === 'initialize' ? failure : undefined)
        expect(await session.finished).toBe('failed')
        expect(failures).toEqual([failure])

        for (const { element, instance } of owners) {
          expect(element.style.opacity).toBe('1')
          expect(element.getAnimations()).toEqual([])
          expect(nativeEffects(instance.executor)).toEqual([])
        }
      } finally {
        restore()

        for (const { instance } of owners) instance.runtime.dispose()
      }
    },
  )

  it('keeps multiple targets of one capture in the boundary until every effect completes', async () => {
    const cases = [
      { name: 'box', baseline: '1', start: '0' },
      { name: 'badge', baseline: '0.8', start: '0.2' },
    ]
    const source: Definition = {
      name: 'multiple-receivers',
      layers: [
        {
          name: 'base',
          targets: cases.map(({ name, baseline }) => ({
            name,
            properties: [{ name: 'opacity', value: { kind: 'literal', value: baseline } }],
          })),
        },
      ],
      enter: {
        timing: { kind: 'tween', durationMs: 1000, easing: 'linear' },
        targets: cases.map(({ name, start }) => ({
          name,
          properties: [
            {
              name: 'opacity',
              keyframes: [{ offset: 0, value: { kind: 'literal', value: start } }],
            },
          ],
        })),
      },
    }
    const receivers = cases.map(() => document.createElement('div'))

    for (const element of receivers) {
      document.body.append(element)
      elements.push(element)
    }

    const instance = assembleRuntime(source)
    instances.push(instance)
    instance.executor.bind(cases.map(({ name }, index) => [name, receivers[index]] as const))
    const operation = new PresenceOperation(
      capturePresence(
        instance,
        'enter',
        cases.map(({ name }) => name),
      ),
      'enter',
    )
    sessions.push(operation)

    operation.play()

    const effects = receivers.map((element) => element.getAnimations()[0])
    effects[0].finish()

    await Promise.resolve()
    await Promise.resolve()

    expect(operation.isFinished).toBe(false)

    effects[1].finish()

    expect(await operation.finished).toBe('completed')
    expect(receivers.map((element) => element.style.opacity)).toEqual(
      cases.map(({ baseline }) => baseline),
    )
  })

  it('stops initialization writes when ownership refresh tears down the operation', async () => {
    const source: Definition = {
      name: 'startup-cancellation',
      layers: [
        {
          name: 'base',
          targets: [
            {
              name: 'box',
              properties: [{ name: 'opacity', value: { kind: 'literal', value: '1' } }],
            },
          ],
        },
      ],
      enter: {
        timing: { kind: 'tween', durationMs: 1000, easing: 'linear' },
        targets: [
          {
            name: 'box',
            properties: [
              {
                name: 'opacity',
                keyframes: [{ offset: 0, value: { kind: 'literal', value: '0' } }],
              },
            ],
          },
        ],
      },
    }
    const element = document.createElement('div')
    document.body.append(element)
    elements.push(element)
    const executor = new PresentationExecutor(() => {})
    const runtime = new Runtime(executor, source, {}, () => {})
    executor.attach(runtime.environment)
    executor.bind([['box', element]])
    const operation = new PresenceOperation([executor.capturePresence('enter', ['box'])], 'enter')
    const refresh = vi
      .spyOn(runtime.environment, 'refreshOwnership')
      .mockImplementationOnce(() => operation.cancel('owner-teardown'))

    try {
      operation.initialize()
      operation.play()

      expect(await operation.finished).toBe('owner-teardown')
      expect(element.style.opacity).toBe('1')
      expect(element.getAnimations()).toEqual([])
    } finally {
      refresh.mockRestore()
      runtime.dispose()
    }
  })

  it('uses the captured definition final accepted baseline after replacement', async () => {
    const source: Definition = {
      name: 'retained-baseline',
      parameters: [{ name: 'amount', type: 'number' }],
      layers: [
        {
          name: 'base',
          targets: [
            {
              name: 'box',
              properties: [
                {
                  name: 'opacity',
                  value: { kind: 'template', parts: [{ kind: 'reference', path: ['amount'] }] },
                },
              ],
            },
          ],
        },
      ],
      leave: {
        timing: { kind: 'tween', durationMs: 1000, easing: 'linear' },
        targets: [{ name: 'box', properties: [{ name: 'opacity' }] }],
      },
    }
    const instance = assembleRuntime(source, { amount: 0.5 })
    const element = document.createElement('div')
    document.body.append(element)
    elements.push(element)
    instances.push(instance)
    instance.executor.bind([['box', element]])
    const captures = capturePresence(instance, 'leave', ['box'])

    instance.runtime.updateParameters({ amount: 0.8 })
    instance.runtime.replaceDefinition({
      ...source,
      layers: [
        {
          name: 'base',
          targets: [
            {
              name: 'box',
              properties: [{ name: 'opacity', value: { kind: 'literal', value: '0.2' } }],
            },
          ],
        },
      ],
    })
    const operation = new PresenceOperation(captures, 'leave')
    sessions.push(operation)
    operation.play()
    const effect = element.getAnimations()[0].effect

    if (!(effect instanceof KeyframeEffect)) throw new Error('Expected retained leave effect')

    expect(effect.getKeyframes().at(-1)?.opacity).toBe('0.8')

    operation.cancel('owner-teardown')

    expect(await operation.finished).toBe('owner-teardown')
    expect(element.style.opacity).toBe('0.2')
  })

  it('reports restoration failures while releasing effects and the boundary result', async () => {
    const { element, session, errors } = setup('leave')

    session.initialize()
    session.play()

    const failure = new Error('restoration failed')
    const write = vi.spyOn(element.style, 'cssText', 'set').mockImplementationOnce(() => {
      throw failure
    })

    try {
      session.cancel('owner-teardown')

      expect(await session.finished).toBe('owner-teardown')
      expect(element.getAnimations()).toEqual([])
      expect(errors).toEqual([failure])
    } finally {
      write.mockRestore()
    }
  })

  it('stops participant startup if initialization cancels the operation', async () => {
    let played = false
    const capture = createPresenceCapture(
      {
        release() {},
        initialize(owner) {
          owner.cancel('owner-teardown')
        },
        play() {
          played = true
        },
        end() {},
      },
      'enter',
    )
    const session = new PresenceOperation([capture], 'enter')

    sessions.push(session)

    session.play()

    expect(await session.finished).toBe('owner-teardown')
    expect(played).toBe(false)
  })

  it('keeps authored endpoints distinct from the application completion value', async () => {
    const { session, element, errors } = setup(
      'enter',
      { kind: 'tween', durationMs: 30, easing: 'linear' },
      { end: '0.6' },
    )

    sessions.push(session)

    session.initialize()
    session.play()
    element.getAnimations()[0].finish()

    expect(await session.finished).toBe('completed')
    expect(element.style.opacity).toBe('1')
    expect(errors).toEqual([])
  })

  it('fails detached relative playback if reference retarget observation fails', async () => {
    const { session, element, errors, instance } = setup(
      'leave',
      {
        kind: 'spring-duration',
        durationMs: 1000,
        bounce: 0.1,
      },
      {
        property: 'translate',
        start: '0px',
        end: '100%',
        baseline: '0px',
        style: 'width:100px;translate:0px;',
      },
    )

    instance.runtime.dispose()
    session.initialize()
    session.play()

    const failure = new Error('motion observation failed')
    const observe = vi.spyOn(PropertyMotion.prototype, 'read').mockImplementationOnce(() => {
      throw failure
    })

    try {
      element.style.width = '200px'

      expect(await session.finished).toBe('failed')
      expect(element.getAnimations()).toEqual([])
      expect(errors).toEqual([failure])
    } finally {
      observe.mockRestore()
    }
  })

  it('settles detached leave on media changes without restarting on a non-reduced notification', async () => {
    const media = matchMedia('(prefers-reduced-motion: reduce)')
    const query = vi.spyOn(window, 'matchMedia').mockReturnValue(media)
    const { element, session, instance } = setup('leave', {
      kind: 'tween',
      durationMs: 1000,
      easing: 'linear',
    })

    instance.runtime.dispose()

    try {
      session.initialize()
      session.play()

      const animation = element.getAnimations()[0]

      media.dispatchEvent(new Event('change'))

      expect(element.getAnimations()).toContain(animation)

      const reduced = vi.spyOn(media, 'matches', 'get').mockReturnValue(true)

      try {
        media.dispatchEvent(new Event('change'))

        expect(await session.finished).toBe('completed')
        expect(element.getAnimations()).toEqual([])
      } finally {
        reduced.mockRestore()
      }
    } finally {
      query.mockRestore()
    }
  })

  it('plays spring timing', async () => {
    const { element, session } = setup('enter', {
      kind: 'spring-duration',
      durationMs: 20,
      bounce: 0.2,
    })

    session.initialize()
    session.play()

    expect(await session.finished).toBe('completed')
    expect(element.style.opacity).toBe('1')
  })

  it('completes empty capture selection without touching receiver presentation', async () => {
    const { element, instance } = setup('leave')
    const absent = new PresenceOperation(capturePresence(instance, 'leave', ['absent']), 'leave')

    absent.play()

    expect(await absent.finished).toBe('completed')
    expect(nativeEffects(instance.executor)).toEqual([])
    expect(element.style.opacity).toBe('0.7')
  })

  it.each([
    { mode: 'connected', connected: true, captured: '0.4' },
    { mode: 'detached', connected: false, captured: '0.7' },
  ])('captures $mode presentation before later CSS changes', async ({ connected, captured }) => {
    const { element, instance } = setup(
      'leave',
      { kind: 'tween', durationMs: 100, easing: 'linear' },
      {
        frames: [{ offset: 1, value: { kind: 'literal', value: '0' } }],
      },
    )
    const stylesheet = document.createElement('style')

    stylesheet.textContent = '.capture-observation { opacity: 0.4 !important }'
    document.head.append(stylesheet)
    elements.push(stylesheet)
    element.className = 'capture-observation'

    if (!connected) element.remove()

    const operation = new PresenceOperation(capturePresence(instance, 'leave', ['box']), 'leave')
    sessions.push(operation)

    // Connected CSS differs from inline CSS. Change both after capture to expose
    // any accidental sampling during initialization instead of using the capture.
    element.className = ''
    element.style.opacity = '0.1'
    operation.initialize()

    expect(element.style.opacity).toBe(captured)
    expect(nativeEffects(instance.executor)).toEqual([])

    operation.cancel('owner-teardown')

    expect(await operation.finished).toBe('owner-teardown')
    expect(element.style.opacity).toBe('0.7')
  })
})

function updateMode(assembly: RuntimeAssembly, mode: string, options: { paused?: boolean } = {}) {
  assembly.runtime.updateParameters({ mode })

  if (options.paused) {
    for (const animation of nativeEffects(assembly.executor)) animation.pause()
  }
}

function startRegisteredLifecycle(
  assembly: RuntimeAssembly,
  phase: 'enter' | 'leave',
  target: string,
) {
  const session = new PresenceOperation(capturePresence(assembly, phase, [target]), phase)
  session.initialize()
  session.initialize()
  session.play()

  return session
}

describe('lifecycle presentation coordination', () => {
  const definition = decodeBundle(JSON.stringify(fixture)).definitions[0]
  const harness = createBrowserRuntimeHarness()

  function setupBrowserRuntime(
    def = definition,
    inputs: Record<string, unknown> = def.parameters?.some((parameter) => parameter.name === 'mode')
      ? { mode: 'off' }
      : {},
  ) {
    return harness.setup(def, inputs)
  }

  afterEach(() => harness.dispose())

  const lifecyclePolicyDefinition: PropertyIRDefinition = {
    name: 'lifecycle-policy',
    parameters: [{ name: 'enabled', type: 'boolean' }],
    layers: [
      {
        name: 'base',
        targets: [
          {
            name: 'box',
            properties: [{ name: 'opacity', value: { kind: 'literal', value: '1' } }],
          },
          {
            name: 'exit',
            properties: [{ name: 'opacity', value: { kind: 'literal', value: '1' } }],
          },
        ],
      },
      {
        name: 'optional',
        when: { kind: 'reference', path: ['enabled'] },
        targets: [
          {
            name: 'box',
            properties: [{ name: 'width', value: { kind: 'literal', value: '50px' } }],
          },
        ],
      },
    ],
    enter: {
      timing: { kind: 'tween', durationMs: 10000, easing: 'linear' },
      targets: [
        {
          name: 'box',
          properties: [
            { name: 'opacity', keyframes: [{ offset: 0, value: { kind: 'literal', value: '0' } }] },
            { name: 'width', keyframes: [{ offset: 0, value: { kind: 'literal', value: '0px' } }] },
          ],
        },
      ],
    },
    leave: {
      timing: { kind: 'tween', durationMs: 10000, easing: 'linear' },
      targets: [
        {
          name: 'exit',
          properties: [
            { name: 'opacity', keyframes: [{ offset: 1, value: { kind: 'literal', value: '0' } }] },
          ],
        },
      ],
    },
  }

  it('keeps captured detached leave functional after logical call disposal fails', async () => {
    const failure = new Error('Call disposal failed')
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
      leave: {
        timing: { kind: 'tween' as const, durationMs: 1000, easing: 'linear' },
        targets: [
          {
            name: 'thumb',
            properties: [
              {
                name: 'opacity',
                keyframes: [
                  { offset: 0, value: { kind: 'literal' as const, value: '1' } },
                  { offset: 1, value: { kind: 'literal' as const, value: '0' } },
                ],
              },
            ],
          },
        ],
      },
    }
    const { assembly, targets } = setupBrowserRuntime(source)
    const captures = capturePresence(assembly, 'leave', ['thumb'])

    try {
      expect(() => assembly.runtime.dispose()).toThrow(failure)
      targets.get('thumb')!.remove()
      const leave = new PresenceOperation(captures, 'leave')
      leave.play()
      const effects = nativeEffects(assembly.executor)

      expect(effects).toHaveLength(1)
      effects[0].finish()

      await expect(leave.finished).resolves.toBe('completed')

      expect(nativeEffects(assembly.executor)).toEqual([])
      expect(targets.get('thumb')!.style.opacity).toBe('')
    } finally {
      factory.mockRestore()
    }
  })

  it('settles enter and leave together when reduced motion becomes active', async () => {
    const { assembly, targets, errors } = setupBrowserRuntime(lifecyclePolicyDefinition, {
      enabled: true,
    })
    const enter = startRegisteredLifecycle(assembly, 'enter', 'box')
    const leave = startRegisteredLifecycle(assembly, 'leave', 'exit')
    const media: CDPSession = cdp()

    try {
      await media.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
      })

      expect(await enter.finished).toBe('completed')
      expect(await leave.finished).toBe('completed')
      expect(targets.get('exit')!.getAnimations()).toHaveLength(0)
      expect(targets.get('box')!.style.opacity).toBe('1')
      expect(targets.get('box')!.style.width).toBe('50px')
      expect(errors).toEqual([])
    } finally {
      leave.cancel('owner-teardown')

      await media.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
      })
    }
  })

  it('reports asynchronous enter settlement failures after the native session completes', async () => {
    const { assembly, targets, errors } = setupBrowserRuntime(lifecyclePolicyDefinition, {
      enabled: true,
    })
    const enter = new PresenceOperation(
      capturePresence(assembly, 'enter', ['box']),
      'enter',
      () => {},
    )
    enter.initialize()
    enter.play()

    const failure = new Error('Failed to apply lifecycle settlement')
    const write = vi.spyOn(targets.get('box')!.style, 'setProperty').mockImplementationOnce(() => {
      throw failure
    })

    try {
      for (const animation of targets.get('box')!.getAnimations()) animation.finish()

      expect(await enter.finished).toBe('completed')

      await new Promise(requestAnimationFrame)

      expect(errors).toEqual([
        expect.objectContaining({ code: 'runtime.animation', error: failure }),
      ])
    } finally {
      write.mockRestore()
    }
  })

  it('plans enter completion restoration of removed declarations without cancelling a concurrent leave', async () => {
    const { assembly, targets, errors } = setupBrowserRuntime(lifecyclePolicyDefinition, {
      enabled: true,
    })
    const enter = startRegisteredLifecycle(assembly, 'enter', 'box')
    const leave = startRegisteredLifecycle(assembly, 'leave', 'exit')
    const box = targets.get('box')!

    try {
      assembly.runtime.updateParameters({ enabled: false })

      for (const animation of box.getAnimations()) animation.finish()

      expect(await enter.finished).toBe('completed')
      expect(box.style.width).toBe('')
      expect(box.style.opacity).toBe('1')
      expect(leave.isFinished).toBe(false)
      expect(errors).toEqual([])
    } finally {
      leave.cancel('owner-teardown')
    }
  })

  it('releases only captured effects and keeps leave ownership through ordinary updates', async () => {
    const source = {
      ...definition,
      leave: {
        timing: { kind: 'tween' as const, durationMs: 1000, easing: 'linear' },
        targets: [
          {
            name: 'thumb',
            properties: [
              {
                name: 'translate',
                keyframes: [{ offset: 1, value: { kind: 'literal' as const, value: '0px' } }],
              },
            ],
          },
        ],
      },
    }
    const { assembly, targets } = setupBrowserRuntime(source)

    updateMode(assembly, 'on', { paused: true })

    const before = [...nativeEffects(assembly.executor)]
    const unrelated = before.find(
      (animation) =>
        animation.effect instanceof KeyframeEffect &&
        animation.effect.target === targets.get('track'),
    )
    const session = new PresenceOperation(capturePresence(assembly, 'leave', ['thumb']), 'leave')

    try {
      session.initialize()

      expect(nativeEffects(assembly.executor)).toContain(unrelated)
      expect(nativeEffects(assembly.executor).length).toBeLessThan(before.length)

      session.play()

      const leave = nativeEffects(assembly.executor).find(
        (animation) => !before.includes(animation),
      )

      updateMode(assembly, 'off', { paused: true })

      expect(nativeEffects(assembly.executor)).toContain(leave)
      expect(session.isFinished).toBe(false)
    } finally {
      session.cancel('owner-teardown')
    }

    expect(await session.finished).toBe('owner-teardown')
  })

  it('retains enter snapshots on input changes and cancels them on owner disposal', async () => {
    const { assembly } = setupBrowserRuntime()
    const interrupted = new PresenceOperation(capturePresence(assembly, 'enter', []), 'enter')

    interrupted.initialize()
    assembly.runtime.updateParameters({ mode: 'on' })

    expect(assembly.runtime.composition.states.toggle).toBe('on')
    expect(interrupted.isFinished).toBe(false)

    interrupted.play()

    expect(await interrupted.finished).toBe('completed')

    const disposed = new PresenceOperation(capturePresence(assembly, 'enter', []), 'enter')

    disposed.initialize()
    assembly.runtime.dispose()

    expect(await disposed.finished).toBe('owner-teardown')
  })
})
