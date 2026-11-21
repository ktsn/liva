import {
  planPresence,
  PresenceError,
  generatedPresence,
  presenceAliasAttribute,
} from './presence.ts'
import { fileURLToPath } from 'node:url'
import { emitFeatures } from './features.ts'
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

const pluginEntry = fileURLToPath(import.meta.url)
const compiledVue = '@liva/vue/compiled'

type TransformContext = Pick<Rollup.TransformPluginContext, 'error' | 'warn'>

export default function liva(): Plugin {
  let server: ViteDevServer | undefined
  let editor: EditorService | undefined
  const valid = new Map<string, SourceSnapshot>()

  const blocks = new Map<string, { source: string; result: Compilation }>()
  const rejectedPresence = new Map<string, string>()

  const remember = (file: string, snapshot: SourceSnapshot) => {
    rejectedPresence.delete(file)
    valid.set(file, snapshot)
    blocks.set(file, { source: snapshot.block, result: snapshot.result })
  }

  const preprocess = (context: TransformContext, source: string, file: string) => {
    if (!hasLivaBlock(source, file)) return undefined

    const previous = valid.get(file)
    const snapshot = previous?.source === source ? previous : compileSfc(source, file, !!server)

    const accepted = !hasErrors(snapshot)

    if (!accepted && !server) {
      const diagnostic = snapshot.result.diagnostics.find((d) => d.severity === 'error')!
      context.error({
        message: diagnostic.message,
        id: file,
        loc: diagnosticLocation(snapshot, diagnostic),
      })
    }

    const current = accepted ? snapshot : previous
    if (!current) return undefined

    try {
      const planned = planPresence(source, file, current.result.definitions)

      if (accepted) remember(file, snapshot)

      return planned
    } catch (error) {
      /* v8 ignore if -- @preserve: Presence planning reports authored errors as PresenceError; other exceptions are internal faults. */
      if (!(error instanceof PresenceError)) throw error

      const diagnostic = { message: error.message, id: file, loc: error.loc }

      if (!server || !previous) context.error(diagnostic)

      // Vue's HMR hooks can still request a module after a rejected update.
      // Keep its template, definitions, and generated imports on the same snapshot.
      rejectedPresence.set(file, snapshot.block)
      context.warn(diagnostic)

      return planPresence(previous.source, file, previous.result.definitions)
    }
  }

  const transformBlock = async (
    context: TransformContext,
    code: string,
    file: string,
    id: string,
    presenceIndex: number,
  ) => {
    const previous = blocks.get(file)
    const rejected = rejectedPresence.get(file) === code
    const reused = previous && (previous.source === code || rejected)
    let result = reused ? previous.result : compile(code, !!server)
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
    } else if (!reused) {
      blocks.set(file, { source: code, result })
    }

    const bundle = JSON.stringify({ schemaVersion: 3, definitions: result.definitions })
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029')
    const association = editor
      ? `component.livaSource = ${JSON.stringify(await editor.register(file))};`
      : ''
    const features = emitFeatures(result.definitions)
    const names = generatedPresence(presenceIndex)
    const assets = features.presence
      ? [
          `component.components = { ${JSON.stringify(names.component)}: LivaPresenceBoundary, ...component.components };`,
          `component.directives = { ${JSON.stringify(names.directive)}: livaEntry, ...component.directives };`,
          'component.livaPresenceBindings = PresenceBindings;',
        ].join(' ')
      : ''

    return {
      code: [
        "import { decodeBundle } from 'liva:runtime/model/definition';",
        features.imports,
        `const bundle = decodeBundle(${JSON.stringify(bundle)});`,
        `const features = ${features.motions};`,
        `export default (component) => { component.livaDefinitions = bundle.definitions; component.livaFeatures = features; ${assets} ${association} };`,
      ]
        .filter(Boolean)
        .join('\n'),
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
    async resolveId(id) {
      if (id === '@liva/vue') return '\0liva:vue-plugin'
      if (id === 'liva:vue/compiled' || id === compiledVue)
        return this.resolve(compiledVue, pluginEntry, { skipSelf: true })

      const feature = /^liva:(runtime|vue)\/([a-zA-Z0-9/-]+)$/.exec(id)

      if (!feature) return null

      const [, workspace, path] = feature
      const specifier = `@liva/${workspace}/features/${path}`

      if (workspace === 'vue') return this.resolve(specifier, pluginEntry, { skipSelf: true })

      // Vue imports @liva/runtime/core from this same package instance. Resolving
      // from the SFC or dereferencing symlinks in Node can split runtime identity.
      const anchor = await this.resolve(compiledVue, pluginEntry, { skipSelf: true })

      if (!anchor) throw new Error('Could not resolve the compiled Liva Vue entry')

      return this.resolve(specifier, anchor.id, { skipSelf: true })
    },
    load(id) {
      if (id === '\0liva:vue-plugin' && editor) {
        const client = '/@fs/' + fileURLToPath(new URL('./editor/client.ts', import.meta.url))
        return `export * from "@liva/vue/runtime"; import { createDevPlugin } from ${JSON.stringify(client)}; export default createDevPlugin(${JSON.stringify(editor.token)});`
      }
      if (id === '\0liva:vue-plugin')
        return `export * from "@liva/vue/runtime"; import { createCompiledLivaPlugin } from 'liva:vue/compiled'; export default createCompiledLivaPlugin();`
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

      const presenceIndex = Number(parameters.get(presenceAliasAttribute) ?? 0)

      return transformBlock(this, code, file, id, presenceIndex)
    },
    async handleHotUpdate(context) {
      if (!context.file.endsWith('.vue')) return undefined
      const source = await context.read()
      if (!hasLivaBlock(source, context.file)) return undefined

      let sourceId: string | undefined
      let snapshot: SourceSnapshot | undefined

      try {
        sourceId = await editor?.register(context.file)

        /* v8 ignore else -- @preserve: configureServer installs the editor before Vite invokes hot-update hooks. */
        if (sourceId)
          server?.ws.send({
            type: 'custom',
            event: 'liva:source-changed',
            data: { sourceId },
          })
        snapshot = compileSfc(source, context.file, true)
        if (hasErrors(snapshot)) {
          server?.ws.send({
            type: 'custom',
            event: 'liva:diagnostics',
            data: { sourceId, diagnostics: snapshot.result.diagnostics },
          })
          return []
        }
        // Preserve the previous definition and loader together if the updated
        // template cannot install its authored lifecycle boundaries.
        planPresence(source, context.file, snapshot.result.definitions)
        remember(context.file, snapshot)
      } catch (error) {
        if (error instanceof PresenceError && snapshot && valid.has(context.file))
          rejectedPresence.set(context.file, snapshot.block)

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
