# Implementation decisions and validation

## Syntax (E1)

The syntax crate uses Rowan 0.17 with whole-document parsing and typed `Ast` views.
Byte offsets refer to UTF-8 input. Strings, comments, and escapes are atomic during
boundary scanning; CSS values remain opaque. Blocks are limited to 64 levels to
bound recursive parsing of hostile input. Unclosed value groups recover at an
unquoted closing brace; unterminated strings retain the remaining source.

Run `cargo test --workspace`, `cargo fmt --all --check`, and
`cargo clippy --workspace --all-targets -- -D warnings`.
The syntax tests round-trip every character-boundary prefix of the language
example and malformed Unicode/CRLF fixtures, check diagnostic byte ranges, generic
calls, delimiter recovery, identifiers, and context-sensitive opaque values.
The Rowan experiment passes these losslessness and recovery checks.

Toolchain: Rust 1.97.1; dependency versions are recorded in Cargo.lock.

## Compiler and Node boundary (E2)

Rust owns timing signatures, duplicate/reference checks, MVP completeness, and
all-pairs effective transition validation. Definition IR preserves layers and
explicit frames; it never synthesizes endpoints. Development mappings use semantic
paths with structural `target` and `property` segments to avoid name collisions.
Mappings contain half-open UTF-8 ranges in a separate optional envelope; the caller
associates them with the full-file revision. Production consumers retain only
`schemaVersion` and `definitions`.

`fixtures/toggle.json` fixes the schema against the language example. Run the Rust
checks above, then `scripts/build-wasm.sh` and `node scripts/test-wasm.mjs`.
The Node test loads the actual `wasm-bindgen --target nodejs` artifact, compares
Rust serialization with the fixture, verifies the deeply frozen TypeScript view,
rejects unsupported schemas, and slices Unicode source using UTF-8 mappings.
These checks pass on Node 24.22.1 and wasm-bindgen 0.2.127. The CLI version must
match the pinned Rust dependency. No browser APIs are needed by the compiler.

