import { Readable } from 'node:stream'
import { assert, describe, expect, it } from 'vite-plus/test'
import { ZipEntry, createZipArchive, createZipArchiveSync } from 'node:zlib'
import { artifactLimits, readArtifact } from '../report.ts'

function archive(entries: ZipEntry[], baseOffset = 0): Buffer {
  return Buffer.concat([...createZipArchiveSync(entries, { baseOffset })])
}

function jsonEntry(content = '{}', method: 'store' | 'deflate' = 'store'): ZipEntry {
  return ZipEntry.createSync('result.json', Buffer.from(content), { method })
}

describe('artifact ZIP validation', () => {
  it('native ZIP reader accepts stored and deflated JSON', () => {
    const content = JSON.stringify({ value: 'repeated '.repeat(1000) })

    for (const method of ['store', 'deflate'] as const) {
      expect(readArtifact(archive([jsonEntry(content, method)]))).toStrictEqual(JSON.parse(content))
    }
  })

  it('native ZIP reader rejects empty archives, multiple entries and duplicate names', () => {
    for (const entries of [
      [],
      [jsonEntry(), ZipEntry.createSync('extra.json', Buffer.from('{}'))],
      [jsonEntry(), jsonEntry()],
    ]) {
      expect(() => readArtifact(archive(entries))).toThrow(
        /Missing result.json|Unexpected artifact files/,
      )
    }
  })

  it('native ZIP reader rejects traversal, absolute paths, directory and symlink entries', () => {
    for (const name of ['../result.json', '/result.json', 'sub/result.json', 'result.json/']) {
      const data = name.endsWith('/') ? Buffer.alloc(0) : Buffer.from('{}')

      expect(() => readArtifact(archive([ZipEntry.createSync(name, data)]))).toThrow(
        /Unexpected artifact files/,
      )
    }

    const link = ZipEntry.createSymlink('result.json', '{}')

    expect(() => readArtifact(archive([link]))).toThrow(/Unexpected artifact files/)
  })

  it('decompressed JSON accepts the exact limit and rejects one additional byte', () => {
    for (const method of ['store', 'deflate'] as const) {
      const boundary = JSON.stringify('x'.repeat(artifactLimits.json - 2))

      expect(Buffer.byteLength(boundary)).toBe(artifactLimits.json)
      expect(readArtifact(archive([jsonEntry(boundary, method)]))).toBe(JSON.parse(boundary))
      expect(() => readArtifact(archive([jsonEntry(`${boundary} `, method)]))).toThrow(
        expect.objectContaining({
          code: 'ERR_ZIP_ENTRY_TOO_LARGE',
        }),
      )
    }
  })

  it('archive bytes accept the exact limit and reject one additional byte before parsing', () => {
    const ordinary = archive([jsonEntry()])
    const prefixSize = artifactLimits.archive - ordinary.length
    const boundary = Buffer.concat([Buffer.alloc(prefixSize), archive([jsonEntry()], prefixSize)])

    expect(boundary.length).toBe(artifactLimits.archive)
    expect(readArtifact(boundary)).toStrictEqual({})
    expect(() => readArtifact(Buffer.concat([boundary, Buffer.alloc(1)]))).toThrow(
      /Artifact ZIP too large/,
    )
  })

  it('truncated archives and damaged entry content fail verification', () => {
    const valid = archive([jsonEntry('{"key":"value"}')])

    expect(() => readArtifact(valid.subarray(0, valid.length - 1))).toThrow(Error)

    const corrupted = Buffer.from(valid)
    const contentOffset = corrupted.indexOf(Buffer.from('{"key":"value"}'))

    assert(contentOffset >= 0)

    corrupted[contentOffset] ^= 1

    expect(() => readArtifact(corrupted)).toThrow(
      expect.objectContaining({ code: 'ERR_ZIP_ENTRY_CORRUPT' }),
    )
  })

  it('high-expansion content and falsified uncompressed sizes are bounded and rejected', () => {
    const bomb = archive([jsonEntry(JSON.stringify('x'.repeat(2_000_000)), 'deflate')])

    assert(bomb.length < artifactLimits.archive)
    expect(() => readArtifact(bomb)).toThrow(
      expect.objectContaining({ code: 'ERR_ZIP_ENTRY_TOO_LARGE' }),
    )

    const understated = Buffer.from(bomb)
    const central = understated.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))

    assert(central >= 0)

    // Corrupt a test archive's ZIP size fields; production parsing/CRC remain native APIs.
    understated.writeUInt32LE(100, central + 24)
    understated.writeUInt32LE(100, 22)

    expect(() => readArtifact(understated)).toThrow(
      expect.objectContaining({ code: 'ERR_ZIP_ENTRY_CORRUPT' }),
    )
  })

  it('stream-created entries with data descriptors and ZIP64 remain readable', async () => {
    const content = Buffer.from(JSON.stringify({ streamed: 'x'.repeat(1000) }))
    const entry = ZipEntry.createStream('result.json', Readable.from([content]))
    const chunks: Buffer[] = []

    for await (const chunk of createZipArchive([entry])) {
      assert(Buffer.isBuffer(chunk))
      chunks.push(chunk)
    }

    const zip = Buffer.concat(chunks)

    // Streaming writers use ZIP64 local sizes when content length is not known up front.
    expect(zip.readUInt32LE(18)).toBe(0xffffffff)
    expect(zip.readUInt32LE(22)).toBe(0xffffffff)

    assert(
      zip.includes(Buffer.from([0x50, 0x4b, 0x07, 0x08])),
      'Writer must exercise a data descriptor',
    )
    expect(readArtifact(zip)).toStrictEqual(JSON.parse(content.toString('utf8')))
  })
})
