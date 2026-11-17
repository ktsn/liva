import { planPresence, PresenceError } from './presence.ts'
import { fileURLToPath } from 'node:url'
import { EditorService } from './editor/communication/server.ts'
import type { Plugin, Rollup, ViteDevServer } from 'vite-plus'
import {
  compile,
  compileSfc,
  type Compilation,
  diagnosticLocation,
  hasErrors,
  hasLivaBlock,
  type SourceSnapshot,
} from './compiler.ts'

type TransformContext = Pick<Rollup.TransformPluginContext, 'error' | 'warn'>

export default function liva(): Plugin {
  let server: ViteDevServer | undefined
  let editor: EditorService | undefined
  const valid = new Map<string, SourceSnapshot>()

  const blocks = new Map<string, { source: string; result: Compilation }>()

  const preprocess = (context: TransformContext, source: string, file: string) => {
    if (!hasLivaBlock(source, file)) return undefined

    const previous = valid.get(file)
    const snapshot = previous?.source === source ? previous : compileSfc(source, file, !!server)

    if (!hasErrors(snapshot)) {
      valid.set(file, snapshot)
      blocks.set(file, { source: snapshot.block, result: snapshot.result })
    }

    if (hasErrors(snapshot) && !server) {
      const diagnostic = snapshot.result.diagnostics.find((d) => d.severity === 'error')!
      context.error({
        message: diagnostic.message,
        id: file,
        loc: diagnosticLocation(snapshot, diagnostic),
      })
    }

    const current = valid.get(file)
    if (!current) return undefined

    try {
      return planPresence(source, file, current.result.definitions)
    } catch (error) {
      /* v8 ignore else -- @preserve: Presence planning reports authored errors as PresenceError; other exceptions are internal faults. */
      if (error instanceof PresenceError)
        context.error({ message: error.message, id: file, loc: error.loc })
      /* v8 ignore next -- @preserve: Vite's error hook throws for the handled PresenceError. */
      throw error
    }
  }

  const transformBlock = async (
    context: TransformContext,
    code: string,
    file: string,
    id: string,
  ) => {
    const previous = blocks.get(file)
    let result = previous?.source === code ? previous.result : compile(code, !!server)
    const diagnostic = result.diagnostics.find((d) => d.severity === 'error')

    if (diagnostic) {
      const error = {
        message: diagnostic.message,
        id,
        loc: diagnosticLocation({ source: code, blockStart: 0 }, diagnostic),
      }
      if (!server || !previous) context.error(error)
      context.warn(error)
      result = previous.result
    } else {
      blocks.set(file, { source: code, result })
    }

    const bundle = JSON.stringify({ schemaVersion: 3, definitions: result.definitions })
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029')
    const association = editor
      ? `component.livaSource = ${JSON.stringify(await editor.register(file))};`
      : ''
    return {
      code: `import { decodeBundle } from '@liva/runtime'; const bundle = decodeBundle(${JSON.stringify(bundle)}); export default (component) => { component.livaDefinitions = bundle.definitions; ${association} };`,
      map: null,
    }
  }

  return {
    name: 'liva',
    enforce: 'pre',
    config() {
      return { optimizeDeps: { exclude: ['@liva/vue'] } }
    },
    configureServer(devServer) {
      server = devServer
      editor = new EditorService(devServer.config.root)
      editor.install(devServer)
    },
    resolveId(id) {
      if (id === '@liva/vue') return '\0liva:vue-plugin'
      return null
    },
    load(id) {
      if (id === '\0liva:vue-plugin' && editor) {
        const client = '/@fs/' + fileURLToPath(new URL('./editor/client.ts', import.meta.url))
        return `export * from "@liva/vue/runtime"; import { createDevPlugin } from ${JSON.stringify(client)}; export default createDevPlugin(${JSON.stringify(editor.token)});`
      }
      if (id === '\0liva:vue-plugin')
        return `export * from "@liva/vue/runtime"; import { createLivaPlugin } from '@liva/vue/runtime'; export default createLivaPlugin();`
      return null
    },
    async transform(code, id) {
      const [file, query = ''] = id.split('?', 2)
      const parameters = new URLSearchParams(query)
      if (!file.endsWith('.vue')) return undefined
      if (['raw', 'url', 'worker', 'sharedworker'].some((name) => parameters.has(name)))
        return undefined

      if (!parameters.has('type')) return preprocess(this, code, file)

      if (!parameters.has('vue') || parameters.get('type') !== 'liva') return undefined

      return transformBlock(this, code, file, id)
    },
    async handleHotUpdate(context) {
      if (!context.file.endsWith('.vue')) return undefined
      const source = await context.read()
      if (!hasLivaBlock(source, context.file)) return undefined

      let sourceId: string | undefined

      try {
        sourceId = await editor?.register(context.file)

        /* v8 ignore else -- @preserve: configureServer installs the editor before Vite invokes hot-update hooks. */
        if (sourceId)
          server?.ws.send({
            type: 'custom',
            event: 'liva:source-changed',
            data: { sourceId },
          })
        const snapshot = compileSfc(source, context.file, true)
        if (hasErrors(snapshot)) {
          server?.ws.send({
            type: 'custom',
            event: 'liva:diagnostics',
            data: { sourceId, diagnostics: snapshot.result.diagnostics },
          })
          return []
        }
        valid.set(context.file, snapshot)
      } catch (error) {
        server?.ws.send({
          type: 'custom',
          event: 'liva:diagnostics',
          data: { sourceId, diagnostics: [{ message: String(error) }] },
        })
        return []
      }
      return undefined
    },
  }
}
