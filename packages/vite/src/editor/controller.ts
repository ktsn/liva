import { timelineReadOnly, readOnlyMessage } from './capabilities.ts'
import type { InstanceBinding } from '@liva/vue'
import type { EditorReply, EditorRequest, Edit, Inspection } from './communication/protocol.ts'

export type EditorBinding = Pick<InstanceBinding, 'component' | 'definition' | 'requestedState'> & {
  readonly root: Pick<HTMLElement, 'getAttribute' | 'textContent' | 'getBoundingClientRect'>
  readonly runtime: Pick<
    InstanceBinding['runtime'],
    'definition' | 'state' | 'animations' | 'replaceDefinition' | 'setState' | 'previewLifecycle'
  >
}

export interface Entry {
  id: string
  sourceId: string
  label: string
  binding: EditorBinding
}

export class EditorController {
  readonly entries = new Map<string, Entry>()
  selected?: Entry
  inspection?: Inspection
  draft: Edit[] = []
  stale = false
  message = 'Select an instance to inspect its motion.'
  previewActive = false
  private sequence = 0
  private revision = 0
  private saving = false
  private pendingCommit?: { signature: string; id: string }
  private listeners = new Set<() => void>()

  constructor(private readonly send: (request: EditorRequest) => Promise<EditorReply>) {}

  subscribe(callback: () => void) {
    this.listeners.add(callback)
    return () => this.listeners.delete(callback)
  }
  private notify() {
    this.listeners.forEach((listener) => listener())
  }
  private active(entry: Entry) {
    return this.entries.get(entry.id) === entry
  }

  observe(event: 'mount' | 'update' | 'unmount', binding: EditorBinding) {
    if (event === 'mount') {
      const sourceId = binding.component.livaSource
      if (!sourceId) return
      const label =
        binding.root.getAttribute('aria-label') ??
        `${binding.definition.name} ${/* v8 ignore next -- @preserve: HTMLElement.textContent is a string; null applies to other Node kinds. */ binding.root.textContent?.trim().slice(0, 30) ?? ''}`
      const entry = { id: crypto.randomUUID(), sourceId, label, binding }
      this.entries.set(entry.id, entry)

      if (
        this.selected &&
        !this.active(this.selected) &&
        this.selected.sourceId === sourceId &&
        this.selected.label === label
      )
        this.selected = entry
    } else {
      const entry = [...this.entries.values()].find((candidate) => candidate.binding === binding)
      if (!entry) return

      if (event === 'unmount') {
        this.entries.delete(entry.id)
        if (this.selected === entry) {
          this.sequence++
          this.previewActive = false
        }
      } else if (this.selected === entry) {
        this.previewActive = false
        this.sequence++
        if (binding.runtime.definition !== binding.definition)
          binding.runtime.replaceDefinition(binding.definition, binding.requestedState)
        this.message = 'Application state superseded the preview. Your draft is retained.'
      }
    }

    this.notify()
  }

  async select(id: string) {
    this.revision++
    this.sequence++
    this.restoreSelected()
    this.selected = this.entries.get(id)
    this.inspection = undefined
    this.draft = []
    this.pendingCommit = undefined
    this.stale = false
    const selected = this.selected
    const sequence = this.sequence
    if (!selected) {
      this.notify()
      return
    }
    this.message = 'Loading source…'
    this.notify()
    const inspection = await this.send({
      action: 'inspect',
      sourceId: selected.sourceId,
      definition: selected.binding.definition.name,
    })
    if (this.selected !== selected || sequence !== this.sequence) return
    this.inspection = inspection
    this.message = timelineReadOnly(inspection.definition)
      ? readOnlyMessage
      : 'Preview affects this instance. Saving updates the shared source.'
    this.notify()
  }

  setDraft(edits: Edit[]) {
    this.revision++
    this.sequence++
    this.draft = edits
    this.pendingCommit = undefined
    this.notify()
  }

  async preview(state: string, from?: string, general = false, phase?: 'enter' | 'leave') {
    const selected = this.selected
    const inspection = this.inspection
    if (!selected || !inspection || !this.active(selected))
      throw new Error('Select a mounted instance')
    if (timelineReadOnly(inspection.definition)) throw new Error(readOnlyMessage)

    const sequence = ++this.sequence
    const reply = await this.send({
      action: 'preview',
      sourceId: selected.sourceId,
      definition: selected.binding.definition.name,
      instanceId: selected.id,
      baseHash: inspection.hash,
      sequence,
      edits: this.draft,
    })
    if (
      sequence !== this.sequence ||
      this.selected !== selected ||
      !this.active(selected) ||
      reply.sequence !== sequence ||
      this.stale
    )
      return
    const definition = general
      ? phase
        ? { ...reply.definition, [phase === 'enter' ? 'stateEnters' : 'stateLeaves']: [] }
        : { ...reply.definition, directionalTransitions: [] }
      : reply.definition
    selected.binding.runtime.replaceDefinition(
      definition,
      phase ? state : (from ?? selected.binding.requestedState),
    )
    const succeeded = phase
      ? selected.binding.runtime.previewLifecycle(phase)
      : from === undefined
        ? selected.binding.runtime.setState(state)
        : selected.binding.runtime.setState(state, { paused: true })
    this.previewActive = succeeded
    if (!this.previewActive)
      throw new Error('The runtime could not prepare this transition. Check its timing and easing.')

    this.message = 'Previewing this instance only. Source is unchanged.'
    this.notify()
  }

