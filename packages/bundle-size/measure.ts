import type { Browser } from '@playwright/test'
import type { Plugin } from 'vite-plus'
import { array, object, text } from './data.ts'
import { validateMeasurement } from './model.ts'
import type { Bytes, Measurement, Metadata, Specification } from './types.ts'
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

import { settings } from './model.ts'

export { settings }
export const digest = (bytes: string | Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex')
const fixture = join(import.meta.dirname, 'fixture')

/** Extract the decoded JSON argument, never the escaped JavaScript literal's length. */
export function definitionJson(ast: unknown): string {
  const declaration = array(object(ast).body)
    .map(object)
    .find((node) => node.type === 'VariableDeclaration')

  assert(declaration, 'Unsupported production definition loader')

  const binding = array(declaration.declarations)
    .map(object)
    .find((node) => object(node.id).name === 'bundle')

  assert(binding && binding.init, 'Unsupported production definition loader')

  const argument = object(array(object(binding.init).arguments)[0])

  assert.equal(argument.type, 'Literal', 'Unsupported production definition loader')
  assert(typeof argument.value === 'string', 'Missing embedded definition JSON')

  const parsed = object(JSON.parse(argument.value))

  assert(Array.isArray(parsed.definitions) && parsed.definitions.length === 1)

  return argument.value
}

export function sizes(bytes: Buffer, definition: string): Bytes {
  return {
    minified: bytes.length,
    gzip: gzipSync(bytes, { level: settings.gzipLevel }).length,
    brotli: brotliCompressSync(bytes, {
      params: { [constants.BROTLI_PARAM_QUALITY]: settings.brotliQuality },
    }).length,
    definitions: Buffer.byteLength(definition, 'utf8'),
  }
}

// Revisions must expose these established callable APIs. Their return/behavior contracts
// are checked by the build, output inspection and browser playback, not substituted from head.
function isBuildApi(
  value: unknown,
): value is Pick<typeof import('vite-plus'), 'build' | 'version' | 'rolldownVersion'> {
  const module = object(value)

  return (
    typeof module.build === 'function' &&
    typeof module.version === 'string' &&
    typeof module.rolldownVersion === 'string'
  )
}

function isPluginFactory(value: unknown): value is { default: () => Plugin | Plugin[] } {
  return typeof object(value).default === 'function'
}

function isBrowserClient(
  value: unknown,
): value is Pick<typeof import('@playwright/test'), 'chromium'> {
  // Playwright's CommonJS export is a callable test function with browser properties.
  if (
    (typeof value !== 'function' && typeof value !== 'object') ||
    value === null ||
    !('chromium' in value)
  )
    return false

  return typeof object(value.chromium).launch === 'function'
}

/** Exercise the measured bytes, loading Vue separately so it never affects the metrics. */
async function playback(
  bytes: Buffer,
  require: NodeJS.Require,
  vueRequire: NodeJS.Require,
  root: string,
): Promise<void> {
  const client: unknown = require('@playwright/test')

  assert(isBrowserClient(client), 'Unsupported Playwright browser client')

  const { chromium } = client

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

  await new Promise<void>((done, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', done)
  })

  let browser: Browser | undefined

  try {
    browser = await chromium.launch()

    const page = await browser.newPage()
    const errors: string[] = []

    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text())
    })

    const address = server.address()

    assert(address && typeof address !== 'string')

    await page.goto(`http://127.0.0.1:${address.port}`)

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
      await page.waitForFunction((expected) => {
        const element = document.querySelector('button')

        return (
          element !== null &&
          getComputedStyle(element).opacity === expected &&
          document.getAnimations().length === 0
        )
      }, opacity)
      assert.equal(await button.getAttribute('aria-pressed'), pressed)
    }

    assert.deepEqual(errors, [])
    await page.screenshot({ path: join(root, 'playback.png') })
  } finally {
    try {
      await browser?.close()
    } finally {
      await new Promise<void>((done, reject) =>
        server.close((error) => (error ? reject(error) : done())),
      )
    }
  }
}

