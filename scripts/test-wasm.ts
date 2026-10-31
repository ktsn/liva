import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { compile } from '../packages/vite/wasm/liva_wasm.js'
import type { Compilation } from '../packages/vite/src/compiler.ts'
import { decodeBundle } from '../packages/runtime/src/definition.ts'

for (const name of ['toggle', 'reactive-toggle', 'card', 'derived']) {
  const source = readFileSync(new URL(`../fixtures/${name}.liv`, import.meta.url), 'utf8')
  const expected = JSON.parse(
    readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8'),
  )
  const result = JSON.parse(compile(source, false))
  assert.deepEqual(result, expected)
  const bundle = decodeBundle(JSON.stringify(result))
  assert.equal(Object.isFrozen(bundle.definitions[0].states), true)
  assert.equal('mappings' in bundle, false)
}
assert.throws(() => decodeBundle('{"schemaVersion":2,"definitions":[]}'), /Unsupported/)

const unicode = '// 😀\r\nmotion a { state on {} transition { @tween-duration: 1s } }'
const development: Compilation = JSON.parse(compile(unicode, true))
assert.deepEqual(development.diagnostics, [])
assert(development.mappings)
const range = development.mappings['a/transition/general/timing/duration'].range
assert.equal(Buffer.from(unicode).subarray(range.start, range.end).toString(), ' 1s ')
console.log(
  'Node WASM golden contract, immutable TS view, schema rejection, and UTF-8 mappings passed',
)
