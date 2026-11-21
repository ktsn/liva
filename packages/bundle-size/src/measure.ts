import type { Plugin } from 'vite-plus'
import { array, object, text } from './data.ts'
import { validateMeasurement } from './model.ts'
import type { Bytes, Measurement, Metadata, Specification } from './types.ts'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { brotliCompressSync, constants, gzipSync } from 'node:zlib'

import { settings } from './model.ts'

export { settings }
export const digest = (bytes: string | Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex')
const fixture = join(import.meta.dirname, '../fixture')

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
// are checked by the build and output inspection, not substituted from head.
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

/** Target must have its own frozen dependencies, compiler WASM, and any package build outputs. */
export async function measure(target: string, sha: string, output?: string): Promise<Measurement> {
  assert.equal(process.versions.node, settings.node, `Use Node ${settings.node}`)

  const require = createRequire(join(target, 'package.json'))
  const playgroundRequire = createRequire(join(target, 'playground/package.json'))
  const runtime = playgroundRequire.resolve('@liva/runtime')
  const vueRuntime = playgroundRequire.resolve('@liva/vue/runtime')
  const plugin = playgroundRequire.resolve('@liva/vite')
  const viteManifest = require.resolve('vite-plus/package.json')
  const builder: unknown = await import(
    pathToFileURL(join(dirname(viteManifest), 'dist/index.js')).href
  )
  const vuePlugin: unknown = await import(
    pathToFileURL(require.resolve('@vizejs/vite-plugin')).href
  )
  const livaPlugin: unknown = await import(pathToFileURL(plugin).href)

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
          { find: /^@liva\/runtime$/, replacement: runtime },
          { find: '@liva/vue/runtime', replacement: vueRuntime },
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
      dirname(vueRuntime) + '/',
      dirname(runtime) + '/',
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
