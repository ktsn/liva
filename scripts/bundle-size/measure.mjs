import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { brotliCompressSync, constants, gzipSync } from 'node:zlib'

import { settings } from './model.mjs'

export { settings }
export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const fixture = join(import.meta.dirname, 'fixture')

/** Extract the decoded JSON argument, never the escaped JavaScript literal's length. */
export function definitionJson(ast) {
  const declaration = ast.body.find((node) => node.type === 'VariableDeclaration')
  const argument = declaration?.declarations.find((node) => node.id.name === 'bundle')?.init
    ?.arguments?.[0]

  assert.equal(argument?.type, 'Literal', 'Unsupported production definition loader')
  assert.equal(typeof argument.value, 'string', 'Missing embedded definition JSON')

  const parsed = JSON.parse(argument.value)

  assert(Array.isArray(parsed.definitions) && parsed.definitions.length === 1)

  return argument.value
}

export function sizes(bytes, definition) {
  return {
    minified: bytes.length,
    gzip: gzipSync(bytes, { level: settings.gzipLevel }).length,
    brotli: brotliCompressSync(bytes, {
      params: { [constants.BROTLI_PARAM_QUALITY]: settings.brotliQuality },
    }).length,
    definitions: Buffer.byteLength(definition, 'utf8'),
  }
}

/** Exercise the measured bytes, loading Vue separately so it never affects the metrics. */
async function playback(bytes, require, vueRequire, root) {
  const { chromium } = require('@playwright/test')

  const vue = await readFile(
    join(dirname(vueRequire.resolve('vue/package.json')), 'dist/vue.runtime.esm-browser.prod.js'),
  )
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', request.url === '/' ? 'text/html' : 'text/javascript')
    response.end(
      request.url === '/bundle.js'
        ? bytes
        : request.url === '/vue.js'
          ? vue
          : '<!doctype html><div id="app"></div><script type="importmap">{"imports":{"vue":"/vue.js"}}</script><script type="module" src="/bundle.js"></script>',
    )
  })

  await new Promise((done, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', done)
  })

  let browser

  try {
    browser = await chromium.launch()

    const page = await browser.newPage()
    const errors = []

    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text())
    })

    await page.goto(`http://127.0.0.1:${server.address().port}`)

    const button = page.getByRole('button', { name: 'Toggle opacity' })

    await button.waitFor()
    await page.waitForFunction(
      () =>
        document.querySelector('button')?.style.opacity === '0.5' &&
        document.getAnimations().length === 0,
    )
    assert.equal(await button.getAttribute('aria-pressed'), 'false')

    for (const [pressed, opacity] of [
      ['true', '1'],
      ['false', '0.5'],
    ]) {
      await button.click()
      await page.waitForFunction(
        (expected) =>
          getComputedStyle(document.querySelector('button')).opacity === expected &&
          document.getAnimations().length === 0,
        opacity,
      )
      assert.equal(await button.getAttribute('aria-pressed'), pressed)
    }

    assert.deepEqual(errors, [])
    await page.screenshot({ path: join(root, 'playback.png') })
  } finally {
    try {
      await browser?.close()
    } finally {
      await new Promise((done, reject) => server.close((error) => (error ? reject(error) : done())))
    }
  }
}

