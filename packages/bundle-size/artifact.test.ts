import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { ZipEntry, createZipArchive, createZipArchiveSync } from 'node:zlib'
import { artifactLimits, readArtifact } from './report.ts'

function archive(entries: ZipEntry[], baseOffset = 0): Buffer {
  return Buffer.concat([...createZipArchiveSync(entries, { baseOffset })])
}

function jsonEntry(content = '{}', method: 'store' | 'deflate' = 'store'): ZipEntry {
  return ZipEntry.createSync('result.json', Buffer.from(content), { method })
}

await test('native ZIP reader accepts stored and deflated JSON', () => {
  const content = JSON.stringify({ value: 'repeated '.repeat(1000) })

  for (const method of ['store', 'deflate'] as const) {
    assert.deepEqual(readArtifact(archive([jsonEntry(content, method)])), JSON.parse(content))
  }
})

await test('native ZIP reader rejects empty archives, multiple entries and duplicate names', () => {
  for (const entries of [
    [],
    [jsonEntry(), ZipEntry.createSync('extra.json', Buffer.from('{}'))],
    [jsonEntry(), jsonEntry()],
  ]) {
    assert.throws(
      () => readArtifact(archive(entries)),
      /Missing result.json|Unexpected artifact files/,
    )
  }
})

await test('native ZIP reader rejects traversal, absolute paths, directory and symlink entries', () => {
  for (const name of ['../result.json', '/result.json', 'sub/result.json', 'result.json/']) {
    const data = name.endsWith('/') ? Buffer.alloc(0) : Buffer.from('{}')

    assert.throws(
      () => readArtifact(archive([ZipEntry.createSync(name, data)])),
      /Unexpected artifact files/,
    )
  }

  const link = ZipEntry.createSymlink('result.json', '{}')

  assert.throws(() => readArtifact(archive([link])), /Unexpected artifact files/)
})

await test('decompressed JSON accepts the exact limit and rejects one additional byte', () => {
  for (const method of ['store', 'deflate'] as const) {
    const boundary = JSON.stringify('x'.repeat(artifactLimits.json - 2))

    assert.equal(Buffer.byteLength(boundary), artifactLimits.json)
    assert.equal(readArtifact(archive([jsonEntry(boundary, method)])), JSON.parse(boundary))
    assert.throws(() => readArtifact(archive([jsonEntry(`${boundary} `, method)])), {
      code: 'ERR_ZIP_ENTRY_TOO_LARGE',
    })
  }
})

await test('archive bytes accept the exact limit and reject one additional byte before parsing', () => {
  const ordinary = archive([jsonEntry()])
  const prefixSize = artifactLimits.archive - ordinary.length
  const boundary = Buffer.concat([Buffer.alloc(prefixSize), archive([jsonEntry()], prefixSize)])

  assert.equal(boundary.length, artifactLimits.archive)
  assert.deepEqual(readArtifact(boundary), {})
  assert.throws(
    () => readArtifact(Buffer.concat([boundary, Buffer.alloc(1)])),
    /Artifact ZIP too large/,
  )
})

await test('truncated archives and damaged entry content fail verification', () => {
  const valid = archive([jsonEntry('{"key":"value"}')])

  assert.throws(() => readArtifact(valid.subarray(0, valid.length - 1)))

  const corrupted = Buffer.from(valid)
  const contentOffset = corrupted.indexOf(Buffer.from('{"key":"value"}'))

  assert(contentOffset >= 0)

  corrupted[contentOffset] ^= 1

  assert.throws(() => readArtifact(corrupted), { code: 'ERR_ZIP_ENTRY_CORRUPT' })
})

await test('high-expansion content and falsified uncompressed sizes are bounded and rejected', () => {
  const bomb = archive([jsonEntry(JSON.stringify('x'.repeat(2_000_000)), 'deflate')])

  assert(bomb.length < artifactLimits.archive)
  assert.throws(() => readArtifact(bomb), { code: 'ERR_ZIP_ENTRY_TOO_LARGE' })

  const understated = Buffer.from(bomb)
  const central = understated.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))

  assert(central >= 0)

  // Corrupt a test archive's ZIP size fields; production parsing/CRC remain native APIs.
  understated.writeUInt32LE(100, central + 24)
  understated.writeUInt32LE(100, 22)

  assert.throws(() => readArtifact(understated), { code: 'ERR_ZIP_ENTRY_CORRUPT' })
})

await test('stream-created entries with data descriptors and ZIP64 remain readable', async () => {
  const content = Buffer.from(JSON.stringify({ streamed: 'x'.repeat(1000) }))
  const entry = ZipEntry.createStream('result.json', Readable.from([content]))
  const chunks: Buffer[] = []

  for await (const chunk of createZipArchive([entry])) {
    assert(Buffer.isBuffer(chunk))
    chunks.push(chunk)
  }

  const zip = Buffer.concat(chunks)

  // Streaming writers use ZIP64 local sizes when content length is not known up front.
  assert.equal(zip.readUInt32LE(18), 0xffffffff)
  assert.equal(zip.readUInt32LE(22), 0xffffffff)

  assert(
    zip.includes(Buffer.from([0x50, 0x4b, 0x07, 0x08])),
    'Writer must exercise a data descriptor',
  )
  assert.deepEqual(readArtifact(zip), JSON.parse(content.toString('utf8')))
})
