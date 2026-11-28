import { describe, expect, it } from 'vite-plus/test'
import { BrowserExecutor, MotionRuntime } from '@liva/runtime/core'
import { compile } from '../compiler.ts'
import { inspectionFeatures } from './inspection-features.ts'

function evaluate(source: string) {
  const result = compile(source, true)
  expect(result.diagnostics).toEqual([])

  const definition = result.definitions[0]
  const runtime = new MotionRuntime(
    new BrowserExecutor(console.warn),
    { ...definition, letBindings: [], layers: [] },
    {},
    console.warn,
  )

  return runtime.evaluateCandidate(definition, (values) => values, inspectionFeatures(definition))
}

describe('editor candidate feature resolution', () => {
  it('evaluates newly added spring timing without a reactive call store', () => {
    const values = evaluate(`
      motion candidate {
        let timing = spring(duration: 400, bounce: 0.25)
        @timing layer base { opacity: 1 }
      }
    `)

    expect(values.timing).toEqual({ kind: 'spring-duration', durationMs: 400, bounce: 0.25 })
  })

  it('evaluates a new reactive controller call in the candidate scope', () => {
    const values = evaluate(`
      motion candidate {
        let movement = link(input: 20, component: "x")
        layer base { translate := movement }
      }
    `)

    expect(values.movement).toMatchObject({ value: { x: 20 } })
  })
})
