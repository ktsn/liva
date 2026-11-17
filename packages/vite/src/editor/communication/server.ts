import { isEditorRequest } from './protocol.ts'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { readFile, realpath, stat, writeFile, rename, unlink, mkdir } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ViteDevServer } from 'vite-plus'
import { applyEdits, compileSfc, hash, hasErrors, type SourceSnapshot } from '../../compiler.ts'
import type { EditorRequest, EditorReply, Inspection } from './protocol.ts'

export class EditorError extends Error {
  readonly status: number

  constructor(status: number, message: string, options?: ErrorOptions) {
    super(message, options)
    this.status = status
  }
}

const MAX_BODY = 64 * 1024

export class EditorService {
  readonly token = randomUUID()
  private paths = new Map<string, string>()
  private locks = new Map<string, Promise<void>>()
  private inFlight = new Map<string, { signature: string; promise: Promise<EditorReply> }>()
  private saved = new Map<string, { signature: string; reply: EditorReply }>()
  private root: Promise<string>

  constructor(root: string) {
    this.root = realpath(root)
  }

  private async contained(file: string): Promise<string> {
    const canonical = await realpath(file)
    const local = relative(await this.root, canonical)
    if (!local || local.startsWith('..') || isAbsolute(local) || !canonical.endsWith('.vue')) {
      throw new EditorError(403, 'Source is outside the editable project root')
    }
    return canonical
  }

  async register(file: string): Promise<string> {
    const canonical = await this.contained(file)
    const id = hash(canonical)
    this.paths.set(id, canonical)
    return id
  }

  private async snapshot(id: string): Promise<{ file: string; snapshot: SourceSnapshot }> {
    const known = this.paths.get(id)
    /* v8 ignore if -- @preserve: request validates this identity and registered paths are never removed. */
    if (!known) throw new EditorError(404, 'Unknown source identity')
    const file = await this.contained(known)
    if (file !== known) throw new EditorError(409, 'Source identity changed')
    const snapshot = compileSfc(await readFile(file, 'utf8'), file, true)
    if (hasErrors(snapshot))
      throw new EditorError(422, 'Source has compilation errors; fix source before editing')
    return { file, snapshot }
  }

  private inspection(snapshot: SourceSnapshot, name: string): Inspection {
    const definition = snapshot.result.definitions.find((d) => d.name === name)
    if (!definition) throw new EditorError(404, 'Unknown definition')
    const bytes = Buffer.from(snapshot.block)
    const fields = Object.entries(
      /* v8 ignore next -- @preserve: Development compilation always includes source mappings. */ snapshot
        .result.mappings ?? {},
    )
      .filter(([path]) => path === name || path.startsWith(`${name}/`))
      .map(([path, field]) => ({
        path,
        kind: field.kind,
        range: field.range,
        value:
          field.kind === 'value' || field.kind === 'layout-value'
            ? bytes.subarray(field.range.start, field.range.end).toString().trim()
            : '',
      }))
    return { hash: snapshot.hash, definition, fields }
  }

  private candidate(snapshot: SourceSnapshot, request: EditorRequest): SourceSnapshot {
    if (!Array.isArray(request.edits) || request.edits.length > 100)
      throw new EditorError(400, 'Invalid edit list')

    for (const edit of request.edits) {
      /* v8 ignore if -- @preserve: isEditorRequest validates each edit before the HTTP boundary calls request. */
      if (!edit || typeof edit !== 'object') throw new EditorError(400, 'Invalid edit')
      if (typeof edit.path !== 'string' || !edit.path.startsWith(`${request.definition}/`)) {
        throw new EditorError(403, 'Edits must stay within the selected definition')
      }
    }

    let changed: ReturnType<typeof applyEdits>
    try {
      changed = applyEdits(snapshot.block, request.edits)
    } catch (error) {
      throw new EditorError(422, String(error), { cause: error })
    }
    const bytes = Buffer.from(snapshot.source)
    const source = Buffer.concat([
      bytes.subarray(0, snapshot.blockStart),
      Buffer.from(changed.source),
      bytes.subarray(snapshot.blockStart + Buffer.byteLength(snapshot.block)),
    ]).toString()
    const candidate = compileSfc(source, 'candidate.vue', true)
    /* v8 ignore if -- @preserve: applyEdits rejects compilation errors before returning a successful edit. */
    if (hasErrors(candidate)) throw new EditorError(422, 'Edited source failed validation')
    return candidate
  }

  async request(request: EditorRequest): Promise<EditorReply> {
    /* v8 ignore if -- @preserve: The HTTP boundary checks isEditorRequest; direct callers pass the typed request. */
    if (
      !request ||
      typeof request.sourceId !== 'string' ||
      typeof request.definition !== 'string' ||
      !['inspect', 'preview', 'commit'].includes(request.action)
    )
      throw new EditorError(400, 'Invalid editor request')
    const known = this.paths.get(request.sourceId)
    if (!known) throw new EditorError(404, 'Unknown source identity')

    if (request.action === 'commit') {
      if (
        typeof request.requestId !== 'string' ||
        request.requestId.length < 8 ||
        request.requestId.length > 100
      )
        throw new EditorError(400, 'Invalid commit request ID')
      const signature = hash(JSON.stringify(request))
      const inFlight = this.inFlight.get(request.requestId)
      if (inFlight) {
        if (inFlight.signature !== signature)
          throw new EditorError(409, 'Request ID was already used for a different transaction')
        return inFlight.promise
      }
      const previous = this.locks.get(known) ?? Promise.resolve()
      const next = previous.then(() => this.execute(request))
      this.inFlight.set(request.requestId, { signature, promise: next })
      const barrier = next.then(
        () => undefined,
        () => undefined,
      )
      this.locks.set(known, barrier)
      try {
        return await next
      } finally {
        this.inFlight.delete(request.requestId)
        if (this.locks.get(known) === barrier) this.locks.delete(known)
      }
    }

    return this.execute(request)
  }

