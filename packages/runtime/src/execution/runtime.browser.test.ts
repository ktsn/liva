import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { nativeEffects, type RuntimeAssembly } from '../__test__/helpers/assembly.ts'
import { createBrowserRuntimeHarness } from '../__test__/helpers/browser-runtime.ts'
import { capturePresence } from '../__test__/helpers/presence.ts'
import { PresenceOperation } from './presence-operation.ts'
import { decodeBundle } from '../model/definition.ts'
import fixture from '../../../../fixtures/toggle.json'
import * as functions from '../builtins/index.ts'
import { userEvent } from 'vite-plus/test/browser'
import constrainedFixture from '../../../../fixtures/constrained.json'
import reactiveFixture from '../../../../fixtures/reactive-toggle.json'
import cardFixture from '../../../../fixtures/card.json'

vi.mock('../builtins/index.ts', { spy: true })

const definition = decodeBundle(JSON.stringify(fixture)).definitions[0]
const harness = createBrowserRuntimeHarness()

function setup(
  def = definition,
  inputs: Record<string, unknown> = def.parameters?.some((parameter) => parameter.name === 'mode')
    ? { mode: 'off' }
    : {},
) {
  return harness.setup(def, inputs)
}

function updateMode(assembly: RuntimeAssembly, mode: string, options: { paused?: boolean } = {}) {
  assembly.runtime.updateParameters({ mode })

  if (options.paused) {
    for (const animation of nativeEffects(assembly.executor)) animation.pause()
  }
}

afterEach(() => harness.dispose())

