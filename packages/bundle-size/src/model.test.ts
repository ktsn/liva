import { assert, describe, expect, it } from 'vite-plus/test'
import { definitionJson, sizes } from './measure.ts'
import { difference, formatComment, validateResult } from './model.ts'

import type { Comparison } from './types.ts'
import { example, readField, replaceField } from './__tests__/test-fixture.ts'

function stringFields(value: object, path: string[] = []): string[][] {
  return Object.entries(value).flatMap(([name, item]: [string, unknown]) => {
    const field = [...path, name]

    if (typeof item === 'string') return [field]

    return item && typeof item === 'object' ? stringFields(item, field) : []
  })
}

describe('measurement results', () => {
  it('comparison keeps increases, decreases, unchanged metrics and zero-base semantics', () => {
    for (const [base, head, bytes, percent] of [
      [100, 120, 20, 20],
      [100, 75, -25, -25],
      [100, 100, 0, 0],
      [0, 10, 10, null],
    ] as const) {
      expect(difference(base, head)).toStrictEqual({ bytes, percent })
    }
  })

  it('definition metrics use decoded UTF-8 JSON and compress the whole JS deterministically', () => {
    const json = JSON.stringify({ definitions: [{ label: 'é\u2028\\"' }] })
    const ast = {
      body: [
        {
          type: 'VariableDeclaration',
          declarations: [
            { id: { name: 'bundle' }, init: { arguments: [{ type: 'Literal', value: json }] } },
          ],
        },
      ],
    }
    const extracted = definitionJson(ast)
    const bytes = Buffer.from(`const data=${JSON.stringify(json)};`)
    const result = sizes(bytes, extracted)

    expect(result.definitions).toBe(Buffer.byteLength(json))
    expect(result.definitions).not.toBe(Buffer.byteLength(JSON.stringify(json)))
    expect(result.minified).toBe(bytes.length)
    expect(sizes(bytes, extracted)).toStrictEqual(result)
  })

  it('unsupported/missing loader fails instead of reporting zero definition bytes', () => {
    for (const ast of [
      { body: [] },
      { body: [{ type: 'VariableDeclaration', declarations: [] }] },
    ]) {
      expect(() => definitionJson(ast)).toThrow(/Unsupported production definition loader/)
    }
  })

  it('valid success and side failures retain SHAs and report failure in the same format', () => {
    const original = example()

    expect(validateResult(original)).toStrictEqual(original)

    const result: Comparison = {
      ...original,
      status: 'failure',
      base: { sha: original.base.sha, error: 'compiler error' },
    }

    validateResult(result)

    const comment = formatComment(result, {
      repository: 'ktsn/liva',
      run: original.context.run,
      attempt: 1,
      headSha: result.head.sha,
    })

    expect(comment).toMatch(/Measurement failed/)
    expect(comment).toMatch(/base `aaaaaaaa/)
    expect(comment).not.toMatch(/\| Minified JS/)
  })

  it('result validation rejects unsafe numbers, metadata injection, unsupported settings and unknown fields', () => {
    const cases: [string[], unknown][] = [
      [['head', 'bytes', 'minified'], NaN],
      [['head', 'bytes', 'gzip'], -1],
      [['head', 'bytes', 'brotli'], 1.5],
      [['head', 'bytes', 'definitions'], 0],
      [['head', 'metadata', 'dependencies', 'vue'], '```<img>'],
      [['specification', 'target'], 'esnext'],
      [
        ['specification', 'external'],
        ['vue', 'other'],
      ],
      [['context', 'run'], '100'],
      [['head', 'sha'], 'bad'],
      [['extra'], true],
      [['head', 'metadata', 'extra'], 'bad'],
      [['status'], 'failure'],
      [['head'], { sha: '1'.repeat(40), error: 'failure' }],
    ]

    for (const [path, invalid] of cases) {
      const result: unknown = example()

      replaceField(result, path, invalid)
      expect(() => validateResult(result)).toThrow(Error)
    }
  })

  it('all artifact string fields reject coercible arrays and other JSON types', () => {
    for (const field of stringFields(example())) {
      for (const invalid of [null, true, 123, {}, 'array']) {
        const result: unknown = example()

        replaceField(result, field, invalid === 'array' ? [readField(result, field)] : invalid)
        expect(() => validateResult(result), `Accepted invalid type at ${field.join('.')}`).toThrow(
          Error,
        )
      }
    }
  })

  it('decoding preserves every validated dependency key and remains valid when decoded again', () => {
    const input = example()
    const dependencies: unknown = JSON.parse('{"__proto__":"1.0.0"}')

    replaceField(input, ['head', 'metadata', 'dependencies'], dependencies)

    const decoded = validateResult(input)

    assert('metadata' in decoded.head)
    expect(Object.keys(decoded.head.metadata.dependencies)).toStrictEqual(['__proto__'])
    expect(Object.getPrototypeOf(decoded.head.metadata.dependencies)).toBe(Object.prototype)
    expect(validateResult(decoded)).toStrictEqual(decoded)
  })

  it('comment includes signed byte/percentage deltas, definitions, SHAs, logs and collapsed metadata', () => {
    const result = example()

    result.head.bytes.minified = 120
    result.head.bytes.gzip = 60

    const comment = formatComment(result, {
      repository: 'ktsn/liva',
      run: result.context.run,
      attempt: 1,
      headSha: result.head.sha,
    })

    expect(comment).toMatch(/Minified JS \| 100 \| 120 \| \+20 \| \+20.00%/)
    expect(comment).toMatch(/gzip JS \| 80 \| 60 \| -20 \| -25.00%/)
    expect(comment).toMatch(/Brotli JS \| 70 \| 70 \| \+0 \| \+0.00%/)
    expect(comment).toMatch(/Definition JSON \(UTF-8\)/)
    expect(comment).toMatch(/actions\/runs\/10000000001\/attempts\/1/)
    expect(comment).toMatch(/<details>/)
    expect(comment).toMatch(new RegExp(result.base.sha))
    expect(comment).toMatch(new RegExp(result.head.sha))
  })
})