/** Target must have its own frozen dependencies and freshly built compiler WASM. */
export async function measure(target: string, sha: string, output?: string): Promise<Measurement> {
  assert.equal(process.versions.node, settings.node, `Use Node ${settings.node}`)

  const require = createRequire(join(target, 'package.json'))
  const viteManifest = require.resolve('vite-plus/package.json')
  const builder: unknown = await import(
    pathToFileURL(join(dirname(viteManifest), 'dist/index.js')).href
  )
  const vuePlugin: unknown = await import(
    pathToFileURL(require.resolve('@vizejs/vite-plugin')).href
  )
  const livaPlugin: unknown = await import(
    pathToFileURL(join(target, 'packages/vite/src/index.ts')).href
  )

  assert(isBuildApi(builder), 'Unsupported production build API')
  assert(
    isPluginFactory(vuePlugin) && isPluginFactory(livaPlugin),
    'Unsupported production plugin API',
  )

  const { build, version, rolldownVersion } = builder
  const root = await mkdtemp(join(tmpdir(), 'liva-size-fixture-'))

  try {
    await cp(fixture, root, { recursive: true })

    let definition: string | undefined
    let modules: string[] | undefined

    const observe: Plugin = {
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
        assert(chunks[0].type === 'chunk')
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
      plugins: [livaPlugin.default(), vuePlugin.default(), observe],
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
          input: join(root, 'main.ts'),
          external: [...settings.external],
          output: { format: settings.format, codeSplitting: false, entryFileNames: 'bundle.js' },
        },
      },
    })

    assert(typeof definition === 'string', 'Production definition extraction failed')
    assert(modules, 'Production modules were not observed')
    assert(
      !Array.isArray(result) && 'output' in result && result.output[0].type === 'chunk',
      'Expected a single production chunk',
    )

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

    const manifest = object(JSON.parse(await readFile(join(target, 'package.json'), 'utf8')))
    const dependencies = Object.fromEntries(
      await Promise.all(
        [...Object.keys(object(manifest.devDependencies)), 'vue'].map(
          async (name): Promise<[string, string]> => {
            const path =
              name === 'vue'
                ? vueRequire.resolve('vue/package.json')
                : join(target, 'node_modules', name, 'package.json')

            return [name, text(object(JSON.parse(await readFile(path, 'utf8'))).version)]
          },
        ),
      ),
    )

    const metadata: Metadata = {
      node: process.versions.node,
      rustc: execFileSync('rustc', ['--version'], { cwd: target, encoding: 'utf8' }).trim(),
      wasmBindgen: text(
        (await readFile(join(target, 'crates/liva_wasm/Cargo.toml'), 'utf8')).match(
          /^wasm-bindgen = "=([0-9.]+)"$/m,
        )?.[1],
      ),
      packageManager: text(manifest.packageManager),
      zlib: process.versions.zlib,
      brotli: text(process.versions.brotli),
      vite: version,
      rolldown: rolldownVersion,
      oxc: text(
        object(
          JSON.parse(
            await readFile(
              createRequire(createRequire(viteManifest).resolve('vite/package.json')).resolve(
                'oxc-transform/package.json',
              ),
              'utf8',
            ),
          ),
        ).version,
      ),
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

    return validateMeasurement(measurement)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

export async function specification(): Promise<Specification> {
  const parts = await Promise.all(
    ['Button.vue', 'main.ts'].map((name) => readFile(join(fixture, name))),
  )

  return {
    ...settings,
    fixture: digest(Buffer.concat(parts)),
    harness: digest(
      Buffer.concat(
        await Promise.all(
          ['measure.ts', 'model.ts', 'data.ts', 'types.ts'].map((name) =>
            readFile(new URL(name, import.meta.url)),
          ),
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
