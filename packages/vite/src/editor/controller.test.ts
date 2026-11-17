import { describe, expect, it, vi } from 'vite-plus/test'
import { EditorController, type EditorBinding } from './controller.ts'
import type { EditorReply, EditorRequest, Edit } from './communication/protocol.ts'
import type { InstanceBinding } from '@liva/vue'
import type { Definition } from '@liva/runtime'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const definition: Definition = {
  name: 'motion',
  layers: [{ name: 'base', targets: [] }],
}
const from = { layers: { base: true }, states: {} }
const to = { layers: { base: false }, states: {} }
const reply = { hash: 'original', definition, fields: [] } satisfies EditorReply
const edits = [
  { op: 'set', path: 'motion/layer/base/timing', value: 'tween(duration: 200)' },
] satisfies Edit[]

function binding(label: string) {
  const preview = { seek: vi.fn<(time: number) => void>(), end: vi.fn<() => void>() }
  const runtime = {
    definition,
    composition: from,
    replaceDefinition: vi.fn<InstanceBinding['runtime']['replaceDefinition']>(function (
      this: { definition: Definition },
      next: Definition,
    ) {
      this.definition = next
    }),
  }
  const inspection = {
    inspectComposition: vi.fn<InstanceBinding['inspection']['inspectComposition']>(),
    inspectLifecycle: vi.fn<InstanceBinding['inspection']['inspectLifecycle']>(),
    previewComposition: vi
      .fn<InstanceBinding['inspection']['previewComposition']>()
      .mockReturnValue(preview),
    previewLifecycle: vi
      .fn<InstanceBinding['inspection']['previewLifecycle']>()
      .mockReturnValue(preview),
  }

  return {
    label,
    bounds: vi.fn<InstanceBinding['bounds']>(),
    source: 'source',
    runtime,
    inspection,
    preview,
    definition,
  } satisfies EditorBinding & { preview: typeof preview }
}

async function setup(send: (request: EditorRequest) => Promise<EditorReply>) {
  const controller = new EditorController(send)
  const first = binding('First')
  const second = binding('Second')
  controller.observe('mount', first)
  controller.observe('mount', second)
  const [a, b] = [...controller.entries.keys()]
  await controller.select(a)
  return { controller, first, second, a, b }
}

describe('editor revision lifecycle', () => {
  it('only displays source diagnostics for the selected source', async () => {
    const { controller } = await setup(async () => reply)
    await controller.previewComposition(from, to)
    const message = controller.message

    controller.reportSourceDiagnostics('other-source', 'Invalid duration')

    expect(controller.message).toBe(message)

    controller.reportSourceDiagnostics('source', 'Invalid duration')

    expect(controller.message).toBe('Invalid duration')
  })

  it('ignores out-of-order preview replies, external invalidation, and unmounted instances', async () => {
    const requests: {
      request: EditorRequest
      response: ReturnType<typeof deferred<EditorReply>>
    }[] = []
    const { controller, first } = await setup(async (request) => {
      if (request.action === 'inspect') return reply
      const response = deferred<EditorReply>()
      requests.push({ request, response })
      return response.promise
    })
    const old = controller.previewComposition(from, to)
    const latest = controller.previewComposition(to, from)
    requests[1].response.resolve({
      ...reply,
      definition: { ...definition },
      sequence: requests[1].request.sequence,
    })
    await latest
    requests[0].response.resolve({ ...reply, sequence: requests[0].request.sequence })
    await old
    expect(first.inspection.previewComposition).toHaveBeenCalledExactlyOnceWith(
      to,
      from,
      [],
      expect.objectContaining(definition),
    )

    const stale = controller.previewComposition(from, to)
    controller.sourceChanged('source')
    requests[2].response.resolve({ ...reply, sequence: requests[2].request.sequence })
    await stale
    expect(first.runtime.definition).toBe(definition)
    expect(first.inspection.previewComposition).toHaveBeenCalledTimes(1)

    await controller.cancel()
    const unmounted = controller.previewComposition(from, to)
    controller.observe('unmount', first)
    requests[3].response.resolve({ ...reply, sequence: requests[3].request.sequence })
    await unmounted
    expect(first.inspection.previewComposition).toHaveBeenCalledTimes(1)
  })

  it.each(['selection', 'draft'])(
    'retains newer %s while a previous save completes',
    async (change) => {
      const saved = deferred<EditorReply>()
      const { controller, a, b } = await setup(async (request) =>
        request.action === 'commit' ? saved.promise : reply,
      )
      controller.setDraft(edits)
      const saving = controller.commit()
      if (change === 'selection') await controller.select(b)
      const newer: Edit[] = [{ ...edits[0], value: 'tween(duration: 300)' }]
      controller.setDraft(newer)

      saved.resolve(reply)
      await saving
      expect(controller.draft).toEqual(newer)
      expect(controller.selected?.id).toBe(change === 'selection' ? b : a)
    },
  )

  it('notifies loading before inspection resolves and preserves draft on failed save', async () => {
    const inspection = deferred<EditorReply>()
    let loading = false
    const { controller, b } = await setup(async (request) => {
      if (request.action === 'commit') throw new Error('Conflict')
      return loading ? inspection.promise : reply
    })
    controller.setDraft(edits)
    await expect(controller.commit()).rejects.toThrow('Conflict')
    expect(controller.draft).toEqual(edits)

    const observed: unknown[] = []
    controller.subscribe(() => observed.push(controller.inspection))
    loading = true
    const selecting = controller.select(b)
    expect(observed).toEqual([undefined])
    inspection.resolve(reply)
    await selecting
    expect(controller.inspection).toBe(reply)
  })
})

