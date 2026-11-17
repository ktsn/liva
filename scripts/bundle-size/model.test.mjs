import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { definitionJson, sizes } from './measure.mjs'
import { difference, formatComment, validateResult } from './model.mjs'

import { example } from './test-fixture.mjs'

test('comparison keeps increases, decreases, unchanged metrics and zero-base semantics', () => {
  for (const [base, head, bytes, percent] of [
    [100, 120, 20, 20],
    [100, 75, -25, -25],
    [100, 100, 0, 0],
    [0, 10, 10, null],
  ]) {
    assert.deepEqual(difference(base, head), { bytes, percent })
  }
})

test('definition metrics use decoded UTF-8 JSON and compress the whole JS deterministically', () => {
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

test('unsupported/missing loader fails instead of reporting zero definition bytes', () => {
  for (const ast of [{ body: [] }, { body: [{ type: 'VariableDeclaration', declarations: [] }] }]) {
    assert.throws(() => definitionJson(ast), /Unsupported production definition loader/)
  }
})

test('valid success and side failures retain SHAs and report failure in the same format', () => {
  const result = example()

  assert.equal(validateResult(result), result)

  result.status = 'failure'
  result.base = { sha: result.base.sha, error: 'compiler error' }

  validateResult(result)

  const comment = formatComment(result, {
    repository: 'ktsn/liva',
    run: result.context.run,
    attempt: 1,
    headSha: result.head.sha,
  })

  assert.match(comment, /Measurement failed/)
  assert.match(comment, /base `aaaaaaaa/)
  assert.doesNotMatch(comment, /\| Minified JS/)
})

test('schema rejects unsafe numbers, metadata injection, unsupported settings and unknown fields', () => {
  const changes = [
    (r) => {
      r.head.bytes.minified = NaN
    },
    (r) => {
      r.head.bytes.gzip = -1
    },
    (r) => {
      r.head.bytes.brotli = 1.5
    },
    (r) => {
      r.head.bytes.definitions = 0
    },
    (r) => {
      r.head.metadata.dependencies.vue = '```<img>'
    },
    (r) => {
      r.specification.target = 'esnext'
    },
    (r) => {
      r.specification.external.push('other')
    },
    (r) => {
      r.context.run = '100'
    },
    (r) => {
      r.head.sha = 'bad'
    },
    (r) => {
      r.extra = true
    },
    (r) => {
      r.head.metadata.extra = 'bad'
    },
    (r) => {
      r.status = 'failure'
    },
    (r) => {
      r.head = { sha: r.head.sha, error: 'failure' }
    },
  ]

  for (const change of changes) {
    const result = example()

    change(result)
    assert.throws(() => validateResult(result))
  }
})

function stringFields(value, path = []) {
  return Object.entries(value).flatMap(([name, item]) => {
    const field = [...path, name]

    if (typeof item === 'string') return [field]

    return item && typeof item === 'object' ? stringFields(item, field) : []
  })
}

test('all artifact string fields reject coercible arrays and other JSON types', () => {
  for (const field of stringFields(example())) {
    for (const invalid of [null, true, 123, {}, 'array']) {
      const result = example()
      const parent = field.slice(0, -1).reduce((value, key) => value[key], result)
      const name = field.at(-1)

      parent[name] = invalid === 'array' ? [parent[name]] : invalid

      assert.throws(() => validateResult(result), `Accepted invalid type at ${field.join('.')}`)
    }
  }
})

test('comment includes signed byte/percentage deltas, definitions, SHAs, logs and collapsed metadata', () => {
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

test('checked-in baseline passes the same strict artifact schema', async () => {
  validateResult(JSON.parse(await readFile(new URL('./baseline.json', import.meta.url), 'utf8')))
})