/** Target must have its own frozen dependencies and freshly built compiler WASM. */
export async function measure(target, sha, output) {
  assert.equal(process.versions.node, settings.node, `Use Node ${settings.node}`)

  const require = createRequire(join(target, 'package.json'))
  const viteManifest = require.resolve('vite-plus/package.json')
  const { build, version, rolldownVersion } = await import(
    pathToFileURL(join(dirname(viteManifest), 'dist/index.js'))
  )
  const { default: vize } = await import(pathToFileURL(require.resolve('@vizejs/vite-plugin')))
  const { default: liva } = await import(pathToFileURL(join(target, 'packages/vite/src/index.ts')))
  const root = await mkdtemp(join(tmpdir(), 'liva-size-fixture-'))

  try {
    await cp(fixture, root, { recursive: true })

    let definition
    let modules

    const observe = {
      name: 'bundle-size-observer',
      enforce: 'post',
      transform(code, id) {
        if (id.includes('type=liva')) {
          assert.equal(definition, undefined, 'Expected exactly one production loader')
          definition = definitionJson(this.parse(code))
        }
      },
      generateBundle(_options, bundle) {
        const chunks = Object.values(bundle)

        assert.equal(chunks.length, 1, 'Expected exactly one shipped file')
        assert.equal(chunks[0].type, 'chunk')
        assert.deepEqual(chunks[0].imports, ['vue'], 'Unexpected shipped dependency')
        assert.deepEqual(chunks[0].dynamicImports, [])

        modules = Object.entries(chunks[0].modules)
          .filter(([, value]) => value.renderedLength > 0)
          .map(([id]) => id)
      },
    }

    const result = await build({
      configFile: false,
      envDir: false,
      root,
      mode: 'production',
      logLevel: 'warn',
      plugins: [liva(), vize(), observe],
      resolve: {
        alias: [
          { find: '@liva/runtime', replacement: join(target, 'packages/runtime/src/index.ts') },
          { find: '@liva/vue/runtime', replacement: join(target, 'packages/vue/src/runtime.ts') },
        ],
      },
      define: { 'process.env.NODE_ENV': '"production"' },
      build: {
        target: settings.target,
        minify: settings.minifier,
        sourcemap: false,
        write: false,
        rolldownOptions: {
          input: join(root, 'main.js'),
          external: settings.external,
          output: { format: settings.format, codeSplitting: false, entryFileNames: 'bundle.js' },
        },
      },
    })

    assert.equal(typeof definition, 'string', 'Production definition extraction failed')

    for (const required of [
      '/packages/vue/src/',
      '/packages/runtime/src/',
      'type=liva',
      '/Button.vue',
      'liva:vue-plugin',
    ]) {
      assert(
        modules.some((id) => id.includes(required)),
        `Missing production module: ${required}`,
      )
    }

    const bytes = Buffer.from(result.output[0].code, 'utf8')

    for (const forbidden of [
      '__LIVA_EDITOR__',
      '/__liva/',
      'wasm_bindgen',
      'sourceMappingURL',
      target,
      root,
    ]) {
      assert(!bytes.includes(forbidden), `Unexpected production content: ${forbidden}`)
    }

    assert(
      !modules.some((id) => /editor|compiler|\.wasm|node_modules/.test(id)),
      'Unexpected bundled compiler, editor or dependency',
    )

    const vueRequire = createRequire(join(target, 'packages/vue/package.json'))

    await playback(bytes, require, vueRequire, root)

    const dependencies = {}
    const manifest = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'))

    for (const name of [...Object.keys(manifest.devDependencies), 'vue']) {
      const path =
        name === 'vue'
          ? vueRequire.resolve('vue/package.json')
          : join(target, 'node_modules', name, 'package.json')

      dependencies[name] = JSON.parse(await readFile(path, 'utf8')).version
    }

    const metadata = {
      node: process.versions.node,
      rustc: execFileSync('rustc', ['--version'], { cwd: target, encoding: 'utf8' }).trim(),
      wasmBindgen: (await readFile(join(target, 'crates/liva_wasm/Cargo.toml'), 'utf8')).match(
        /^wasm-bindgen = "=([0-9.]+)"$/m,
      )?.[1],
      packageManager: manifest.packageManager,
      zlib: process.versions.zlib,
      brotli: process.versions.brotli,
      vite: version,
      rolldown: rolldownVersion,
      oxc: JSON.parse(
        await readFile(
          createRequire(createRequire(viteManifest).resolve('vite/package.json')).resolve(
            'oxc-transform/package.json',
          ),
          'utf8',
        ),
      ).version,
      dependencies,
      lockfile: digest(await readFile(join(target, 'pnpm-lock.yaml'))),
      cargoLockfile: digest(await readFile(join(target, 'Cargo.lock'))),
      wasm: digest(await readFile(join(target, 'packages/vite/wasm/liva_wasm_bg.wasm'))),
    }
    const measurement = { sha, bytes: sizes(bytes, definition), bundle: digest(bytes), metadata }

    if (output) {
      await cp(root, output, { recursive: true })
      await writeFile(join(output, 'bundle.js'), bytes)
      await writeFile(
        join(output, 'modules.json'),
        JSON.stringify(
          modules.map((id) => id.replace(target, '<target>').replace(root, '<fixture>')),
          null,
          2,
        ),
      )
    }

    return measurement
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

export async function specification() {
  const parts = await Promise.all(
    ['Button.vue', 'main.js'].map((name) => readFile(join(fixture, name))),
  )

  return {
    ...settings,
    fixture: digest(Buffer.concat(parts)),
    harness: digest(
      Buffer.concat(
        await Promise.all(
          ['measure.mjs', 'model.mjs'].map((name) => readFile(new URL(name, import.meta.url))),
        ),
      ),
    ),
  }
}

if (process.argv[1] === import.meta.filename) {
  const [target, sha, resultFile, output] = process.argv.slice(2)
  const result = await measure(target, sha, output)

  await writeFile(resultFile, JSON.stringify(result))
}