describe('editor selection and saves', () => {
  it('handles empty selection, missing source identities and detached notifications', async () => {
    const controller = new EditorController(async () => reply)
    const orphan = binding('Orphan')

    orphan.source = ''
    controller.observe('mount', orphan)
    controller.observe('update', orphan)
    controller.observe('unmount', orphan)

    expect(controller.entries.size).toBe(0)

    await controller.select('missing')

    await expect(controller.previewComposition(from, to)).rejects.toThrow('mounted')
    await expect(controller.commit()).rejects.toThrow('first')

    controller.sourceChanged('other')
    await controller.cancel()

    expect(controller.inspection).toBeUndefined()
  })

  it('saves a synchronized source and clears the draft', async () => {
    const { controller } = await setup(async () => reply)

    controller.setDraft(edits)
    await controller.commit()

    expect(controller.draft).toEqual([])
    expect(controller.inspection).toEqual(reply)
    expect(controller.message).toContain('synchronized')
    expect(controller.stale).toBe(false)
  })

  it('prevents overlapping saves and keeps retry identity after a transport failure', async () => {
    const saved = deferred<EditorReply>()
    const requests: EditorRequest[] = []
    let fail = true
    const { controller } = await setup(async (request) => {
      if (request.action !== 'commit') return reply

      requests.push(request)

      if (fail) throw new Error('Connection lost')

      return saved.promise
    })

    controller.setDraft(edits)

    await expect(controller.commit()).rejects.toThrow('Connection lost')

    fail = false

    const pending = controller.commit()

    await expect(controller.commit()).rejects.toThrow('already')

    controller.sourceChanged('source')
    saved.resolve(reply)
    await pending

    expect(requests[1].requestId).toBe(requests[0].requestId)
    expect(controller.draft).toEqual([])
  })

  it('reconnects selection after remount and unsubscribes observers', async () => {
    const { controller, first } = await setup(async () => reply)
    const listener = vi.fn<() => void>()
    const unsubscribe = controller.subscribe(listener)

    controller.observe('unmount', first)

    const replacement = binding('First')

    controller.observe('mount', replacement)

    await Promise.resolve()

    expect(controller.selected?.binding).toBe(replacement)
    expect(listener).toHaveBeenCalledTimes(2)

    unsubscribe()
    controller.report('A diagnostic')

    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('reconnects the same metadata identity when HMR reverses mount order', async () => {
    const controller = new EditorController(async () => reply)
    const first = binding('First')
    const second = binding('Second')
    const other = binding('Second')
    const replacement = binding('First')

    controller.observe('mount', first)
    controller.observe('mount', second)

    await Promise.resolve()
    await controller.select([...controller.entries.keys()][0])

    controller.observe('unmount', first)
    controller.observe('unmount', second)
    controller.observe('mount', other)
    controller.observe('mount', replacement)

    await Promise.resolve()

    expect(controller.selected?.binding).toBe(replacement)
    expect([...controller.entries.values()].map((entry) => entry.label)).toEqual([
      'Second',
      'First',
    ])
  })

  it('ignores a queued mount notification after the instance unregisters', async () => {
    const { controller, first } = await setup(async () => reply)
    const replacement = binding('First')

    controller.observe('unmount', first)
    controller.observe('mount', replacement)
    controller.observe('unmount', replacement)

    await Promise.resolve()

    expect(controller.selected?.binding).toBe(first)
    expect([...controller.entries.values()].some((entry) => entry.binding === replacement)).toBe(
      false,
    )
  })

  it('restarts inspection when HMR remounts an instance during source loading', async () => {
    const originalInspection = deferred<EditorReply>()
    const replacementInspection = deferred<EditorReply>()
    const send = vi
      .fn<(request: EditorRequest) => Promise<EditorReply>>()
      .mockReturnValueOnce(originalInspection.promise)
      .mockReturnValueOnce(replacementInspection.promise)
    const controller = new EditorController(send)
    const first = binding('First')
    const replacement = binding('First')

    controller.observe('mount', first)

    await Promise.resolve()

    const selecting = controller.select([...controller.entries.keys()][0])
    controller.observe('unmount', first)
    controller.observe('mount', replacement)

    await Promise.resolve()

    expect(send).toHaveBeenCalledTimes(2)

    originalInspection.resolve({ ...reply, hash: 'obsolete' })
    replacementInspection.resolve(reply)

    await selecting
    await Promise.resolve()

    expect(controller.selected?.binding).toBe(replacement)
    expect(controller.inspection).toBe(reply)
  })

  it('reports a failed inspection restarted after remount', async () => {
    const originalInspection = deferred<EditorReply>()
    const failure = new Error('Inspection unavailable')
    const send = vi
      .fn<(request: EditorRequest) => Promise<EditorReply>>()
      .mockReturnValueOnce(originalInspection.promise)
      .mockRejectedValueOnce(failure)
    const controller = new EditorController(send)
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {})
    const first = binding('First')

    controller.observe('mount', first)

    await Promise.resolve()

    const selecting = controller.select([...controller.entries.keys()][0])
    controller.observe('unmount', first)
    controller.observe('mount', binding('First'))

    await vi.waitFor(() => {
      expect(controller.message).toContain('Inspection unavailable')
    })
    expect(reported).toHaveBeenCalledWith('[Liva editor]', failure)

    originalInspection.resolve(reply)

    await selecting

    reported.mockRestore()
  })

  it('previews compositions, seeks, and restores after application updates', async () => {
    const { controller, first } = await setup(async (request) => ({
      ...reply,
      sequence: request.sequence,
    }))

    await controller.previewComposition(from, to)

    expect(controller.previewActive).toBe(true)

    controller.seek(NaN)
    controller.seek(-10)
    controller.observe('update', first)

    expect(controller.previewActive).toBe(false)
    expect(first.runtime.definition).toBe(definition)
    expect(controller.message).toContain('superseded')

    controller.endPreview()
    controller.seek(10)
  })

  it('reports an ended preview after restoring application ownership and retains the draft', async () => {
    const { controller, first } = await setup(async (request) => ({
      ...reply,
      sequence: request.sequence,
    }))
    controller.setDraft(edits)
    await controller.previewComposition(from, to)

    controller.endPreview()

    expect(first.preview.end).toHaveBeenCalledExactlyOnceWith()
    expect(controller.previewActive).toBe(false)
    expect(controller.message).toContain('Preview ended. Application state is restored')
    expect(controller.draft).toEqual(edits)
  })

  it.each(['inactive diagnostic', 'active diagnostic', 'stale source'] as const)(
    'preserves relevant feedback when ending a preview with %s',
    async (status) => {
      const { controller, first } = await setup(async (request) => ({
        ...reply,
        sequence: request.sequence,
      }))

      if (status !== 'inactive diagnostic') await controller.previewComposition(from, to)

      if (status === 'stale source') controller.sourceChanged('source')
      else controller.reportSourceDiagnostics('source', 'Mismatched delimiter')

      const message = controller.message
      const ends = first.preview.end.mock.calls.length

      controller.endPreview()

      expect(controller.previewActive).toBe(false)
      expect(controller.message).toBe(message)
      expect(first.preview.end).toHaveBeenCalledTimes(
        ends + (status === 'active diagnostic' ? 1 : 0),
      )
    },
  )

  it('reports runtime preview rejection and ignores stale inspection replies', async () => {
    const { controller, first } = await setup(async (request) => ({
      ...reply,
      sequence: request.sequence,
    }))

    first.inspection.previewComposition.mockImplementation(() => {
      throw new Error('Could not prepare preview')
    })

    await expect(controller.previewComposition(from, to)).rejects.toThrow('Could not prepare')
    expect(controller.previewActive).toBe(false)

    const inspection = deferred<EditorReply>()
    const another = new EditorController(() => inspection.promise)

    another.observe('mount', first)

    const selecting = another.select([...another.entries.keys()][0])

    await another.select('missing')
    inspection.resolve(reply)
    await selecting

    expect(another.inspection).toBeUndefined()
  })
})

it('retains the draft when live instances fail to synchronize before the deadline', async () => {
  vi.useFakeTimers()

  try {
    const changed = { ...definition, name: 'changed' }
    const { controller } = await setup(async (request) =>
      request.action === 'commit' ? { ...reply, definition: changed } : reply,
    )

    controller.setDraft(edits)

    await Promise.all([
      expect(controller.commit()).rejects.toThrow('synchronization is pending'),
      vi.advanceTimersByTimeAsync(5040),
    ])

    expect(controller.draft).toEqual(edits)
  } finally {
    vi.useRealTimers()
  }
})

it('allocates a new retry identity when a public draft changes after failure', async () => {
  const requests: EditorRequest[] = []
  const { controller } = await setup(async (request) => {
    if (request.action === 'commit') {
      requests.push(request)
      throw new Error('Connection lost')
    }

    return reply
  })

  controller.setDraft(edits)

  await expect(controller.commit()).rejects.toThrow('Connection lost')

  controller.draft = [{ ...edits[0], value: 'tween(duration: 400)' }]

  await expect(controller.commit()).rejects.toThrow('Connection lost')

  expect(requests[1].requestId).not.toBe(requests[0].requestId)
})

it('ignores unrelated instance updates and only reattaches matching remounts', async () => {
  const { controller, first, second } = await setup(async (request) => ({
    ...reply,
    sequence: request.sequence,
  }))

  controller.observe('update', second)
  controller.observe('unmount', second)

  expect(controller.selected?.binding).toBe(first)

  controller.observe('update', first)

  expect(first.runtime.replaceDefinition).not.toHaveBeenCalled()

  controller.observe('unmount', first)
  controller.observe('mount', binding('Different'))

  await Promise.resolve()

  expect(controller.selected?.binding).toBe(first)

  const otherSource = binding('First')

  otherSource.source = 'other-source'
  controller.observe('mount', otherSource)

  await Promise.resolve()

  expect(controller.selected?.binding).toBe(first)
})

it('does not apply previews started against an already stale inspection', async () => {
  const { controller } = await setup(async (request) => ({ ...reply, sequence: request.sequence }))

  controller.sourceChanged('source')
  await controller.previewComposition(from, to)

  expect(controller.previewActive).toBe(false)
  expect(controller.stale).toBe(true)
})

describe('lifecycle preview coordination', () => {
  it.each(['enter', 'leave'] as const)(
    'previews motion-level %s without replacing the application definition',
    async (phase) => {
      const lifecycle = { ...definition, [phase]: { targets: [] } }
      const { controller, first } = await setup(async (request) => ({
        ...reply,
        definition: lifecycle,
        sequence: request.sequence,
      }))

      await controller.previewComposition(from, to, [], phase)

      expect(first.inspection.previewLifecycle).toHaveBeenCalledExactlyOnceWith(
        phase,
        to,
        lifecycle,
      )
      expect(first.inspection.previewComposition).not.toHaveBeenCalled()
      expect(first.runtime.replaceDefinition).not.toHaveBeenCalled()

      controller.endPreview()

      expect(first.preview.end).toHaveBeenCalled()
      expect(first.runtime.definition).toBe(definition)
      expect(controller.previewActive).toBe(false)
      expect(controller.message).toContain('Preview ended. Application state is restored')
    },
  )
})

describe('composition preview coordination', () => {
  const fromComposition = { layers: { base: true }, states: {} }
  const toComposition = { layers: { base: false }, states: {} }

  it('applies only the latest mounted preview response without replacing application definitions', async () => {
    const pending: ReturnType<typeof deferred<EditorReply>>[] = []
    const requests: EditorRequest[] = []
    const { controller, first } = await setup(async (request) => {
      if (request.action === 'inspect') return reply
      const item = deferred<EditorReply>()
      pending.push(item)
      requests.push(request)
      return item.promise
    })

    const old = controller.previewComposition(fromComposition, toComposition)
    const latest = controller.previewComposition(toComposition, fromComposition)
    pending[1].resolve({ ...reply, sequence: requests[1].sequence })
    await latest
    pending[0].resolve({ ...reply, sequence: requests[0].sequence })
    await old

    expect(first.inspection.previewComposition).toHaveBeenCalledExactlyOnceWith(
      toComposition,
      fromComposition,
      [],
      definition,
    )
    expect(first.runtime.replaceDefinition).not.toHaveBeenCalled()
    expect(controller.previewActive).toBe(true)
  })

  it.each(['close', 'discard', 'selection', 'update', 'unmount'] as const)(
    'invalidates pending replies on %s',
    async (action) => {
      const pending = deferred<EditorReply>()
      let sequence: number | undefined
      const { controller, first, second } = await setup(async (request) => {
        if (request.action === 'inspect') return reply
        sequence = request.sequence
        return pending.promise
      })

      const preview = controller.previewComposition(fromComposition, toComposition)

      if (action === 'close') controller.endPreview()
      if (action === 'discard') await controller.cancel()
      if (action === 'selection')
        await controller.select(
          [...controller.entries.values()].find((entry) => entry.binding === second)!.id,
        )
      if (action === 'update') controller.observe('update', first)
      if (action === 'unmount') controller.observe('unmount', first)

      pending.resolve({ ...reply, sequence })
      await preview

      expect(first.inspection.previewComposition).not.toHaveBeenCalled()
      expect(controller.previewActive).toBe(false)
    },
  )

  it('rejects preview requests with no mounted selection', async () => {
    const controller = new EditorController(async () => reply)

    await expect(controller.previewComposition(fromComposition, toComposition)).rejects.toThrow(
      'mounted instance',
    )
  })

  it('returns runtime failures to callers with their cause intact', async () => {
    const { controller, first } = await setup(async (request) => ({
      ...reply,
      sequence: request.sequence,
    }))
    const cause = new Error('WAAPI failed')
    const error = new Error('Preview failed', { cause })
    first.inspection.previewComposition.mockImplementation(() => {
      throw error
    })

    await expect(controller.previewComposition(fromComposition, toComposition)).rejects.toBe(error)
    expect(controller.previewActive).toBe(false)
  })
})
