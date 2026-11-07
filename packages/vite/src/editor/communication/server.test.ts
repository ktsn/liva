import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { mkdtemp, readFile, writeFile, rm, symlink, unlink, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EditorService } from './server.ts'
import type { EditorRequest } from './protocol.ts'

vi.mock('node:fs/promises', { spy: true })

let root: string
let outside: string
let service: EditorService
let sourceId: string
let source: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'liva-editor-'))
  outside = await mkdtemp(join(tmpdir(), 'liva-outside-'))
  source = `<script setup>const label = '😀日本語'</script>\r\n<template><div>{{ label }}</div></template>\r\n<liva>\r\n${(await readFile(new URL('../../../../../fixtures/toggle.liv', import.meta.url), 'utf8')).replaceAll('\n', '\r\n')}</liva>\r\n`
  await writeFile(join(root, 'Toggle.vue'), source)
  service = new EditorService(root)
  sourceId = await service.register(join(root, 'Toggle.vue'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

async function request(action: 'preview' | 'commit', duration = '500ms'): Promise<EditorRequest> {
  const inspection = await service.request({ action: 'inspect', sourceId, definition: 'toggle' })
  return {
    action,
    sourceId,
    definition: 'toggle',
    baseHash: inspection.hash,
    instanceId: 'instance-1',
    sequence: 1,
    requestId: crypto.randomUUID(),
    edits: [{ op: 'set', path: 'toggle/transition/general/timing/duration', value: duration }],
  }
}

describe('guarded source transactions', () => {
  it('previews without writes and saves only intended UTF-8 bytes with recovery backup', async () => {
    const preview = await request('preview')
    const result = await service.request(preview)
    expect(result.definition.generalTransition?.timing).toMatchObject({ durationMs: 500 })
    expect(await readFile(join(root, 'Toggle.vue'), 'utf8')).toBe(source)
    expect(await readdir(root)).toEqual(['Toggle.vue'])

    const committed = await service.request({ ...preview, action: 'commit' })
    expect(committed.hash).not.toBe(preview.baseHash)
    expect(await readFile(join(root, 'Toggle.vue'), 'utf8')).toBe(source.replace('350ms', '500ms'))
    expect(await readFile(join(root, '.liva-backups', `${preview.baseHash}.vue`), 'utf8')).toBe(
      source,
    )
  })

  it('rejects stale full-file hashes and invalid edits without changing source', async () => {
    const stale = await request('commit')
    const changed = source.replace('const label', 'const otherLabel')
    await writeFile(join(root, 'Toggle.vue'), changed)
    await expect(service.request(stale)).rejects.toMatchObject({ status: 409 })
    expect(await readFile(join(root, 'Toggle.vue'), 'utf8')).toBe(changed)

    const invalid = await request('commit', '-5ms')
    await expect(service.request(invalid)).rejects.toMatchObject({ status: 422 })
    expect(await readFile(join(root, 'Toggle.vue'), 'utf8')).toBe(changed)
  })

  it('serializes concurrent commits and deduplicates request IDs', async () => {
    const first = await request('commit')
    const second = await request('commit', '600ms')
    const results = await Promise.allSettled([service.request(first), service.request(second)])
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected'])
    const saved = await readFile(join(root, 'Toggle.vue'), 'utf8')
    const initial = results[0]
    if (initial.status !== 'fulfilled') throw initial.reason

    expect(await service.request(first)).toEqual(initial.value)
    expect(await readFile(join(root, 'Toggle.vue'), 'utf8')).toBe(saved)
    await expect(service.request({ ...first, edits: second.edits })).rejects.toMatchObject({
      status: 409,
    })
  })

  it('rejects unknown paths, outside-root sources, and symlink replacements', async () => {
    await writeFile(join(outside, 'Outside.vue'), source)
    await expect(service.register(join(outside, 'Outside.vue'))).rejects.toMatchObject({
      status: 403,
    })
    await symlink(join(outside, 'Outside.vue'), join(root, 'Link.vue'))
    await expect(service.register(join(root, 'Link.vue'))).rejects.toMatchObject({ status: 403 })
    const commit = await request('commit')
    await unlink(join(root, 'Toggle.vue'))
    await symlink(join(outside, 'Outside.vue'), join(root, 'Toggle.vue'))
    await expect(service.request(commit)).rejects.toMatchObject({ status: 403 })
    await expect(
      service.request({ action: 'inspect', sourceId: '../Outside.vue', definition: 'toggle' }),
    ).rejects.toMatchObject({ status: 404 })
    expect(await readFile(join(outside, 'Outside.vue'), 'utf8')).toBe(source)
  })

  it('rejects cross-definition edits', async () => {
    const commit = await request('commit')
    commit.edits = [{ op: 'set', path: 'other/transition/general/timing', value: '@tween: 5ms' }]
    await expect(service.request(commit)).rejects.toMatchObject({ status: 403 })
  })
  it('reserves request identities across concurrent files', async () => {
    await writeFile(join(root, 'Other.vue'), source)
    const otherId = await service.register(join(root, 'Other.vue'))
    const first = await request('commit')
    const results = await Promise.allSettled([
      service.request(first),
      service.request({ ...first, sourceId: otherId }),
      service.request(first),
    ])
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected', 'fulfilled'])
    expect(results[0]).toEqual(results[2])
    expect(await readFile(join(root, 'Other.vue'), 'utf8')).toBe(source)
  })
})

it('validates preview identity, commit IDs, edit limits and definition scope', async () => {
  const preview = await request('preview')

  for (const patch of [
    { instanceId: undefined },
    { instanceId: 'x'.repeat(101) },
    { sequence: -1 },
    { sequence: 0.5 },
  ]) {
    await expect(service.request({ ...preview, ...patch })).rejects.toMatchObject({ status: 400 })
  }

  for (const requestId of [undefined, 'short', 'x'.repeat(101)]) {
    await expect(
      service.request({ ...preview, action: 'commit', requestId }),
    ).rejects.toMatchObject({ status: 400 })
  }

  await expect(service.request({ ...preview, edits: undefined })).rejects.toMatchObject({
    status: 400,
  })
  await expect(
    service.request({ ...preview, edits: Array.from({ length: 101 }, () => preview.edits![0]) }),
  ).rejects.toMatchObject({ status: 400 })
  await expect(
    service.request({ ...preview, edits: [{ op: 'set', path: 'other/value', value: '1' }] }),
  ).rejects.toMatchObject({ status: 403 })
  await expect(
    service.request({
      ...preview,
      edits: [
        {
          op: 'override',
          definition: 'other',
          from: 'off',
          to: 'on',
          target: 'thumb',
          property: 'scale',
          timing: '@tween: 1s',
        },
      ],
    }),
  ).rejects.toMatchObject({ status: 403 })
  await expect(
    service.request({ action: 'inspect', sourceId, definition: 'missing' }),
  ).rejects.toMatchObject({ status: 404 })
})

it('deduplicates in-flight transactions and rejects conflicting request identities', async () => {
  const commit = await request('commit')
  const first = service.request(commit)
  const duplicate = service.request(commit)

  await expect(service.request({ ...commit, edits: [] })).rejects.toMatchObject({ status: 409 })
  expect(await duplicate).toEqual(await first)
})

it('rejects non-Vue paths, project roots and invalid registered sources', async () => {
  await expect(service.register(root)).rejects.toMatchObject({ status: 403 })

  const text = join(root, 'notes.txt')

  await writeFile(text, source)

  await expect(service.register(text)).rejects.toMatchObject({ status: 403 })

  await writeFile(join(root, 'Toggle.vue'), '<template><div /></template><liva>motion {</liva>')

  await expect(
    service.request({ action: 'inspect', sourceId, definition: 'toggle' }),
  ).rejects.toMatchObject({ status: 422 })
})

it('refuses symlinked backup directories and preserves the source', async () => {
  const commit = await request('commit')

  await symlink(outside, join(root, '.liva-backups'))

  await expect(service.request(commit)).rejects.toMatchObject({ status: 403 })
  expect(await readFile(join(root, 'Toggle.vue'), 'utf8')).toBe(source)
  expect(await readdir(outside)).toEqual([])
})

it('rejects a registered source replaced with an in-project symlink', async () => {
  await writeFile(join(root, 'Other.vue'), source)
  await unlink(join(root, 'Toggle.vue'))
  await symlink(join(root, 'Other.vue'), join(root, 'Toggle.vue'))

  await expect(
    service.request({ action: 'inspect', sourceId, definition: 'toggle' }),
  ).rejects.toMatchObject({ status: 409 })
})

it('reuses an existing backup when saving the same source revision again', async () => {
  const first = await request('commit')

  await service.request(first)
  await writeFile(join(root, 'Toggle.vue'), source)
  await service.request({ ...first, requestId: crypto.randomUUID() })

  expect(await readdir(join(root, '.liva-backups'))).toEqual([`${first.baseHash}.vue`])
  expect(await readFile(join(root, '.liva-backups', `${first.baseHash}.vue`), 'utf8')).toBe(source)
})

it('evicts the oldest commit identity after the bounded retry history fills', async () => {
  const first = { ...(await request('commit')), edits: [] }

  await service.request(first)

  for (let index = 0; index < 512; index++) {
    await service.request({ ...first, requestId: crypto.randomUUID() })
  }

  const changed = await service.request({
    ...first,
    edits: [{ op: 'set', path: 'toggle/transition/general/timing/duration', value: '600ms' }],
  })

  expect(changed.definition.generalTransition?.timing).toMatchObject({ durationMs: 600 })
})

it('does not overwrite an external edit made while the temporary save is being written', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  const commit = await request('commit')
  const external = source.replace('const label', 'const externalLabel')

  vi.mocked(writeFile).mockImplementation(async (...args: Parameters<typeof writeFile>) => {
    await actual.writeFile(...args)

    if (typeof args[0] === 'string' && args[0].endsWith('.liva.tmp'))
      await actual.writeFile(join(root, 'Toggle.vue'), external)
  })

  try {
    await expect(service.request(commit)).rejects.toMatchObject({ status: 409 })
    expect(await readFile(join(root, 'Toggle.vue'), 'utf8')).toBe(external)
    expect((await readdir(root)).filter((name) => name.endsWith('.liva.tmp'))).toEqual([])
  } finally {
    vi.mocked(writeFile).mockImplementation(actual.writeFile)
  }
})

it.each([
  'motion toggle { layer base { body { opacity: 1 } } }',
  'motion toggle { state idle { body @tween(duration: 100) { opacity: 1 } } }',
  'motion toggle { state idle { body { opacity: 1 } } enter { body { opacity { @tween: 100ms; 0%: 0 @easeIn } } } }',
])('keeps new syntax inspectable but rejects legacy timeline mutations: %s', async (motion) => {
  const content = `<template><div /></template><liva>${motion}</liva>`
  await writeFile(join(root, 'Toggle.vue'), content)
  const inspection = await service.request({ action: 'inspect', sourceId, definition: 'toggle' })

  for (const action of ['preview', 'commit'] as const) {
    await expect(
      service.request({
        action,
        sourceId,
        definition: 'toggle',
        baseHash: inspection.hash,
        requestId: crypto.randomUUID(),
        instanceId: 'instance',
        sequence: 1,
        edits: [{ op: 'set', path: 'toggle/unsupported', value: '2' }],
      }),
    ).rejects.toThrow('read-only')
  }

  expect(await readFile(join(root, 'Toggle.vue'), 'utf8')).toBe(content)
})

async function layerPreview() {
  const content =
    '<template><div /></template><liva>motion toggle { layer base { body { opacity: 1 } } }</liva>'
  await writeFile(join(root, 'Toggle.vue'), content)
  const inspection = await service.request({ action: 'inspect', sourceId, definition: 'toggle' })
  const previewRequest: EditorRequest = {
    action: 'preview',
    sourceId,
    definition: 'toggle',
    baseHash: inspection.hash,
    instanceId: 'instance',
    sequence: 1,
    edits: [],
  }

  return { content, inspection, previewRequest }
}

describe('unchanged composition preview transactions', () => {
  it('previews without changing source', async () => {
    const { content, inspection, previewRequest } = await layerPreview()

    const result = await service.request(previewRequest)

    expect(result.definition).toEqual(inspection.definition)
    expect(result.sequence).toBe(1)
    expect(await readFile(join(root, 'Toggle.vue'), 'utf8')).toBe(content)
  })

  it('requires an explicit edit list', async () => {
    const { previewRequest } = await layerPreview()

    await expect(service.request({ ...previewRequest, edits: undefined })).rejects.toThrow(
      'Invalid edit list',
    )
  })

  it('rejects stale source snapshots', async () => {
    const { previewRequest } = await layerPreview()

    await expect(service.request({ ...previewRequest, baseHash: 'stale' })).rejects.toThrow(
      'Source changed',
    )
  })
})
