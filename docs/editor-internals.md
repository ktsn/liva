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
| `timeline.ts`        | Effective tracks and editable definition snapshots                      |
| `communication/`     | Shared protocol, HTTP client, HMR subscriptions and server transactions |
| `client.ts`, `ui.ts` | Development integration and mounting                                    |
| `editor.css`         | Shared base styles                                                      |

Vue custom-element compilation injects `.ce.vue` scoped styles into the shadow
root. Shallow controller snapshots avoid proxying DOM elements and animation
instances. Scope disposal removes subscriptions and invalidates pending preview requests.

Inspect returns source revision and editable fields. Preview sends semantic edits
to the server for compilation and returns instance-local IR without writing files.
Commit persists the validated source and waits for HMR synchronization. Messages
use opaque source identities rather than client-supplied paths or byte offsets.
Development mappings use half-open UTF-8 ranges; Vite converts SFC UTF-16 offsets.

## Source edit planning

`apply_edits` accepts semantic field paths, frame additions/removals, and typed timing/easing
overrides. It resolves paths against fresh compiler mappings,
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

The supported operations are `set`, `timing`, `easing`, `addFrame`, and `removeFrame`.
Typed timing removal reveals inherited timing. Ordinary-value conversion preserves
the required 100% frame. Existing guarded transitions and motion-level lifecycles
can gain missing target/property containers without replacing neighboring source.

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
application composition. Failed saves retain the draft. Save acknowledgment requires
both the current source hash and every mounted shared instance to match; delayed
HMR reports pending synchronization and preserves an idempotent retry. New edits or
selection changes during a save are preserved by a separate user-edit revision.

## Lifecycle editing and playback

Lifecycle track paths are `<motion>/enter/target/<target>/property/<property>`
and corresponding `leave` paths. State-specific lifecycle paths are rejected by
compiler validation. Typed field and frame edits retain comment-preservation guarantees.

Layer composition editing uses source-mapped value, typed timing, and frame operations.
The inspector separates effective declaration provenance from the local write destination.
Runtime playback and editor provenance share `resolveLayerCascade` in
`packages/runtime/src/composition/layer-cascade.ts` for value ownership and independent timing
precedence. Playback evaluates each contribution; inspection retains declaration
references without evaluating expressions. `compositionTransitions` validates
explicit transition selections, and `transitionPropertySources` resolves their
timing precedence. The editor converts these resolved sources into mapping paths
and applies editing restrictions; it does not implement a separate cascade.
Candidates recompile before preview; failed candidates leave the previous draft intact.

`LivaInstance.previewLifecycle` accepts an explicit composition and candidate definition
for layer previews. It resolves the baseline and captures lifecycle expressions once,
without replacing the application definition or state-machine history. It resolves
every mounted target, including repeated targets and targets absent from the active
baseline. The inspector uses the same expression snapshot and lifecycle-only rows.
Evaluated tracks use the common final planner and native materializer. Manual
preview keeps a frozen expression/baseline snapshot for seeking, separate from
live presence environments and completion groups. Paused effects participate in
the executor's existing animation ownership and cleanup. Enter settles to the baseline composition at its end; leave holds its last frame. The
controller restores the committed definition on cancellation and never invokes Vue
presence completion callbacks or removes DOM elements.
