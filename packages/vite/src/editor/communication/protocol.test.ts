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
    { op: 'timing', path: 'property', value: 'spring(duration: 400)' },
    { op: 'timing', path: 'property' },
    { op: 'easing', path: 'frame', value: 'stepStart' },
    { op: 'easing', path: 'frame' },
    {
      op: 'override',
      definition: 'toggle',
      from: 'off',
      to: 'on',
      target: 'thumb',
      property: 'scale',
      timing: '@tween: 100ms',
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

describe('editor optional fields', () => {
  it.each([
    null,
    { op: 'set', value: '1' },
    { op: 'unknown', path: 'field' },
    { op: 'track', path: 'field', timing: 1 },
    { op: 'timing', path: 'property', value: 1 },
    { op: 'easing', path: 'frame', value: false },
  ])('rejects invalid edits %j', (edit) => {
    expect(isEditorRequest({ ...request, edits: [edit] })).toBe(false)
  })

  it.each(['inspect', 'commit'])('accepts %s with optional identities', (action) => {
    expect(
      isEditorRequest({
        ...request,
        action,
        instanceId: 'instance',
        baseHash: 'hash',
        requestId: 'request',
        edits: [{ op: 'track', path: 'field', timing: '@tween: 1s' }],
      }),
    ).toBe(true)
    expect(isEditorRequest({ ...request, action, instanceId: 42 })).toBe(false)
  })

  it('accepts both field kinds and an omitted sequence', () => {
    expect(
      isEditorReply({
        ...reply,
        sequence: undefined,
        fields: [
          { path: 'value', kind: 'value', value: '1' },
          { path: 'block', kind: 'block', value: '' },
        ],
      }),
    ).toBe(true)
    expect(isEditorReply({ ...reply, sequence: '1' })).toBe(false)
  })
})

describe('inspection source ranges', () => {
  it('accepts byte ranges associated with the inspection hash', () => {
    expect(
      isEditorReply({
        ...reply,
        fields: [{ path: 'field', kind: 'value', value: '日本語', range: { start: 3, end: 12 } }],
      }),
    ).toBe(true)
  })

  it.each([
    null,
    { start: '0', end: 1 },
    { start: 0, end: '1' },
    { start: 0.5, end: 1 },
    { start: 0, end: Infinity },
    { start: -1, end: 1 },
    { start: 2, end: 1 },
  ])('rejects malformed byte ranges: %j', (range) => {
    expect(
      isEditorReply({ ...reply, fields: [{ path: 'field', kind: 'value', value: '1', range }] }),
    ).toBe(false)
  })
})
