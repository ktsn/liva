# Architecture and workspace setup

Status: implemented MVP architecture. Decisions A1–A7 are reflected in the code;
[validation results](validation.md) record experiments, tested versions, numerical
parameters, source-edit constraints, and production isolation.

## Module boundaries

```text
liva_syntax <- liva_compiler <- liva_wasm <- packages/vite (build/dev server)
                                                |
                                     serialized Definition IR
                                                v
packages/vue --------------------------> packages/runtime -> DOM / WAAPI
      ^                                         ^
      |                                         |
playground                         packages/vite/editor (development only)
```

Arrows point from consumers to dependencies, except the explicitly labeled IR
flow. The runtime never imports the compiler or Vite; Rust never imports Vue or
DOM concepts. Editor source writes cross a development server boundary.

| Module                 | Responsibility                                                                                              | Excludes                                     |
| ---------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `crates/liva_syntax`   | Tokenization, recovery parser, Rowan CST, typed AST views, syntax diagnostics and byte ranges               | CSS semantics, symbol resolution, DOM        |
| `crates/liva_compiler` | Semantic validation, Definition IR, diagnostic/source-map output; later targeted edit planning              | Runtime state, Vue file discovery            |
| `crates/liva_wasm`     | Thin versioned serialization boundary exposing compilation and later edit planning to Node                  | Business logic or duplicate parser           |
| `packages/runtime`     | Pure track resolution, spring progress generation, per-instance state, DOM/WAAPI execution                  | Source parsing, framework state, file writes |
| `packages/vue`         | Directive registration, definition lookup, target lifecycle, runtime instance disposal                      | Compiler or Vite dependency                  |
| `packages/vite`        | SFC block transform, compiler loading, dev mapping cache, HMR, development editor/bridge and guarded writes | Production editor service                    |
| `playground`           | Normal Vue app demonstrating and testing the integrated workflow                                            | Isolated preview environment                 |

Keep the editor inside `packages/vite` initially, with distinct server/client
entry points. Split a package only when a real dependency or reuse need appears.

## Rust syntax infrastructure

Use Rowan as the first CST candidate. A hand-written recovery parser emits nodes,
tokens, and diagnostics while preserving trivia. Typed AST views wrap syntax nodes
and return optional fields for incomplete input. Semantic analysis consumes these
views and emits validated data without putting semantic state into the tree.

