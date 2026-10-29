import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { decodeBundle } from '../packages/runtime/src/definition.ts'

const require = createRequire(import.meta.url)
const { compile } = require('../packages/vite/wasm/liva_wasm.js')
const source = readFileSync(new URL('../fixtures/toggle.liv', import.meta.url), 'utf8')
const expected = JSON.parse(
  readFileSync(new URL('../fixtures/toggle.json', import.meta.url), 'utf8'),
)
const result = JSON.parse(compile(source, false))
assert.deepEqual(result, expected)
const bundle = decodeBundle(JSON.stringify(result))
assert.equal(Object.isFrozen(bundle.definitions[0].states), true)
assert.throws(() => decodeBundle('{"schemaVersion":2,"definitions":[]}'), /Unsupported/)
assert.equal('mappings' in bundle, false)

const unicode = '// 😀\r\na { state on {} transition { timing: tween(duration: 1s) } }'
const development = JSON.parse(compile(unicode, true))
assert.deepEqual(development.diagnostics, [])
const range = development.mappings['a/transition/general/timing/duration'].range
assert.equal(Buffer.from(unicode).subarray(range.start, range.end).toString(), ' 1s')
console.log(
  'Node WASM golden contract, immutable TS view, schema rejection, and UTF-8 mappings passed',
)