The boundary uses JSON strings rather than JS object bindings. This keeps one
serialization contract and avoids coupling compiler data to JavaScript handles.
See the [wasm-bindgen Node deployment reference](https://wasm-bindgen.github.io/wasm-bindgen/reference/deployment.html).

## Runtime, spring calibration, and interruption (E3/E4)

The runtime uses one WAAPI effect per property with a shared document timeline
start. Tween easing is attached to intervals; effect easing remains linear.
Spring endpoint interpolation uses browser-owned interpolation and sampled CSS
`linear()` effect easing. Analytic scalar solutions cover underdamped, critical,
and overdamped responses, with zero initial velocity.

Duration mode maps bounce to damping ratio `1 - 0.9 * bounce`. It computes the
unit-frequency settling time, then scales natural frequency to the requested
duration. Duration therefore includes settling; it is not a period or half-life.
Physics mode checks displacement below 0.00025 and velocity below 0.001 per second
for 64 ms. The search step is at most 1/240 s and 0.1/natural-frequency. Physics
search stops with a diagnostic at 10 s or 200,000 solver steps. Easing subdivision
uses 0.0005 scalar midpoint error, a frequency-bounded initial grid, and an 8,192
sample cap. The final progress is exactly one; the tightened displacement threshold
keeps terminal correction within the tested interpolation tolerance. Cap exhaustion
is an error, never a silently substituted tween.

Measured examples (`mass = 1`, stiffness 300):

| Mode | Duration | Samples | Peak scalar progress |
| --- | --- | --- | --- |
| Physics, damping 10 | 1920.83 ms | 352 | 1.38775 |
| Physics, damping 20 | 1062.50 ms | 192 | 1.10833 |
| Duration 350 ms, bounce 0.25 | 350 ms | 96 | 1.02121 |

`vp test --run` checks precedence, atomic frame replacement, equal-value pulses,
endpoints, schema immutability, spring determinism, full-curve sample accuracy,
duration scaling, and explicit cap errors. `pnpm exec playwright test` uses actual
WAAPI in Chromium 156.0.8078.4, Firefox 157.0, and WebKit 27.2 (Playwright 1.64.1).
These are the tested MVP browser baseline; older versions are not certified.

Browser tests seek `currentTime` to controlled positions. They verify color,
translate, and scale interpolation, interval easing including `steps()`/`linear()`,
spring overshoot, shared starts, 25/50/75% reversals, final cleanup, target lifecycle,
reduced-motion changes, instance independence, opaque CSS, exceptions, zero-duration
settlement, and restoration including shorthand side effects. Reversal tolerance
is 0.03 for transform components and 1.1 for serialized color channels. The overshoot
translation matches the scalar solution within 0.1 px. No CSS support probing or
custom CSS interpolation is used.

The pinned local Vite+ 1.4.0 contains Vite 8.3.5 and Vitest 5.0.5; the global `vp`
launcher is 1.1.0. pnpm 12.4.2 reports Vitest's Vite peer range against the wrapper's
1.4.0 version, although its bundled Vite is 8.3.5 and the tests pass. Vue SFCs are
excluded from automatic formatting to preserve custom-block source.

## Vue custom blocks, directives, and HMR (E5)

Vue 3.5.44 and `@vitejs/plugin-vue` 6.0.10 pass the integration experiment. The
Vue plugin emits custom requests with `vue&type=liva&index=0`; Liva parses those
parameters and returns the documented component-augmentation function. Directives
read the custom `livaDefinitions` option through `binding.instance.$options`.
No private Vue instance fields or injected script-setup imports are used.

Targets reconcile in a queued pass against the nearest root and declaring
component instance. The root can also be a target. Nested roots, conditional
children, repeated mounts, two component instances, keyboard operation, and a
second definition are covered by browser tests. Invalid HMR retains the prior
valid definition; a fixed custom block can reload its component. Source-writing
HMR tests run once in Chromium to avoid competing writes to a shared fixture;
ordinary interaction/lifecycle tests run in all three browsers.

The normal page is `playground/`. Its visual smoke check confirms the two-switch
layout and separate beacon definition. Build output contains only Vue, runtime,
and serialized definitions. Native buttons provide Space/Enter interaction and
Vue owns `aria-checked` and application state.

TypeScript 5.9.3 is pinned for `vue-tsc` 3.3.13. TypeScript 7 does not expose the
legacy `lib/tsc` API required by this Vue checker. Vue checking targets SFCs and
application/test sources; `vp check` checks the Vite configurations separately.
Including the Vite configuration in the Vue checker triggers a compiler assertion
in overloaded plugin signatures. This separation preserves both checks.

Run `sh scripts/verify.sh` (or `vp run verify`) for ordered Rust, WASM, JS, Vue,
browser, and production-build verification. WASM is rebuilt before dependent tests
and builds; no artifact caching is configured. Install dependencies with
`pnpm install --frozen-lockfile` and browsers with `pnpm exec playwright install`.

## Targeted source planning (E6, compiler portion)

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

Rust edit tests assert exact byte preservation for multiple Unicode/CRLF edits,
compact CRLF insertions, comment/injection rejection, directional insertion,
frame add/remove, offset movement, and normalized-offset collisions. The WASM
wrapper exposes the same planner; filesystem policy remains a server responsibility.

## Editor transactions and preview lifecycle (E6)

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
64 KiB and 100 edits. It has no arbitrary path input. HTTPS/proxied or remote editor
sessions are outside the MVP; local HTTP development remains supported.

Preview replies carry instance/sequence identity and cannot outlive selection,
application state updates, source revisions, or unmount. Cancel restores the latest
Vue-requested state. Failed saves retain the draft. Save acknowledgment requires
both the current source hash and every mounted shared instance to match; delayed
HMR reports pending synchronization and preserves an idempotent retry. New edits or
selection changes during a save are preserved by a separate user-edit revision.

The UI exposes timing expressions and their existing parameters, frame fields,
frame insertion/removal, and directional timing override insertion. A pending full
expression replacement disables its old parameter controls until save or cancel;
removed-frame controls are likewise disabled. This avoids silently discarding a
mode change or appending edits to deleted paths. States are read-only in the MVP.

Server and controller tests cover byte preservation, backups, stale hashes, invalid
edits, concurrent commits, cross-file request-ID reuse, containment, symlinks,
out-of-order replies, external invalidation, unmount, selection/loading races,
new drafts during save, and failed-save retention. Browser editor tests cover preview
isolation/cancel, source save with shared-instance HMR, override/frame add/remove,
invalid sessions/origins/hosts, oversized requests, and conflicting UI controls.
Source-writing browser cases run only in Chromium; other editor cases run in all
three engines.

## Production isolation (E7)

`scripts/test-production.mjs` builds both `production` and `development` modes,
scans emitted files for editor/source/compiler markers and map/WASM artifacts, then
runs actual playback and POST rejection against each static preview server. Both
modes pass. The plugin keys development behavior on `configureServer`, not the mode
name. Production imports only the Vue adapter and runtime plus immutable definitions.

## Reproducible verification

On 2026-10-26, a fresh source copy with no `node_modules`, `target`, compiler WASM,
or build output passed `pnpm install --frozen-lockfile --offline` followed by
`CI=1 sh scripts/verify.sh`. The dependency store and installed toolchains/browser
binaries were reused; project build artifacts were rebuilt from scratch.

| Check | Result |
| --- | --- |
| Rust formatting and Clippy with warnings denied | Pass |
| Rust syntax / compiler / source edits | 23 tests passed |
| Node WASM and immutable TypeScript schema contract | Pass |
| Vite+ formatting, lint, and TypeScript checking | Pass, no warnings |
| TypeScript runtime / compiler / editor tests | 23 tests passed |
| Vue SFC and template checking | Pass |
| Chromium / Firefox / WebKit browser suite | 57 passed; 6 deliberate skips |
| Normal and development-named production builds | Isolation and playback passed |

The six skips are the Firefox/WebKit copies of three shared-file-writing cases
(invalid/fixed HMR, value save, override/frame save). Their transactions execute
once in Chromium; ordinary runtime, integration, and editor behavior executes in
all three engines. The root runtime harness limits dependency scanning to its own
HTML entry, so it does not try to resolve the playground's virtual editor module
without the playground plugin.

The checked-in GitHub Actions workflow uses the same verification entrypoint and
the official [setup-vp integration](https://viteplus.dev/guide/ci), pinned to
v1.22.0. Preview readiness strips ANSI terminal control sequences before matching
the server URL; CI may colorize the host and port separately. The forced-color
regression command `FORCE_COLOR=1 CI=1 node scripts/test-production.mjs` passes
for both build modes locally.


## Vue editor presentation

The development editor uses Vue SFC templates, props, and typed events. A shallow
controller snapshot drives the panel without proxying DOM elements or animation
instances. Inspection changes reset form controls; ordinary status or registry
notifications retain input values and the draft. Vue scope disposal removes the
controller subscription and pending preview timer, and removing the custom element disposes
the app during module disposal. Vue custom-element compilation injects scoped SFC
styles into Shadow DOM, including child-component styles. `editor.css` contains
only shared base rules and is loaded by the root component. Browser assertions
verify the root layout, form actions, and child field styles in all three engines.

The preview timer reads the current destination and is canceled when selection,
application state, source revision, or mounted-instance availability changes.
Browser regression coverage changes destination immediately after editing, then
verifies that a later application action supersedes the pending preview. Override
and frame save tests operate the rendered Vue controls, including add/remove and
shared-instance synchronization. `tsconfig.editor.json` checks editor scripts and
templates through `vue-tsc` in the standard verification entrypoint.


## Public Vue plugin entry

Application code imports the default plugin from `@liva/vue`. The package exports
an actual typed runtime-only implementation, so type checking and non-Vite imports
work without ambient virtual-module declarations. The Vite plugin intercepts that
exact public entry and generates the development integration only for its dev
server; production imports `@liva/vue/runtime` directly. This runtime subpath also
supports explicit factory use and avoids recursive interception inside the editor.
The public entry is excluded from dependency prebundling so the development
integration cannot be replaced by a prebundled runtime-only entry.

A package-export test installs the public default plugin without the Liva Vite
resolver. The playground and editor fixture use the public import in browser tests;
production isolation checks exercise that same import in both build modes.
