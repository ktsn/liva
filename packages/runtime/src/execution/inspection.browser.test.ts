import type { RuntimeDiagnostic } from './execution-contracts.ts'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import {
  assembleRuntime,
  nativeEffects,
  type RuntimeAssembly,
} from '../__test__/helpers/assembly.ts'
import type { Definition } from '../model/definition.ts'
import { PresenceOperation } from './presence-operation.ts'

const timing = { kind: 'tween', durationMs: 1000, easing: 'linear' } as const
const source: Definition = {
  name: 'scoped-preview',
  layers: [
    {
      name: 'base',
      timing,
      targets: [
        {
          name: 'body',
          properties: [{ name: 'opacity', value: { kind: 'literal', value: '0.2' } }],
        },
      ],
    },
    {
      name: 'active',
      when: { kind: 'boolean', value: false },
      timing,
      targets: [
        { name: 'body', properties: [{ name: 'opacity', value: { kind: 'literal', value: '1' } }] },
      ],
    },
  ],
  leave: {
    timing,
    targets: [
      {
        name: 'body',
        properties: [
          {
            name: 'opacity',
            keyframes: [
              { offset: 0, value: { kind: 'literal', value: '0.2' } },
              { offset: 1, value: { kind: 'literal', value: '0' } },
            ],
          },
        ],
      },
    ],
  },
}
const from = { layers: { base: true, active: false }, states: {} }
const to = { layers: { base: true, active: true }, states: {} }
const registrations: { assembly: RuntimeAssembly; element: HTMLElement }[] = []

function setup(definition = source) {
  const element = document.createElement('div')
  const errors: RuntimeDiagnostic[] = []
  const assembly = assembleRuntime(definition, {}, (diagnostic) => errors.push(diagnostic))

  document.body.append(element)
  assembly.executor.bind([['body', element]])
  registrations.push({ assembly, element })

  return { ...assembly, element, errors }
}

afterEach(() => {
  for (const { assembly, element } of registrations.splice(0)) {
    assembly.runtime.dispose()
    element.remove()
  }
})

describe('scoped preview operations', () => {
  it('starts paused at zero, seeks both ways and ignores non-finite positions', async () => {
    const { inspection, executor, element } = setup()
    const preview = inspection.previewComposition(from, to)

    await Promise.all(nativeEffects(executor).map((effect) => effect.ready))

    expect(
      nativeEffects(executor).every(
        (effect) => effect.playState === 'paused' && effect.currentTime === 0,
      ),
    ).toBe(true)

    preview.seek(750)
    expect(getComputedStyle(element).opacity).toBe('0.8')

    preview.seek(250)
    expect(getComputedStyle(element).opacity).toBe('0.4')

    preview.seek(NaN)
    preview.seek(Infinity)
    expect(getComputedStyle(element).opacity).toBe('0.4')

    preview.seek(-100)
    expect(getComputedStyle(element).opacity).toBe('0.2')

    preview.end()
    preview.seek(800)
    preview.end()

    expect(nativeEffects(executor)).toEqual([])
    expect(element.style.opacity).toBe('0.2')
  })

  it('prevents a stale handle from seeking or restoring a replacement preview', () => {
    const { inspection, executor, element } = setup()
    const previous = inspection.previewComposition(from, to)
    const current = inspection.previewComposition(to, from)

    current.seek(250)
    previous.seek(900)
    previous.end()

    expect(getComputedStyle(element).opacity).toBe('0.8')
    expect(nativeEffects(executor)).toHaveLength(1)

    current.end()

    expect(element.style.opacity).toBe('0.2')
    expect(nativeEffects(executor)).toEqual([])
  })

  it('does not scrub retained live leave and expires its handle on disposal', async () => {
    const { runtime, inspection, executor, element } = setup()
    const leave = new PresenceOperation([executor.capturePresence('leave', ['body'])], 'leave')
    leave.play()
    const effect = nativeEffects(executor)[0]
    effect.pause()
    effect.currentTime = 100

    const preview = inspection.previewComposition(from, to)
    preview.seek(750)

    expect(effect.currentTime).toBe(100)
    // The paused leave supplies 0.18 as the displayed start: 0.18 + (1 - 0.18) * 0.75.
    expect(getComputedStyle(element).opacity).toBe('0.795')

    runtime.dispose()
    preview.seek(200)
    preview.end()

    expect(effect.currentTime).toBe(100)
    expect(leave.isFinished).toBe(false)

    leave.cancel('owner-teardown')

    await expect(leave.finished).resolves.toBe('owner-teardown')
  })

  it('preserves native preparation failure and reports a separate restoration failure', () => {
    const { inspection, executor, element, errors } = setup()
    const failure = new Error('Native preparation failed')
    const cleanup = new Error('Restoration failed')
    const prepare = vi.spyOn(window, 'KeyframeEffect').mockImplementationOnce(function () {
      throw failure
    })
    const restore = vi.spyOn(executor, 'abortPreview').mockImplementationOnce(() => {
      throw cleanup
    })
    let caught: unknown

    try {
      inspection.previewComposition(from, to)
    } catch (error) {
      caught = error
    }

    expect(caught).toEqual(new Error('Could not prepare composition preview', { cause: failure }))
    expect(errors.map(({ code, error }) => ({ code, error }))).toEqual([
      { code: 'runtime.preview-cleanup', error: cleanup },
      { code: 'runtime.preview', error: caught },
    ])
    prepare.mockRestore()
    restore.mockRestore()

    executor.endCompositionPreview()

    expect(element.style.opacity).toBe('0.2')
    expect(nativeEffects(executor)).toEqual([])
  })

  it('issues an empty preview handle with the same termination contract', () => {
    const { inspection, executor, element } = setup({ name: 'empty', layers: [] })
    const preview = inspection.previewComposition(
      { layers: {}, states: {} },
      { layers: {}, states: {} },
    )

    preview.seek(100)

    expect(nativeEffects(executor)).toEqual([])
    expect(element.style.opacity).toBe('')

    preview.end()
    expect(element.style.opacity).toBe('')
  })
})
