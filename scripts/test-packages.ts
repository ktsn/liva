import assert from 'node:assert/strict'
import { execFileSync, execSync } from 'node:child_process'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const entry = ['dist/index.js', 'dist/index.d.ts']
const required = {
  runtime: entry,
  vue: [...entry, 'dist/runtime.js', 'dist/runtime.d.ts'],
  vite: [
    ...entry,
    'dist/editor.js',
    'wasm/liva_wasm.js',
    'wasm/liva_wasm_bg.wasm',
    'wasm/package.json',
  ],
}

for (const [name, expected] of Object.entries(required)) {
  const manifest = execSync('pnpm pack --dry-run --json', {
    cwd: resolve(root, 'packages', name),
    encoding: 'utf8',
  })
  const result: unknown = JSON.parse(manifest)
  assert(result && typeof result === 'object' && 'files' in result && Array.isArray(result.files))

  const files: unknown[] = result.files
  const paths = new Set(
    files.map((file) => {
      assert(file && typeof file === 'object' && 'path' in file && typeof file.path === 'string')
      return file.path
    }),
  )

  for (const path of expected) {
    assert(paths.has(path), `@liva/${name} package is missing ${path}`)
  }

  for (const path of paths) {
    assert(
      !path.startsWith('src/') &&
        !path.endsWith('.vue') &&
        (!path.endsWith('.ts') || path.endsWith('.d.ts')),
      `Unexpected package source: ${path}`,
    )
  }
}

execFileSync(
  process.execPath,
  [
    '--no-experimental-strip-types',
    '--input-type=module',
    '--eval',
    `
      import assert from 'node:assert/strict'
      import { decodeBundle } from '@liva/runtime'
      import vue, { createLivaPlugin } from '@liva/vue'
      import { createLivaPlugin as createRuntimePlugin } from '@liva/vue/runtime'
      import vite from '@liva/vite'

      assert.equal(typeof decodeBundle, 'function')
      assert.equal(typeof vue.install, 'function')
      assert.equal(createLivaPlugin, createRuntimePlugin)
      assert.equal(vite().name, 'liva')
    `,
  ],
  { cwd: resolve(root, 'playground'), stdio: 'inherit' },
)