[Rowan](https://docs.rs/rowan/latest/rowan/) provides generic lossless tree
primitives. [rust-analyzer's syntax design](https://rust-analyzer.github.io/book/contributing/syntax.html)
motivates separating syntax from meaning and retaining invalid input.
[Biome's architecture](https://biomejs.dev/internals/architecture/) is a reference
for structured diagnostics and recoverable tooling. These are architectural
references, not dependencies on their full language tooling stacks.

Start with whole-block reparsing and hand-written typed views. Incremental parsing,
generated grammars, formatter infrastructure, and an LSP are not prerequisites.

## Compiler boundary and Definition IR

Compiler boundary: `compile(source, options)` returns an envelope containing
`schemaVersion`, valid definitions, diagnostics, and optional development mappings.
The source argument is the UTF-8 contents of one Liva block; Vite owns its enclosing
SFC location. Production serialization includes only the Definition IR. The
compiler owns the schema; maintain a small TypeScript mirror checked against Rust
serialization fixtures before adding a type-generation dependency.

The following describes data contracts, not executable source:

```text
DefinitionBundle {
  schemaVersion: 1
  definitions: Definition[]
}
Definition {
  name: string
  states: State[]
  generalTransition?: Transition
  directionalTransitions: { from: string, to: string, transition: Transition }[]
}
State {
  name: string
  targets: { name: string, properties: { name: string, value: string }[] }[]
}
Transition {
  timing?: Timing
  targets: { name: string, properties: PropertyTransition[] }[]
}
PropertyTransition {
  name: string
  timing?: Timing
  keyframes?: { offset: number, value: string, easing?: string }[]
}
Timing =
  { kind: "tween", durationMs: number, easing: string }
  | { kind: "spring-duration", durationMs: number, bounce: number }
  | { kind: "spring-physics", stiffness: number, damping: number, mass: number }
```

Offsets normalize to `[0, 1]`; times normalize to milliseconds. CSS values and
easing remain strings. Preserve definition/state/target/property source order for
inspection and sort frame offsets semantically. `keyframes` absent means inherit;
an empty array has no source-level override meaning and is not emitted. Timing
arguments have already been validated and defaults applied within each atomic
value. Transition inheritance and missing endpoints remain unresolved.

The compiler can validate every state pair's effective configuration without
serializing a flattened transition matrix. This catches inherited spring/frame
conflicts early while keeping runtime resolution explicit and independently tested.

Definition IR contains no DOM handles, source paths, source ranges, clocks,
instance IDs, mutable caches, or animation objects. Deeply read-only TypeScript
views discourage accidental mutation. Reject unsupported schema versions at the
boundary. JSON encoding must reject non-finite numbers and escape embedded source
safely when generating JavaScript modules.

## Resolved animation contract

```text
ResolvedAnimation {
  fromState: string
  toState: string
  tracks: {
    target: string
    property: string
    timing: Timing
    keyframes: { offset: number, value: string, easing?: string }[]
    destinationValue: string
  }[]
}
```

Each track has resolved timing and explicit endpoints, with no remaining
inheritance. The executor separately binds logical targets to DOM elements and
owns WAAPI objects; they do not enter reusable definitions. Spring curves and
browser property-name conversion belong to execution, not to the language model.

Resolution order:

1. Validate the requested state and target bindings; select the general and exact
   directional transition using the logical source state.
2. Merge property settings and resolve timing using language decision L2. Schedule
   state differences and explicitly keyed tracks under L3.
3. Complete missing endpoints from source/destination state values. During an
   interruption, replace the first frame with the displayed value even if an
   explicit `0%` was authored. Preserve remaining frames and restart their full
   timeline; do not attempt to preserve partial progress or spring velocity.
4. Validate Liva track structure and timing constraints, normalize interval easing, and pass resolved
   tracks to the executor together with destination values for settlement.

## Future resolution of omitted state properties

The MVP compiler requires complete state property declarations. This validation
constraint must not become a permanent assumption of the language or IR schema.
After the MVP, omitted values will be resolved from each instance's actual DOM
at transition resolution time, with the precise sampling point still to be designed.
Definition IR must retain the distinction between an omitted declaration and an
explicit value; never replace an omission with a compile-time CSS default.

DOM-derived values belong to instance-local resolution inputs and resolved tracks,
not shared Definition IR. Two instances can therefore resolve the same definition
to different values. Keep the pure resolver testable by supplying captured values
as inputs when this feature is introduced. No DOM fallback or additional abstraction
is required for the MVP.

Before implementing the feature, decide whether to sample underlying computed
styles or currently displayed animated values, when to refresh snapshots, and how
to remove Liva-owned inline overrides when returning to an omitted destination.
These choices must account for CSS cascade changes and active effects. The existing
interruption snapshot behavior does not decide those semantics.

## Runtime lifecycle and interruption

An instance owns its root, target bindings, requested state, animation generation,
active effects, and original inline property values/priorities. Instance lifecycle:
`create -> bind -> apply initial state -> transition* -> dispose`.

For each update, batch-read displayed values for the union of old active and new
tracks using computed style before canceling anything. Validate Liva constraints
and prepare the next tracks before disturbing current effects; do not validate
CSS properties or values. Cancel old effects, retain captured
values as the temporary baseline, then start new tracks in the same rendering
turn. Tracks that do not need motion settle to destination state values. Use one
WAAPI effect per target/property so timing stays independent, with a shared
start time for coordinated motion. Translate kebab-case property names into WAAPI
keyframe keys through the adapter; do not change the language's spelling. Preserve
custom-property names and handle WAAPI aliases/reserved metadata keys (for example,
CSS `offset` maps to `cssOffset`) without treating them as support checks.

Pass arbitrary CSS properties and values through without an allowlist or
`CSS.supports()` preflight. Browser-ignored input and lack of visible motion are
acceptable; do not synthesize errors by inspecting computed output. Overlapping
shorthands/longhands and transform combinations follow browser behavior, without
Liva conflict validation. See the browser's
[keyframe processing rules](https://www.w3.org/TR/web-animations-1/#processing-a-keyframes-argument).

**Confirmed exception policy:** catch actual WAAPI construction/playback exceptions
and report the affected instance/track with the original error. Clean up partially
created effects for that request and keep the runtime usable for subsequent state
changes. This is exception containment, not CSS validation. Ignored properties
need neither a diagnostic nor a fallback, and are not treated as failed requests.

The runtime's optional paused transition mode prepares the same effects without
completion callbacks. Effects use backwards fill over a destination-state inline
baseline, allowing repeated forward/backward seeks and correct settlement at each
track's end. Manually paused effects survive reduced-motion changes; the editor
stops automatic playback when that preference becomes active. The editor owns the
playhead clock, server validation, and restoring the application's requested state.
See the [timeline editor guide](editor.md) for controls and lifecycle behavior.

On completion, write the destination values to inline style and cancel filled
effects. Catch cancellation rejections and guard completion callbacks with the
animation generation so stale effects cannot overwrite newer states. On disposal,
cancel effects and restore original inline values only where Liva still owns them.
Require exclusive ownership of animated properties: competing Vue style bindings,
CSS transitions, and external animations on those properties are unsupported.

Invalid state requests leave the prior valid state unchanged and emit a diagnostic.
Missing/duplicate targets suspend the affected instance with diagnostics; target
removal cancels its effects. Rebinding applies the current requested state without
replaying old transitions. The reduced-motion policy settles immediately
when `prefers-reduced-motion: reduce` is active; controls and application state
continue working. Initial mount never animates from an unspecified state.

The lifecycle policies, including L9 initial-state and repeated-state behavior,
are confirmed. None of these behaviors is proven by a DOM mock. In particular,
computed serialization, CSS variables, layout-dependent units, and cancellation
ordering require real browser experiments.

## Spring execution without CSS interpolation

A spring solver computes scalar progress, not colors, translations, or scales.
For physics mode, use normalized displacement from 0 to 1, zero initial velocity,
and the equation `mass * x'' + damping * x' + stiffness * (x - 1) = 0`.
Spring termination requires both displacement and velocity below tolerances for
a sustained interval, with a maximum duration/sample cap. The calibrated tolerances, caps, duration-mode mapping, and measured browser
results are recorded in [implementation validation](validation.md#runtime-spring-calibration-and-interruption-e3e4). An exhausted cap must be reported, not silently treated as
physical convergence.

First validation experiment: sample progress into CSS `linear()` easing stops
with monotonic input times, retain overshoot in output progress, and let WAAPI
interpolate two raw endpoint values. The
[CSS Easing Level 2 specification](https://www.w3.org/TR/css-easing-2/)
describes piecewise linear easing, including output progress beyond the unit
interval. This is a design route, not evidence of equivalent browser behavior.

Generating sampled CSS property values would require interpolation that Liva
explicitly excludes. If `linear()` is insufficient, investigate browser-evaluated
sampling into WAAPI keyframes without introducing a CSS value interpolator.
Do not silently clamp spring overshoot or replace a spring with a tween. Narrow
the supported browser baseline explicitly if the experiment requires it. Keep
all such execution choices outside Definition IR.

WAAPI effect easing and keyframe easing have distinct roles in the
[Web Animations specification](https://www.w3.org/TR/web-animations-1/).
For tween tracks, the confirmed interval policy (L4) uses linear effect easing and
resolved per-keyframe easing. For springs with endpoints only, use the sampled
progress curve as effect easing with linear endpoint intervals.

## Vue and Vite integration

The [official Vue plugin custom-block example](https://github.com/vitejs/vite-plugin-vue/tree/main/packages/plugin-vue#example-for-transforming-custom-blocks)
exports a function that receives and augments the compiled component. Follow this
pattern for a generated definition attachment instead of rewriting `<script setup>`.
Match parsed custom-block request parameters, not a fragile substring/regex alone.
Use the SFC descriptor to locate the inline block and derive ranges; reject `src`
blocks under confirmed L10. Cache compilation by source hash and compiler version.

Integration design:

1. `@vitejs/plugin-vue` handles SFC compilation. The Liva transform handles its
   custom-block request, compiles it through Node-loaded WASM, and exports a
   component-augmentation function holding immutable definitions.
2. An explicitly installed Vue plugin registers `v-liva` and `v-liva-target`.
   A root directive obtains its declaring component's attached definitions via
   supported directive instance/component options access. Prove that lookup works
   for `<script setup>` before fixing the API.
3. Target directives record target names in a `WeakMap<Element, ...>`. A root
   directive registers an instance. Reconcile after mount/update in a queued pass
   so child/parent hook order and both directives on one element do not matter.
4. Assign targets to the nearest registered root, including the root itself; never
   cross a nested root. One name binds one element within an instance. The same
   definition name on another root creates a separate instance.
5. Directive updates submit new state strings. Unmount removes bindings, effects,
   registry entries, and editor selections.

[Vue directive hooks](https://vuejs.org/guide/reusability/custom-directives.html)
provide mount, update, and unmount integration. Prefer native-element directives;
component-root forwarding, Teleport targets, cross-component target ownership,
Shadow DOM traversal, and SSR animation are outside the first proof of concept.
An explicit composable with element refs is the fallback if supported component
lookup proves inadequate; compiler-injected imports are another option but require
more transform coupling. Record the experiment's outcome before adopting either.

The integration API preserves the requested template:

```vue
<script setup lang="ts">
import { ref } from 'vue'

const checked = ref(false)
</script>

<template>
  <button
    v-liva:toggle="checked ? 'on' : 'off'"
    v-liva-target:track
    role="switch"
    :aria-checked="checked"
    @click="checked = !checked"
  >
    <div v-liva-target:thumb />
  </button>
</template>

<liva>
  // Insert the toggle definition from language.md here.
</liva>
```

This is an integration shape, not a runnable fixture. The playground milestone
must use the complete definition and explicit application plugin installation.

## Development editor and source edits

Use Vite's development hooks for middleware, client injection, and custom messages;
these extension points are documented in the
[Vite Plugin API](https://vite.dev/guide/api-plugin). Keep compilation active for
both builds and development, but enable editor injection and write handlers only
for a real development server. Production builds, including builds using a
custom `development` mode name, must contain neither capability. Do not enable
writers in the static preview server.

The runtime dev registry exposes instance IDs, definition IDs, roots, current
state, and resolved-track inspection. Definition IDs are development associations
(file/block/name), not production IR fields. Instance IDs are unique per mount.
The injected editor selects page instances and edits definition-level data.
Preview overrides are copy-on-write and instance-local. The editor may request
runtime-only playback without mutating Vue refs; a subsequent application update
supersedes that preview. Cancel restores the committed definition and latest
application-requested state.

Editor messages:

| Message | Required data                                                    | Result                                                      |
| ------- | ---------------------------------------------------------------- | ----------------------------------------------------------- |
| Inspect | Instance ID                                                      | Definition/revision and editable field metadata             |
| Preview | Instance ID, base revision, sequence, semantic field edits       | Validated transient override or diagnostics; no disk writes |
| Cancel  | Instance ID                                                      | Discard override and resynchronize                          |
| Commit  | Definition ID, full-file base hash, structured edits, request ID | New revision and HMR, or conflict/diagnostics               |

Validate preview edits through the compiler's semantic rules using transient
source edits on the server, then send only validated IR to the chosen instance.
Coalesce rapid requests; ignore replies older than the newest sequence. Start
with this path instead of a second browser compiler or duplicated validators.

Development mappings live in a separate envelope keyed by semantic paths such as
`definition/transition/target/property/timing/argument`. Each mapping includes a
revision and half-open UTF-8 byte ranges relative to block source. Reparse after
every committed change; no promise of stable CST node identity across revisions.
Vite converts SFC descriptor offsets from JavaScript UTF-16 to UTF-8 explicitly.
Test non-ASCII text before and inside the block, emoji, CRLF, and multiple edits.
Source maps for generated JavaScript are distinct from these semantic edit maps.

Commit protocol:

1. Resolve the definition ID to a server-known canonical source path; never accept
   an arbitrary client path or byte offset. Require an active dev session token,
   origin checks, bounded payloads, and project-root/path allowlisting.
2. Serialize commits per file and compare the whole-file hash to the supplied base
   hash, including changes outside `<liva>`. Reject stale source rather than
   overwriting it. Resolve symlinks before checking write containment.
3. Parse current source, locate semantic fields, and plan non-overlapping targeted
   replacements. Preserve surrounding trivia. If an edited value contains comments,
   preserve them when unambiguous or reject the edit with a precise explanation.
   Adding a keyframe or override uses local indentation/newline style; ambiguous
   insertion fails safely rather than reformatting the block.
4. Apply edits in descending byte order to an in-memory copy. Reparse and validate
   the result, confirm text outside intended ranges is unchanged, recheck the file,
   then replace it atomically. An atomic rename prevents partial writes but is not
   a filesystem compare-and-swap: a tiny external-writer race remains. Retain the
   previous contents for recovery and document this limitation.
5. Return the new revision and let the normal watcher/HMR pipeline publish it.
   Deduplicate commits by request ID/revision. Clear preview only after successful
   synchronization; on conflicts retain the draft for explicit rebase or cancel.

The `track` edit replaces one property's local timing and keyframe collection
atomically. Omitted timing or frames restore inheritance independently; an empty
frame collection also means inheritance because the language has no empty override.
Missing transition/target/property containers are inserted as needed. Existing
property blocks containing comments reject replacement to preserve comment
placement. Unrelated source remains byte-for-byte intact. Opaque field values are
validated as single declarations and protected from generated indentation.

General settings can be inherited by the selected direction. The editor must show
where a value comes from and offer an explicit directional override, avoiding
accidental edits to all directions. A successful save affects every instance of
the definition; a failed save affects none. External HMR invalidates stale drafts.
Start with safe component reload if preserving instances through HMR is uncertain;
state-preserving HMR is a later optimization, while ordinary instances must remain
independent during playback and preview.

## Workspace toolchain

**Confirmed:** use Vite+ (`vite-plus`) for the JavaScript/TypeScript toolchain,
with pnpm workspaces and the Rust Cargo workspace. Vite+ is development tooling,
not a runtime dependency. The Liva integration remains a Vite plugin using Vite's
custom-block, server, and HMR APIs; validate it against Vite+ and its bundled Vite.

The [Vite+ guide](https://viteplus.dev/guide/) documents its unified development,
test, check, and build commands. Assume `vp` is installed globally and available
on `PATH` in development and CI; invoke it directly. Keep the project toolchain
pinned through the local `vite-plus` dependency and lockfile.

## Workspace setup

Create these files and directories only as their implementation milestones begin:

```text
liva/
├── AGENTS.local.md
├── docs/{vision,language,architecture,mvp}.md
├── Cargo.toml
├── Cargo.lock
├── rust-toolchain.toml
├── package.json
├── pnpm-workspace.yaml
├── pnpm-lock.yaml
├── vite.config.ts
├── crates/{liva_syntax,liva_compiler,liva_wasm}/
├── packages/{runtime,vue,vite}/
└── playground/
```

At the syntax milestone, the root Cargo manifest should start with only its real
member, not paths to empty crates:

```toml
[workspace]
members = ["crates/liva_syntax"]
resolver = "3"

[workspace.package]
edition = "2024"
version = "0.1.0"
publish = false
```

Pin a tested stable Rust toolchain supporting edition 2024/resolver 3 at bootstrap;
then add compiler and WASM members when needed. Start with Rowan; add Serde/JSON
for IR and `wasm-bindgen` plus the selected serialization bridge at their milestones.
Produce a Node-targeted WASM artifact for Vite, not a browser runtime dependency.
Do not add a separate JS compiler-wrapper package before it is necessary.

The [Cargo workspace reference](https://doc.rust-lang.org/cargo/reference/workspaces.html)
explains shared manifests and locks. Use a virtual root and commit its lockfile.

pnpm workspace configuration:

```yaml
packages:
  - packages/*
  - playground
```

Use a private root package and ESM packages; use `workspace:*` for internal
package dependencies. Pin an exact pnpm version in `packageManager`, compatible
Node/Vue/Vite+ versions, and the lockfile when bootstrapping. Validate the bundled
Vite version against `@vitejs/plugin-vue` and the Liva plugin. No invented version
pins are part of this design. The [pnpm workspace guide](https://pnpm.io/workspaces)
documents the workspace manifest and local dependency protocol.

Package dependencies: runtime has no Vue dependency; Vue adapter depends on
runtime and peers on Vue; Vite owns the compiler artifact and peers on Vite and
the supported Vue plugin; playground depends on the three packages and Vue.
Use Vite+'s bundled Vitest for JS tests and keep Playwright for browser integration.
Use supported `vite-plus` configuration imports and `vite-plus/test` test imports;
follow the selected release's dependency/alias rules for upstream plugin peers
rather than independently pinning incompatible Vite/Vitest copies. See the
[official integration guidance](https://viteplus.dev/guide/migrate).

Keep shared lint/format configuration in root `vite.config.ts`, with package/app
configs where needed for tests, Vue, and builds. Use root overrides for package
lint/format differences, following the [monorepo guide](https://viteplus.dev/guide/monorepo).
Do not let format commands rewrite `<liva>` contents before custom-block preservation
has been verified. Use Vite+'s task runner for orchestration where needed; do not
add another monorepo task framework.

After the relevant members exist, define package scripts around these commands:

| Purpose                                 | Planned command                                   |
| --------------------------------------- | ------------------------------------------------- |
| JS/TS formatting, lint, and type checks | `vp check` at the root                            |
| JS unit tests                           | `vp test --run` with configured test projects     |
| Playground dev server                   | `vp dev` from `playground`                        |
| Playground production build             | `vp build` from `playground`                      |
| Library packaging                       | `vp pack` in packages that need emitted artifacts |
| Cross-package task orchestration        | `vp run <task>` with explicit dependencies        |

Enable both `lint.options.typeAware` and `lint.options.typeCheck` for TypeScript
checking, as documented in the [check guide](https://viteplus.dev/guide/check).
Verify Vue SFC/template coverage separately at bootstrap and use `vue-tsc --noEmit`
for that coverage where needed; do not assume the generic check covers Vue templates
or the custom DSL. Rust formatting, linting, and tests remain Cargo responsibilities.

CI should run `cargo fmt --all --check`,
`cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`,
the Vite+ checks/unit tests, Vue type checks, Playwright tests, and the playground
production build. Build WASM before dependent Vite+ integration tests and builds.
Any cached task consuming WASM must track its source/artifact inputs or run uncached
until invalidation is proven. Verify packaging and checks from a clean checkout.
The ordered entrypoint is `sh scripts/verify.sh`; `.github/workflows/ci.yml` runs
the same checks. WASM consumers run uncached after an explicit rebuild.

## Confirmed architecture decisions

| ID  | Confirmed choice                                                                | Tradeoff / fallback context                                                                          | Validation gate    |
| --- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------ |
| A1  | Rowan with whole-block reparsing                                                | Custom CST adds maintenance; incremental parsing adds initial complexity                             | Syntax experiment  |
| A2  | JSON envelope through Node WASM; mirrored TS contract with fixtures             | Native addon improves some deployment characteristics but adds platform builds                       | IR/WASM experiment |
| A3  | Sample scalar spring progress into `linear()`                                   | Browser-evaluated value sampling is more complex; CSS interpolation stays out of scope               | Spring experiment  |
| A4  | Component augmentation and nearest-root directive binding                       | Explicit composable is less declarative; script injection couples compilation                        | Vue experiment     |
| A5  | One WAAPI effect per property with shared start time and exclusive ownership    | Grouping effects saves objects but complicates different timing                                      | Runtime experiment |
| A6  | Server-validated instance-local preview and revision-checked targeted commits   | Browser WASM reduces round trips but expands packaging; whole-block formatting violates preservation | Editor experiment  |
| A7  | Require a tested browser baseline; honor reduced motion by immediate settlement | Broad fallback support increases runtime scope                                                       | Browser matrix     |

Primary references were consulted on 2026-10-25; Vite+ references on 2026-10-26. Recheck tool APIs and pin
tested versions when implementing; documentation is not a substitute for the
experiments in the [MVP plan](mvp.md).
