import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { definitionJson, sizes } from './measure.ts'
import { difference, formatComment, validateResult } from './model.ts'

import type { Comparison } from './types.ts'
import { example, readField, replaceField } from './test-fixture.ts'

await test('comparison keeps increases, decreases, unchanged metrics and zero-base semantics', () => {
  for (const [base, head, bytes, percent] of [
    [100, 120, 20, 20],
    [100, 75, -25, -25],
    [100, 100, 0, 0],
    [0, 10, 10, null],
  ] as const) {
    assert.deepEqual(difference(base, head), { bytes, percent })
  }
})

await test('definition metrics use decoded UTF-8 JSON and compress the whole JS deterministically', () => {
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

  assert.equal(result.definitions, Buffer.byteLength(json))
  assert.notEqual(result.definitions, Buffer.byteLength(JSON.stringify(json)))
  assert.equal(result.minified, bytes.length)
  assert.deepEqual(sizes(bytes, extracted), result)
})

await test('unsupported/missing loader fails instead of reporting zero definition bytes', () => {
  for (const ast of [{ body: [] }, { body: [{ type: 'VariableDeclaration', declarations: [] }] }]) {
    assert.throws(() => definitionJson(ast), /Unsupported production definition loader/)
  }
})

await test('valid success and side failures retain SHAs and report failure in the same format', () => {
  const original = example()

  assert.deepEqual(validateResult(original), original)

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

  assert.match(comment, /Measurement failed/)
  assert.match(comment, /base `aaaaaaaa/)
  assert.doesNotMatch(comment, /\| Minified JS/)
})

await test('schema rejects unsafe numbers, metadata injection, unsupported settings and unknown fields', () => {
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
    assert.throws(() => validateResult(result))
  }
})

function stringFields(value: object, path: string[] = []): string[][] {
  return Object.entries(value).flatMap(([name, item]: [string, unknown]) => {
    const field = [...path, name]

    if (typeof item === 'string') return [field]

    return item && typeof item === 'object' ? stringFields(item, field) : []
  })
}

await test('all artifact string fields reject coercible arrays and other JSON types', () => {
  for (const field of stringFields(example())) {
    for (const invalid of [null, true, 123, {}, 'array']) {
      const result: unknown = example()

      replaceField(result, field, invalid === 'array' ? [readField(result, field)] : invalid)
      assert.throws(() => validateResult(result), `Accepted invalid type at ${field.join('.')}`)
    }
  }
})

await test('decoding preserves every validated dependency key and remains valid when decoded again', () => {
  const input = example()
  const dependencies: unknown = JSON.parse('{"__proto__":"1.0.0"}')

  replaceField(input, ['head', 'metadata', 'dependencies'], dependencies)

  const decoded = validateResult(input)

  assert('metadata' in decoded.head)
  assert.deepEqual(Object.keys(decoded.head.metadata.dependencies), ['__proto__'])
  assert.equal(Object.getPrototypeOf(decoded.head.metadata.dependencies), Object.prototype)
  assert.deepEqual(validateResult(decoded), decoded)
})

await test('comment includes signed byte/percentage deltas, definitions, SHAs, logs and collapsed metadata', () => {
  const result = example()

  result.head.bytes.minified = 120
  result.head.bytes.gzip = 60

  const comment = formatComment(result, {
    repository: 'ktsn/liva',
    run: result.context.run,
    attempt: 1,
    headSha: result.head.sha,
  })

  assert.match(comment, /Minified JS \| 100 \| 120 \| \+20 \| \+20.00%/)
  assert.match(comment, /gzip JS \| 80 \| 60 \| -20 \| -25.00%/)
  assert.match(comment, /Brotli JS \| 70 \| 70 \| \+0 \| \+0.00%/)
  assert.match(comment, /Definition JSON \(UTF-8\)/)
  assert.match(comment, /actions\/runs\/10000000001\/attempts\/1/)
  assert.match(comment, /<details>/)
  assert.match(comment, new RegExp(result.base.sha))
  assert.match(comment, new RegExp(result.head.sha))
})

await test('checked-in baseline passes the same strict artifact schema', async () => {
  const baseline = validateResult(
    JSON.parse(await readFile(new URL('./baseline.json', import.meta.url), 'utf8')),
  )

  assert.equal(baseline.status, 'success', 'Historical baseline must contain measured values')
})
