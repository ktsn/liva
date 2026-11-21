import { describe, expect, it } from 'vite-plus/test'
import { readFileSync } from 'node:fs'
import type { Definition, Timing } from '@liva/runtime'
import { compile, type Compilation } from './compiler.ts'
import { emitFeatures, motionFeatures } from './features.ts'

function definitions(source: string): Compilation['definitions'] {
  const result = compile(source, false)

  expect(result.diagnostics).toEqual([])

  return result.definitions
}

describe('compiled feature imports', () => {
  it('deduplicates shared imports and attaches each implementation only to its Motion', () => {
    const generated = emitFeatures(
      definitions(`
      motion first {
        @tween(easing: linear)
        layer base { opacity: 1 }
      }
      motion second {
        @tween(easing: easeOut)
        layer base { $layout: position }
      }
      motion plain {
        layer base { opacity: 1 }
      }
    `),
    )

    expect(generated.imports).toContain('import { linear, easeOut }')
    expect(generated.imports.match(/import \{ tween \}/g)).toHaveLength(1)
    expect(generated.motions).toContain(
      '["first"]: { pure: { constants: { linear }, functions: { tween } } }',
    )
    expect(generated.motions).toContain(
      '["second"]: { pure: { constants: { easeOut }, functions: { tween } }, layout:',
    )
    expect(generated.motions).toContain('["plain"]: {  }')
    expect(generated.presence).toBe(false)
  })

  it('follows aliases, nested arguments and inactive state timing', () => {
    const [definition] = definitions(`
      motion fade(active: boolean, instant: number) {
        let curve = steps(count: 3)
        let easing = curve
        event ready when instant > 0
        let slow = spring(duration: 400)
        let timing = tween(duration: instant, easing: easing)

        @timing
        layer selection {
          state off initial { opacity: 0 }
          @slow
          state on { opacity: 1 }
          transition off -> on when active
        }

        @tween(easing: easeOut)
        leave { opacity: 0 }
      }
    `)
    const features = motionFeatures(definition)

    expect(features.timings).toEqual(new Set(['steps', 'spring', 'tween']))
    expect(features.constants).toEqual(new Set(['easeOut']))
    expect(features.spring).toBe(true)
    expect(features.presence).toBe(true)
  })

  it('recognizes compiler-generated controller call bindings independently of spring', () => {
    const [definition] = definitions(`
      motion dragCard(offset: number) {
        layer base { translate := link(input: offset, component: "x") }
      }
    `)
    const features = motionFeatures(definition)
    const generated = emitFeatures([definition])

    expect(generated.imports).toContain('import { link }')
    expect(generated.motions).toContain('builtins: { link }')
    expect(generated.motions).toContain('controllers: controllerFeature')
    expect(features.controllers).toBe(true)
    expect(features.reactive).toEqual(new Set(['link']))
    expect(features.spring).toBe(false)
  })

  it('finds layout timing in the validated directional transition and nested target', () => {
    const source = readFileSync(
      new URL('../../../fixtures/layout-config.liv', import.meta.url),
      'utf8',
    )
    const [definition] = definitions(source)
    const features = motionFeatures(definition)

    expect(features.layout).toBe(true)
    expect(features.timings).toEqual(new Set(['tween', 'spring']))
    expect(features.constants).toEqual(new Set(['instant']))
  })
  it('collects style and lifecycle frame easing and CSS interpolations', () => {
    const [definition] = definitions(`
      motion fade(linear: number) {
        @tween(easing: cubicBezier(x1: 0.2, y1: 0, x2: 0.8, y2: 1))
        layer base {
          opacity: 1
          translate ~> { 0%: 0 @easeIn; 100%: \${linear}px 0 }
        }

        @tween()
        enter { opacity ~> { 0%: 0 @easeOut } }
      }
    `)
    const features = motionFeatures(definition)
    const generated = emitFeatures([definition])

    expect(features.timings).toEqual(new Set(['tween', 'cubicBezier']))
    expect(features.constants).toEqual(new Set(['easeIn', 'easeOut']))
    expect(generated.imports).toContain('import { LivaPresenceBoundary }')
  })

  it.each([
    [{ kind: 'tween', durationMs: 400, easing: 'linear' }, false],
    [{ kind: 'spring-duration', durationMs: 400, bounce: 0 }, true],
  ] satisfies [Timing, boolean][])(
    'selects playback for a serialized timing value of %j',
    (timing, needsSpring) => {
      const definition: Definition = {
        name: 'fade',
        layers: [{ name: 'base', timing, targets: [] }],
      }

      expect(motionFeatures(definition).spring).toBe(needsSpring)
    },
  )
  it('defines lexical scope for shadowing by lets and named targets', () => {
    const generated = emitFeatures(
      definitions(`
      motion motion {
        let instant = tween(duration: 25)
        let metrics = measure(target: easeOut)

        @instant
        layer base { easeOut { opacity: \${metrics.width / 1000} } }
      }
    `),
    )

    expect(generated.imports).toContain('import { tween }')
    expect(generated.imports).toContain('import { measure }')
    expect(generated.imports).not.toContain('constants')
  })
})
