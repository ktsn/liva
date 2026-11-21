import assert from 'node:assert/strict'
import { array, object, text } from '../../../data.ts'

export let version: unknown = '8.3.7'
export let rolldownVersion: unknown = '1.2.18'
export let build: unknown = (config: unknown) => output(config)

export function configure(run: (config: unknown) => Promise<unknown>) {
  version = '8.3.7'
  rolldownVersion = '1.2.18'
  build = (config: unknown) => run(config)
}

export function setApi(values: { build?: unknown; version?: unknown; rolldownVersion?: unknown }) {
  if ('build' in values) build = values.build
  if ('version' in values) version = values.version
  if ('rolldownVersion' in values) rolldownVersion = values.rolldownVersion
}

export async function output(
  config: unknown,
  options: {
    code?: string
    definition?: boolean
    duplicate?: boolean
    generate?: boolean
    modules?: Record<string, { renderedLength: number }>
    extraModules?: Record<string, { renderedLength: number }>
    imports?: readonly string[]
    dynamicImports?: readonly string[]
    type?: string
    extraChunk?: boolean
    result?: unknown
  } = {},
): Promise<unknown> {
  const input = object(config)
  const root = text(input.root)
  const runtime = text(object(array(object(input.resolve).alias)[0]).replacement)
  const target = runtime.slice(0, -'/packages/runtime/src/index.ts'.length)
  const observer = object(array(input.plugins).at(-1))
  const transform = observer.transform
  const generate = observer.generateBundle

  assert(typeof transform === 'function' && typeof generate === 'function')

  const ast = {
    body: [
      {
        type: 'VariableDeclaration',
        declarations: [
          {
            id: { name: 'bundle' },
            init: {
              arguments: [{ type: 'Literal', value: '{"definitions":[{"label":"é"}]}' }],
            },
          },
        ],
      },
    ],
  }

  Reflect.apply(transform, { parse: () => ast }, ['', `${root}/main.ts`])

  if (options.definition !== false) {
    Reflect.apply(transform, { parse: () => ast }, ['', `${root}/Button.vue?type=liva`])
  }

  if (options.duplicate) {
    Reflect.apply(transform, { parse: () => ast }, ['', `${root}/Button.vue?type=liva`])
  }

  const chunk = {
    type: options.type ?? 'chunk',
    code: options.code ?? 'export const message="hello é";',
    imports: options.imports ?? ['vue'],
    dynamicImports: options.dynamicImports ?? [],
    modules: options.modules ?? {
      [runtime]: { renderedLength: 10 },
      [`${target}/packages/vue/src/runtime.ts`]: { renderedLength: 10 },
      [`${root}/Button.vue?type=liva`]: { renderedLength: 10 },
      [`${root}/Button.vue`]: { renderedLength: 10 },
      '\0liva:vue-plugin': { renderedLength: 10 },
      '/unused.ts': { renderedLength: 0 },
      ...options.extraModules,
    },
  }
  const bundle = options.extraChunk ? { first: chunk, second: chunk } : { first: chunk }

  if (options.generate !== false) Reflect.apply(generate, {}, [{}, bundle])

  return options.result ?? { output: [chunk] }
}