describe('Runtime browser coordination', () => {
  it('releases ordinary native effects and ignores later bindings when a call disposer fails', () => {
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
    }
    const { assembly, targets } = setup(source)

    try {
      updateMode(assembly, 'on', { paused: true })
      expect(nativeEffects(assembly.executor).length).toBeGreaterThan(0)

      expect(() => assembly.runtime.dispose()).toThrow(failure)

      expect(nativeEffects(assembly.executor)).toEqual([])
      expect([...targets.values()].every((element) => element.getAnimations().length === 0)).toBe(
        true,
      )
      // The toggle fixture declares thumb, and setup binds every declared target.
      const thumb = targets.get('thumb')!

      thumb.style.translate = '7px'
      assembly.executor.bind([...targets])

      expect(thumb.style.translate).toBe('7px')
      expect(thumb.getAnimations()).toEqual([])
    } finally {
      factory.mockRestore()
    }
  })

  it('preserves existing effects and composition when replacement preparation fails', () => {
    const { assembly, errors } = setup()

    updateMode(assembly, 'on', { paused: true })
    const previous = assembly.runtime.composition
    const animations = [...nativeEffects(assembly.executor)]

    expect(animations.length).toBeGreaterThan(0)

    const failure = new Error('native preparation failed')
    const prepare = vi.spyOn(window, 'KeyframeEffect').mockImplementationOnce(function () {
      throw failure
    })

    updateMode(assembly, 'off')
    prepare.mockRestore()

    expect(assembly.runtime.composition).toEqual(previous)
    expect(nativeEffects(assembly.executor)).toEqual(animations)
    expect(animations.every((animation) => animation.playState === 'paused')).toBe(true)
    expect(errors.at(-1)?.code).toBe('runtime.expression')
    expect(errors.at(-1)?.error).toBe(failure)
  })

  it('rejects incompatible string constraints on replacement without changing the live definition', () => {
    const source = decodeBundle(JSON.stringify(constrainedFixture)).definitions[0]
    const { assembly, targets } = setup(source, { position: 'start', axis: 'x' })
    const replacement = {
      ...source,
      parameters: [
        { name: 'position', type: { kind: 'stringUnion' as const, values: ['end'] } },
        { name: 'axis', type: { kind: 'stringUnion' as const, values: ['x'] } },
      ],
    }
    const thumb = targets.get('thumb')

    expect(() => assembly.runtime.replaceDefinition(replacement)).toThrow(
      'Motion parameter position requires "end"',
    )
    expect(assembly.runtime.definition).toBe(source)
    expect(thumb?.style.getPropertyValue('--position')).toBe('start')
    expect(thumb?.style.opacity).toBe('1')

    assembly.runtime.updateParameters({ position: 'end', axis: 'x' })

    expect(thumb?.style.getPropertyValue('--position')).toBe('end')
    expect(thumb?.style.opacity).toBe('0.25')
  })

  it('updates reactive parameters and retains them through definition replacement', () => {
    const reactive = decodeBundle(JSON.stringify(reactiveFixture)).definitions[0]
    const { assembly, errors } = setup(reactive, { checked: false })

    assembly.runtime.updateParameters({ checked: true })

    expect(assembly.runtime.composition.states.toggle).toBe('on')

    assembly.runtime.replaceDefinition(structuredClone(reactive))

    expect(assembly.runtime.composition.states.toggle).toBe('on')

    assembly.runtime.updateParameters({ checked: 'invalid' })

    expect(errors.at(-1)?.code).toBe('runtime.parameter')
    expect(assembly.runtime.composition.states.toggle).toBe('on')

    assembly.runtime.updateParameters({ checked: false })

    expect(assembly.runtime.composition.states.toggle).toBe('off')
  })

  it('updates template values in place and recovers from non-finite expressions', async () => {
    const templated = {
      name: 'size',
      parameters: [{ name: 'x', type: 'number' } as const],

      layers: [
        {
          name: 'idle',
          targets: [
            {
              name: 'box',
              properties: [
                {
                  name: 'width',
                  value: {
                    kind: 'template',
                    parts: [
                      {
                        kind: 'binary',
                        operator: '/',
                        left: { kind: 'number', value: 100 },
                        right: { kind: 'reference', path: ['x'] },
                      },
                      'px',
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
    } satisfies import('../model/definition.ts').Definition
    const { assembly, targets, errors } = setup(templated, { x: 1 })

    assembly.runtime.updateParameters({ x: 0 })

    expect(errors.at(-1)?.code).toBe('runtime.expression')

    const enter = new PresenceOperation(capturePresence(assembly, 'enter', []), 'enter')

    enter.initialize()
    assembly.runtime.updateParameters({ x: 2 })

    expect(enter.isFinished).toBe(false)

    enter.play()

    expect(await enter.finished).toBe('completed')
    expect(targets.get('box')!.style.width).toBe('50px')

    assembly.runtime.updateParameters({ x: 2 })

    expect(targets.get('box')!.style.width).toBe('50px')

    assembly.runtime.updateParameters({ x: 0 })

    expect(errors.at(-1)?.code).toBe('runtime.expression')
    expect(targets.get('box')!.style.width).toBe('50px')
  })

  it('stops a reactive update when an event listener disposes its owner', () => {
    const base = decodeBundle(JSON.stringify(reactiveFixture)).definitions[0]
    const def = {
      ...base,
      events: [{ name: 'dismiss', when: { kind: 'reference', path: ['checked'] } as const }],
    }
    const { assembly } = setup(def, { checked: false })

    assembly.runtime.onEvent = () => assembly.runtime.dispose()
    assembly.runtime.updateParameters({ checked: true })

    expect(nativeEffects(assembly.executor)).toEqual([])
    updateMode(assembly, 'on')
  })

  it('cleans drag subscriptions and reports a failed reevaluation during disposal', async () => {
    const card = decodeBundle(JSON.stringify(cardFixture)).definitions[0]
    const def = {
      ...card,
      letBindings: [
        ...card.letBindings!,
        {
          name: 'ratio',
          initializer: {
            kind: 'binary',
            operator: '/',
            left: { kind: 'number', value: 1 },
            right: {
              kind: 'binary',
              operator: '+',
              left: { kind: 'reference', path: ['movement', 'offset', 'x'] },
              right: { kind: 'number', value: 1 },
            },
          },
        } as const,
      ],
    }
    const { assembly, targets, errors } = setup(def, {})
    const body = targets.get('body')!

    body.style.cssText =
      'position:fixed;left:100px;top:20px;width:20px;height:20px;z-index:1;touch-action:none'

    const destination = document.createElement('div')

    destination.style.cssText = 'position:fixed;left:99px;top:20px;width:20px;height:20px'
    harness.append(destination)
    await userEvent.dragAndDrop(body, destination, { force: true })

    expect(errors).toContainEqual(expect.objectContaining({ code: 'runtime.expression' }))

    const count = errors.length

    assembly.runtime.dispose()

    expect(errors.length).toBeGreaterThan(count)
    expect(nativeEffects(assembly.executor)).toEqual([])
  })
})