  private async execute(request: EditorRequest): Promise<EditorReply> {
    const signature = hash(JSON.stringify(request))
    if (request.action === 'commit') {
      /* v8 ignore if -- @preserve: Repeated assertion of the commit identity validated by request before enqueueing. */
      if (
        typeof request.requestId !== 'string' ||
        request.requestId.length < 8 ||
        request.requestId.length > 100
      )
        throw new EditorError(400, 'Invalid commit request ID')
      const saved = this.saved.get(request.requestId)
      if (saved) {
        if (saved.signature !== signature)
          throw new EditorError(409, 'Request ID was already used for a different transaction')
        return saved.reply
      }
    }

    const { file, snapshot } = await this.snapshot(request.sourceId)
    const original = this.inspection(snapshot, request.definition)
    if (request.action === 'inspect') return original
    if (request.baseHash !== snapshot.hash)
      throw new EditorError(409, 'Source changed; inspect the latest revision before saving')
    const candidate = this.candidate(snapshot, request)
    const reply = this.inspection(candidate, request.definition)

    if (request.action === 'preview') {
      if (
        typeof request.instanceId !== 'string' ||
        request.instanceId.length > 100 ||
        !Number.isSafeInteger(request.sequence) ||
        request.sequence! < 0
      )
        throw new EditorError(400, 'Invalid preview identity or sequence')
      return { ...reply, hash: original.hash, sequence: request.sequence }
    }

    const temporary = resolve(dirname(file), `.${basename(file)}.${randomUUID()}.liva.tmp`)
    const backups = resolve(await this.root, '.liva-backups')
    try {
      await mkdir(backups, { recursive: true })
      if ((await realpath(backups)) !== backups)
        throw new EditorError(403, 'Backup directory must not be a symlink')
      const metadata = await stat(file)
      await writeFile(resolve(backups, `${snapshot.hash}.vue`), snapshot.source, {
        flag: 'wx',
        mode: 0o600,
      }).catch((error: NodeJS.ErrnoException) => {
        /* v8 ignore if -- @preserve: Non-EEXIST filesystem failures are propagated unchanged; testing them only asserts an injected OS error. */
        if (error.code !== 'EEXIST') throw error
      })
      await writeFile(temporary, candidate.source, { flag: 'wx', mode: metadata.mode })
      if (
        (await this.contained(file)) !== file ||
        hash(await readFile(file, 'utf8')) !== snapshot.hash
      )
        throw new EditorError(409, 'Source changed while preparing the save')
      await rename(temporary, file)
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        /* v8 ignore if -- @preserve: Non-ENOENT filesystem failures are propagated unchanged; cleanup behavior is tested with real files. */
        if (error.code !== 'ENOENT') throw error
      })
    }

    this.saved.set(request.requestId!, { signature, reply })
    if (this.saved.size > 512) this.saved.delete(this.saved.keys().next().value!)
    return reply
  }

  install(server: ViteDevServer) {
    server.middlewares.use('/__liva/editor', (request, response) => {
      void this.handle(request, response, server).catch((error: unknown) => {
        response.statusCode = error instanceof EditorError ? error.status : 500
        response.setHeader('Content-Type', 'application/json')
        response.end(
          JSON.stringify({
            error:
              error instanceof Error
                ? error.message
                : /* v8 ignore next -- @preserve: Internal and Node APIs throw Error objects. */ 'Editor request failed',
          }),
        )
      })
    })
  }

  private async handle(request: IncomingMessage, response: ServerResponse, server: ViteDevServer) {
    response.setHeader('Cache-Control', 'no-store')
    if (request.method !== 'POST') throw new EditorError(405, 'POST required')
    const address = server.httpServer?.address()
    const port =
      typeof address === 'object' && address
        ? address.port
        : /* v8 ignore next -- @preserve: The installed HTTP server listens on a TCP port; non-TCP servers cannot authorize an editor request. */ undefined
    const hosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`])
    const remote = request.socket.remoteAddress
    const token = request.headers['x-liva-session']
    if (
      !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(
        /* v8 ignore next -- @preserve: Active incoming TCP sockets have a remote address. */ remote ??
          '',
      ) ||
      !hosts.has(request.headers.host ?? '') ||
      request.headers.origin !== `http://${request.headers.host}` ||
      typeof token !== 'string' ||
      Buffer.byteLength(token) !== Buffer.byteLength(this.token) ||
      !timingSafeEqual(Buffer.from(token), Buffer.from(this.token))
    ) {
      throw new EditorError(403, 'Editor requires the active same-origin local session')
    }
    if (request.headers['content-type']?.split(';')[0] !== 'application/json')
      throw new EditorError(415, 'JSON required')
    if (Number(request.headers['content-length']) > MAX_BODY)
      throw new EditorError(413, 'Editor request is too large')
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of request) {
      const bytes = Buffer.from(chunk)
      size += bytes.length
      if (size > MAX_BODY) throw new EditorError(413, 'Editor request is too large')
      chunks.push(bytes)
    }

    let data: unknown
    try {
      data = JSON.parse(Buffer.concat(chunks).toString())
    } catch {
      throw new EditorError(400, 'Invalid JSON')
    }
    if (!isEditorRequest(data)) throw new EditorError(400, 'Invalid editor request')

    const result = await this.request(data)
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify(result))
  }
}
