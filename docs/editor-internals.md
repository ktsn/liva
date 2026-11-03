# Editor internals

See [editor.md](editor.md) for controls and [architecture.md](architecture.md) for
runtime and compiler boundaries. The editor changes shared definitions while
previewing one mounted instance. Vue retains application state.

## Components and communication

`packages/vite/src/editor/` contains:

| Location             | Responsibility                                                          |
| -------------------- | ----------------------------------------------------------------------- |
| `components/`        | Vue panel, inspector and timeline rows                                  |
| `controller.ts`      | Selection, drafts, asynchronous previews and save coordination          |
| `timeline.ts`        | Effective tracks, coordinates and snapping                              |
| `communication/`     | Shared protocol, HTTP client, HMR subscriptions and server transactions |
| `client.ts`, `ui.ts` | Development integration and mounting                                    |
| `editor.css`         | Shared base styles                                                      |

Vue custom-element compilation injects `.ce.vue` scoped styles into the shadow
root. Shallow controller snapshots avoid proxying DOM elements and animation
instances. Scope disposal removes subscriptions and pending preview timers.

Inspect returns source revision and editable fields. Preview sends semantic edits
to the server for compilation and returns instance-local IR without writing files.
Commit persists the validated source and waits for HMR synchronization. Messages
use opaque source identities rather than client-supplied paths or byte offsets.
Development mappings use half-open UTF-8 ranges; Vite converts SFC UTF-16 offsets.

## Source edit planning

`apply_edits` accepts semantic field paths, frame additions/removals, and directional
property timing overrides. It resolves paths against fresh compiler mappings,
preserves boundary whitespace, and validates every intermediate edit before returning
a candidate source. Transactions never partially persist. Frame values should be
edited before moving their offset because offset changes their semantic identity.
Inserted blocks use local LF/CRLF and closing-block indentation; compact blocks
receive local newline separators without reformatting neighboring text.

Fields containing comments, and new values introducing comment tokens, are rejected
with an explanation. Quoted comment-like text remains opaque. This conservative
policy avoids moving comments or letting a new line comment consume a neighboring
declaration. Authors can make those edits directly in source.

The WASM wrapper exposes the same planner; filesystem policy belongs to the server.

The `track` operation replaces one property's timing and frames atomically,
creating missing containers. Omitting timing or frames restores their inheritance
independently. An empty frame collection also means inheritance; the language has
no empty override. State-value edits use individual field operations.

## Save transactions and preview lifecycle

The development editor uses opaque source identities registered by the Vite plugin.
The server resolves each source inside the canonical Vite root, verifies a full-SFC
SHA-256 revision, applies Rust-planned changes in memory, and recompiles before a
write. Saves serialize per source; in-flight and completed request IDs prevent
repeated writes. A same-directory temporary file is renamed atomically after a
second revision check. Original bytes are retained in `.liva-backups/<hash>.vue`.
An unrelated process can still write between the final check and rename: filesystem
rename is not a compare-and-swap operation. The backup supports manual recovery.
Do not run source formatters concurrently with editor saves.

The HTTP bridge accepts bounded JSON POSTs only from loopback clients, with a local
Host, matching HTTP Origin, and the active random session token. It accepts at most
64 KiB and 100 edits. It has no arbitrary path input. HTTPS/proxied and remote
editor sessions are unsupported.

Preview replies carry instance/sequence identity and cannot outlive selection,
application state updates, source revisions, or unmount. Cancel restores the latest
Vue-requested state. Failed saves retain the draft. Save acknowledgment requires
both the current source hash and every mounted shared instance to match; delayed
HMR reports pending synchronization and preserves an idempotent retry. New edits or
selection changes during a save are preserved by a separate user-edit revision.

## Lifecycle editing and playback

Lifecycle track paths are `<motion>/enter[/<state>]/target/<target>/property/<property>`
and the corresponding `leave` paths. The atomic track planner creates missing
lifecycle containers and replaces shorthand declarations through their block mapping.
It retains the same comment-preservation and compiler-validation rules as ordinary
transition edits.

State-specific lifecycle IR already includes default inheritance. Development
mappings expose a `<block>/timing` marker for authored timing declarations. Together
with property and frame paths, these markers let the editor reconstruct local
lifecycle settings without serializing source metadata in production IR. The editor
resolves inheritance for its draft; the server recompiles the source for playback.

`LivaInstance.previewLifecycle` captures the selected lifecycle with current
expression values and resolves every mounted target, including repeated targets.
Paused effects participate in the instance's existing animation ownership and
cleanup. Enter settles to state CSS at its end; leave holds its last frame. The
controller restores the committed definition on cancellation and never invokes Vue
presence completion callbacks or removes DOM elements.
