import { describe, expect, it } from 'vite-plus/test'
import fixture from '../../../../../fixtures/toggle.json'
import { isEditorReply, isEditorRequest } from './protocol.ts'

const request = { action: 'preview', sourceId: 'source', definition: 'toggle' }
const reply = { hash: 'revision', definition: fixture.definitions[0], fields: [], sequence: 1 }

describe('editor message validation', () => {
  it.each([
    { op: 'set', path: 'toggle/state/off/target/thumb/scale', value: '1' },
    {
      op: 'track',
      path: 'toggle/transition/general/target/thumb/property/scale',
      frames: [{ offset: 0.5, value: '2' }],
    },
    { op: 'addFrame', path: 'track', offset: 0.5, value: '2', easing: 'linear' },
    { op: 'removeFrame', path: 'frame' },
    {
      op: 'override',
      definition: 'toggle',
      from: 'off',
      to: 'on',
      target: 'thumb',
      property: 'scale',
      timing: 'tween(duration: 100ms)',
    },
  ])('accepts the structural shape of %j', (edit) => {
    expect(isEditorRequest({ ...request, edits: [edit] })).toBe(true)
  })

  it.each([
    null,
    { ...request, action: 'delete' },
    { ...request, sequence: '1' },
    { ...request, edits: [{ op: 'set', path: 'field', value: 1 }] },
    { ...request, edits: [{ op: 'track', path: 'track', frames: [{}] }] },
    { ...request, edits: [{ op: 'addFrame', path: 'track', offset: '50%', value: '1' }] },
    { ...request, edits: [{ op: 'override', definition: 'toggle' }] },
  ])('rejects malformed requests: %j', (value) => {
    expect(isEditorRequest(value)).toBe(false)
  })

  it('accepts inspection replies and rejects malformed fields and error envelopes', () => {
    expect(isEditorReply(reply)).toBe(true)
    expect(
      isEditorReply({ ...reply, fields: [{ path: 'field', kind: 'unknown', value: '1' }] }),
    ).toBe(false)
    expect(isEditorReply({ error: 'Conflict' })).toBe(false)
  })
})