  seek(time: number) {
    if (!this.previewActive || !Number.isFinite(time)) return

    /* v8 ignore start -- @preserve: A successful preview retains its selected mounted entry; selection changes clear previewActive. */
    for (const animation of this.selected?.binding.runtime.animations ??
      []
    /* v8 ignore stop -- @preserve */
    ) {
      animation.currentTime = Math.max(0, time)
    }
  }

  endPreview() {
    this.sequence++
    this.restoreSelected()
    this.notify()
  }

  private restoreSelected() {
    this.previewActive = false
    const selected = this.selected
    if (
      selected &&
      this.active(selected) &&
      (selected.binding.runtime.definition !== selected.binding.definition ||
        selected.binding.runtime.state !== selected.binding.requestedState)
    )
      selected.binding.runtime.replaceDefinition(
        selected.binding.definition,
        selected.binding.requestedState,
      )
  }

  async cancel() {
    this.revision++
    const id = this.selected?.id
    this.sequence++
    this.restoreSelected()
    this.draft = []
    this.stale = false
    if (id && this.entries.has(id)) await this.select(id)
    else {
      this.inspection = undefined
      this.notify()
    }
  }

  reportSourceDiagnostics(sourceId: string, message: string) {
    if (this.selected?.sourceId !== sourceId) return

    this.report(message)
  }

  sourceChanged(sourceId: string) {
    if (this.selected?.sourceId !== sourceId) return
    this.sequence++
    this.stale = true
    this.restoreSelected()
    if (!this.saving)
      this.message = 'Source changed. Draft retained; cancel to inspect the current revision.'
    this.notify()
  }

  async commit() {
    if (this.saving) throw new Error('A save is already in progress')
    const revision = this.revision
    const selected = this.selected
    const inspection = this.inspection
    if (!selected || !inspection) throw new Error('Select an instance first')
    if (timelineReadOnly(inspection.definition)) throw new Error(readOnlyMessage)

    const signature = JSON.stringify({
      sourceId: selected.sourceId,
      definition: selected.binding.definition.name,
      baseHash: inspection.hash,
      edits: this.draft,
    })
    this.pendingCommit ??= { signature, id: crypto.randomUUID() }
    if (this.pendingCommit.signature !== signature)
      this.pendingCommit = { signature, id: crypto.randomUUID() }
    this.saving = true
    this.sequence++

    try {
      const reply = await this.send({
        action: 'commit',
        sourceId: selected.sourceId,
        definition: selected.binding.definition.name,
        baseHash: inspection.hash,
        edits: this.draft,
        requestId: this.pendingCommit.id,
      })
      const deadline = Date.now() + 5000

      while (Date.now() < deadline) {
        const matching = [...this.entries.values()].filter(
          (e) =>
            e.sourceId === selected.sourceId &&
            e.binding.definition.name === selected.binding.definition.name,
        )
        if (
          matching.length &&
          matching.every(
            (e) => JSON.stringify(e.binding.definition) === JSON.stringify(reply.definition),
          )
        )
          break
        await new Promise((resolve) => setTimeout(resolve, 40))
      }

      const current = await this.send({
        action: 'inspect',
        sourceId: selected.sourceId,
        definition: selected.binding.definition.name,
      })
      const matching = [...this.entries.values()].filter(
        (e) =>
          e.sourceId === selected.sourceId &&
          e.binding.definition.name === selected.binding.definition.name,
      )
      if (
        current.hash !== reply.hash ||
        !matching.length ||
        matching.some(
          (e) => JSON.stringify(e.binding.definition) !== JSON.stringify(reply.definition),
        )
      )
        throw new Error(
          'Source saved, but live synchronization is pending. Draft retained; retry to verify.',
        )
      if (revision !== this.revision) return

      this.inspection = current
      this.draft = []
      this.pendingCommit = undefined
      this.stale = false
      this.restoreSelected()
      this.message = 'Saved to source. All shared instances are synchronized.'
      this.notify()
    } finally {
      this.saving = false
    }
  }

  report(error: unknown) {
    this.message = String(error)
    this.notify()
  }
}
