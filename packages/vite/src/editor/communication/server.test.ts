import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test'
import { mkdtemp, readFile, writeFile, rm, symlink, unlink, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EditorService } from './server.ts'
import type { EditorRequest } from './protocol.ts'

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
