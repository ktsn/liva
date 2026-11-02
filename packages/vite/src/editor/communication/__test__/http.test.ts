import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type ViteDevServer } from 'vite-plus'
import { EditorService } from '../server.ts'
import { request as httpRequest } from 'node:http'
import { createConnection } from 'node:net'
import { createEditorTransport } from '../client.ts'

let root: string
let server: ViteDevServer
let service: EditorService
let sourceId: string
let origin: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'liva-http-'))

  const file = join(root, 'Motion.vue')

  await writeFile(
    file,
    '<template><div /></template><liva>motion fade { state idle { box { opacity: 1 } } }</liva>',
  )
  service = new EditorService(root)
  sourceId = await service.register(file)
  server = await createServer({
    configFile: false,
    root,
    server: { host: '127.0.0.1', port: 0 },
    logLevel: 'silent',
    plugins: [
      {
        name: 'editor-test',
        configureServer(devServer) {
          service.install(devServer)
        },
      },
    ],
  })
  await server.listen()

  const address = server.httpServer?.address()

  if (!address || typeof address === 'string') throw new Error('Expected an HTTP listener')

  origin = `http://127.0.0.1:${address.port}`
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await server.close()
  await rm(root, { recursive: true, force: true })
})

function request(body: unknown, headers: Record<string, string> = {}) {
  return fetch(origin + '/__liva/editor', {
    method: 'POST',
    headers: {
      origin,
      'content-type': 'application/json',
      'x-liva-session': service.token,
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

describe('editor HTTP boundary', () => {
  it('returns an inspection with cache prevention', async () => {
    const response = await request({ action: 'inspect', sourceId, definition: 'fade' })

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('content-type')).toBe('application/json')
    expect(await response.json()).toMatchObject({ definition: { name: 'fade' } })
  })

  it.each<Record<string, string>>([
    { origin: 'https://example.com' },
    { 'x-liva-session': '' },
    { 'x-liva-session': 'x'.repeat(36) },
  ])('rejects unauthorized headers %j', async (headers) => {
    const response = await request({}, headers)

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({
      error: 'Editor requires the active same-origin local session',
    })
  })

  it('rejects methods, content types, malformed JSON and invalid requests', async () => {
    expect((await fetch(origin + '/__liva/editor')).status).toBe(405)
    expect((await request({}, { 'content-type': 'text/plain' })).status).toBe(415)
    expect((await request('{')).status).toBe(400)
    expect((await request({ action: 'delete' })).status).toBe(400)
    expect((await request(' '.repeat(65537))).status).toBe(413)
    expect(
      (await request({ action: 'inspect', sourceId: 'missing', definition: 'fade' })).status,
    ).toBe(404)
  })

  it('returns an internal error when a registered source disappears', async () => {
    await rm(join(root, 'Motion.vue'))

    const response = await request({ action: 'inspect', sourceId, definition: 'fade' })

    expect(response.status).toBe(500)
    expect((await response.json()).error).toContain('ENOENT')
  })
})

it('transports editor requests and surfaces server errors', async () => {
  const nativeFetch = globalThis.fetch

  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    const headers = new Headers(init.headers)

    headers.set('origin', origin)
    return nativeFetch(new URL(url, origin), { ...init, headers })
  })

  const transport = createEditorTransport(service.token)

  expect(await transport({ action: 'inspect', sourceId, definition: 'fade' })).toMatchObject({
    definition: { name: 'fade' },
  })
  await expect(
    transport({ action: 'inspect', sourceId: 'missing', definition: 'fade' }),
  ).rejects.toThrow('Unknown source identity')
})

it('rejects oversized chunked bodies without relying on Content-Length', async () => {
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const outgoing = httpRequest(
      origin + '/__liva/editor',
      {
        method: 'POST',
        headers: {
          origin,
          'content-type': 'application/json',
          'x-liva-session': service.token,
          'transfer-encoding': 'chunked',
        },
      },
      (response) => {
        response.resume()
        response.on('end', () => resolve(response.statusCode))
      },
    )

    outgoing.on('error', reject)
    outgoing.end(' '.repeat(65537))
  })

  expect(status).toBe(413)
})

it.each([
  [undefined, 400],
  ['example.com', 403],
] as const)('rejects an unauthorized Host header %s', async (host, expectedStatus) => {
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const outgoing = httpRequest(
      origin + '/__liva/editor',
      {
        method: 'POST',
        setHost: false,
        headers: {
          ...(host ? { host } : {}),
          origin,
          'content-type': 'application/json',
          'x-liva-session': service.token,
        },
      },
      (response) => {
        response.resume()
        response.on('end', () => resolve(response.statusCode))
      },
    )

    outgoing.on('error', reject)
    outgoing.end('{}')
  })

  expect(status).toBe(expectedStatus)
})

it('rejects an HTTP/1.0 request without Host at the editor boundary', async () => {
  const reply = await new Promise<string>((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port: Number(new URL(origin).port) })
    let text = ''

    socket.setEncoding('utf8')
    socket.on('data', (chunk) => {
      text += chunk
    })
    socket.on('error', reject)
    socket.on('end', () => resolve(text))
    socket.on('connect', () =>
      socket.end(
        `POST /__liva/editor HTTP/1.0\r\nContent-Type: application/json\r\nContent-Length: 2\r\nOrigin: ${origin}\r\nX-Liva-Session: ${service.token}\r\n\r\n{}`,
      ),
    )
  })

  expect(reply).toMatch(/^HTTP\/1\.1 403/)
})
