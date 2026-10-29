import { describe, expect, it, vi } from 'vite-plus/test'
import { EditorController } from './controller.ts'
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

const definition = { name: 'motion' } as Definition
const reply = { hash: 'original', definition, fields: [] } satisfies EditorReply
const edits: Edit[] = [
  { op: 'set', path: 'motion/transition/general/timing/duration', value: '200ms' },
]

const stateSpies = new WeakMap<InstanceBinding, ReturnType<typeof vi.fn>>()

function binding(label: string) {
  const runtime = {
    definition,
    replaceDefinition: vi.fn<InstanceBinding['runtime']['replaceDefinition']>(function (
      this: { definition: Definition },
      next: Definition,
    ) {
      this.definition = next
    }),
    setState: vi.fn<InstanceBinding['runtime']['setState']>().mockReturnValue(true),
  }
  const result = {
    root: { getAttribute: () => label },
    component: { livaSource: 'source' },
    runtime,
    definition,
    requestedState: 'off',
  } as unknown as InstanceBinding
  stateSpies.set(result, runtime.setState)
  return result
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
    const old = controller.preview('on')
    const latest = controller.preview('off')
    requests[1].response.resolve({
      ...reply,
      definition: { ...definition },
      sequence: requests[1].request.sequence,
    })
    await latest
    requests[0].response.resolve({ ...reply, sequence: requests[0].request.sequence })
    await old
    expect(stateSpies.get(first)).toHaveBeenCalledExactlyOnceWith('off')

    const stale = controller.preview('on')
    controller.sourceChanged('source')
    requests[2].response.resolve({ ...reply, sequence: requests[2].request.sequence })
    await stale
    expect(first.runtime.definition).toBe(definition)
    expect(stateSpies.get(first)).toHaveBeenCalledTimes(1)

    await controller.cancel()
    const unmounted = controller.preview('on')
    controller.observe('unmount', first)
    requests[3].response.resolve({ ...reply, sequence: requests[3].request.sequence })
    await unmounted
    expect(stateSpies.get(first)).toHaveBeenCalledTimes(1)
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
      const newer: Edit[] = [{ ...edits[0], value: '300ms' } as Edit]
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
