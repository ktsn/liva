# MVP implementation plan

Status: milestones 0–5 are implemented. This document retains the acceptance
criteria; the [validation record](validation.md) describes the evidence and bounded
MVP decisions. Run `sh scripts/verify.sh` to reproduce the automated checks.

## Scope

Build an animated toggle in a normal Vue/Vite page, then edit its animation in
that same page. Demonstrate `off`/`on`, track color, thumb translation/scale,
tweens, both spring modes, intermediate keyframes, directional inheritance,
interruptions, independent instances, in-memory preview, and persisted source edits.

Every state must explicitly declare all animated target/property values in the
MVP. After the MVP, omitted values will be resolved from the actual DOM; sampling
and restoration semantics remain future design work.

Non-goals: DOM fallback for omitted state properties, custom CSS interpolation, reusable timelines, user-defined functions,
standalone `.liv` imports, other framework adapters, formatter/linter/LSP,
complex gestures, spring velocity preservation, and isolated component previews.
Do not add infrastructure for these capabilities preemptively.

## Milestone 0 — Specification review

Deliverables are [vision](vision.md), [language](language.md),
[architecture](architecture.md), this plan, and [AGENTS.local.md](../AGENTS.local.md).
Workspace manifests are specified in the architecture document and will be created
at their implementation milestones.

Acceptance criteria:

- Confirmed decisions and unspecified implementation details are visibly distinct.
- Language decisions L1–L10 and architecture decisions A1–A7 are confirmed;
  implementation validation gates remain.
- Module dependencies, IR contracts, editor commit behavior, and production
  boundaries are reviewable without reading implementation code.
- Each subsequent milestone has a bounded proof, tests, and a stopping condition.

Verification: review cross-document consistency and local links; do not claim
parser, browser, or build tests have passed before those systems exist.

## Milestone 1 — Rust syntax and lossless CST

Apply confirmed L7 and A1; validate Rowan through E1. Bootstrap Cargo with `liva_syntax` only. Implement tokenization,
generic call structure, raw-value boundaries, recoverable parsing, typed AST views,
and byte-based diagnostics. Use Rowan unless the bounded experiment disproves fit.

Acceptance criteria and tests:

- The language example parses; concatenating tokens reproduces input byte-for-byte,
  including invalid fixtures, comments, CRLF, Unicode, and optional semicolons.
- Case tables cover newline/semicolon property separators and comma-separated
  arguments in same-line and multiline calls. Commas inside nested parentheses
  remain raw value text; the matching outer `)` closes the call without a final
  separator. Include multiple nesting levels, CSS function commas, CRLF,
  strings/comments containing delimiters, missing argument commas, and invalid
  semicolon-separated arguments. Verify equivalent results with and without a
  trailing comma. Leading commas, consecutive commas, and multiple trailing commas
  must produce syntax diagnostics. Distinguish an empty argument list from empty
  arguments; missing required arguments are semantic errors. Cover bracket grouping
  and raw property grouping under confirmed L7.
- Identifier cases accept the confirmed ASCII name format, preserve case, and
  reject names outside that format for animations, states, and targets. Property
  name cases accept standard CSS names and custom-property names such as `--offset`;
  CSS property support and value validity are delegated to the browser under L8.
- Missing braces, incomplete calls, malformed frames, and unexpected tokens emit
  bounded diagnostics and retain later constructs where recovery is safe.
- Truncating every prefix of representative fixtures never panics or loops.
- AST reads of incomplete nodes are safe. No CSS interpolation or semantic timing
  interpretation appears in this crate.

Gate: verify recovery behavior and byte-range invariants before compiler work.

## Milestone 2 — Semantic analysis and Definition IR

Apply confirmed L1, L2, L4–L6, and the L8 pass-through policy. Add `liva_compiler`;
validate names, references, duplicate declarations, timing signatures, and frames.
Add `liva_wasm` only for the Node boundary experiment. Establish schema fixtures.

Acceptance criteria and tests:

- Valid input produces deterministic, immutable, DOM-independent Definition IR.
  No source maps or mutable state appear in the production bundle.
- Named argument reorderings produce equivalent timing. Unknown/duplicate/mixed
  arguments, invalid units/ranges, missing state references, duplicate offsets,
  and inherited spring/intermediate-frame conflicts produce actionable diagnostics.
- Missing animated target/property declarations in any state produce a clear
  MVP completeness diagnostic. This check is separate from the IR representation
  so future DOM-based resolution can allow omissions without inserting defaults.
- Golden fixtures retain raw CSS, preserve transition layers, normalize time and
  offsets, and omit synthesized endpoints from Definition IR.
- Rust-to-JSON-to-TypeScript fixtures agree, including absent fields and Unicode;
  unsupported schema versions fail clearly.
- Invalid definitions cannot replace a valid dev definition; production compilation
  fails on errors. Source-map envelopes identify editable fields separately.
- Node loads the compiler WASM from a clean build without requiring browser APIs.

Gate: stabilize the small contract before runtime and Vite depend on it.

## Milestone 3 — Runtime and browser execution

Apply confirmed L3–L5, L8, and L9. Apply A3, A5, and A7, and determine spring calibration through E3.
Bootstrap pnpm, the pinned Vite+ toolchain, and the runtime package. Use the
globally installed `vp` directly in development and CI. Implement pure resolution first, followed by WAAPI execution.

Acceptance criteria and tests:

- Table-driven resolver tests cover every merge row in language.md, inheritance
  preservation, atomic timing/frame replacement, equal-state pulses, endpoint
  completion, explicit endpoints, and spring/frame rejection.
- Browser tests prove `background-color`, `translate`, and `scale` animate using
  browser interpolation. Different property timings share a coordinated start.
- Tween tests seek to controlled times to distinguish interval easing from global
  easing. Test CSS keywords, `cubic-bezier()`, `steps()`, and `linear()` inputs.
- Both spring modes reach the destination; a low-damping translation visibly
  overshoots. Numeric solver tests cover determinism, convergence, duration-mode
  mapping, sample-error tolerance, and maximum-cap diagnostics.
- Reverse a running animation at several progress points. Captured computed values
  immediately before and after interruption match within property-specific numeric
  tolerances; no single-frame flash or stale completion callback is allowed.
- Same-state requests, initial state, zero-duration tweens, invalid states,
  reduced-motion changes, missing targets, and disposal have explicit assertions.
- No orphan effects remain after completion or unmount. Concurrent instances do
  not share mutable state. Arbitrary property names and values reach the WAAPI
  adapter without CSS validation or support probes. Cover unknown names, invalid
  values, custom properties, shorthands, and overlapping transform properties;
  browser no-ops or discrete results are acceptable, not test failures.
- Verify required WAAPI name mapping, including custom properties and metadata-name
  collisions. Actual API exceptions are contained, reported, and cleaned up under
  the confirmed exception policy; a later valid transition still works. No diagnostic
  is required for a property the browser silently ignores.

Use actual WAAPI in the Chromium, Firefox, and WebKit test matrix. Record
versions and any deliberate baseline exclusions after the spring experiment.
Prefer controlled `currentTime`/frame sampling over arbitrary sleeps; use computed
style assertions with justified tolerances and a small visual smoke check.

Gate: do not build the editor on top of an unproven spring/interruption path.

## Milestone 4 — Vue/Vite integration and real playground

Apply confirmed L10, A2, and A4, validating the integration through E2 and E5. Add Vue/Vite packages and the normal playground app. Keep
the requested directives if the integration experiment validates supported APIs.

Acceptance criteria and tests:

- Compile an inline `<liva>` block in `<script setup>` SFCs in dev and production.
  Syntax diagnostics map back to the correct SFC lines, including non-ASCII prefixes.
- Show two toggles sharing a definition and a second named definition without
  registry collisions. Each toggle keeps independent application and animation state.
- A root that is also `track`, child `thumb`, nested roots, conditional targets,
  repeated mount/unmount, and component instances have deterministic registration.
- Click and keyboard activation drive Vue state and `aria-checked`; rapid input
  demonstrates interruption while the app remains usable.
- Invalid source HMR retains the last valid definition; fixing it restores updates.
  Valid HMR may reload the component initially and must not leak old instances.
- Vite+ dev, test, and build commands work with the Vue custom-block plugin and
  Node WASM compiler. Root checks cover TS, Vue SFC/template checks run explicitly,
  and formatting preserves `<liva>` source. Verify shared test configuration and
  WASM task ordering/invalidation from a clean checkout.
- A clean build loads the compiler artifact and produces a working application.
  The production client does not bundle Rust/WASM compilation or editor code.

Gate: freeze the minimal definition/instance lookup contract before editor work.

## Milestone 5 — In-page editor and source editing

Apply confirmed A6 and validate source-edit insertion rules through E6. Add development editor modules inside
`packages/vite`, an instance registry, transient preview, and guarded commits.
No separate editor package or component preview application is required.

Acceptance criteria and tests:

- Select either visible toggle and inspect states, transitions, timing, and frames.
  Show inherited versus local values. Edit tween duration/easing, duration-spring
  duration/bounce, physics-spring parameters, and tween keyframe values/offsets.
- Preview changes only the selected instance and produces zero disk writes.
  Out-of-order preview replies cannot restore stale values. Cancel resynchronizes
  with the latest Vue-requested state and committed definition.
- Saving updates source and both shared-definition instances after HMR. Tests
  cover replacing a value, inserting a directional override, and adding/removing
  an intermediate keyframe. Reject offsets that collide after normalization.
- Byte-for-byte assertions prove unrelated script/template text, comments,
  whitespace, and line endings are preserved. Include comments inside edited
  values, emoji, CRLF, and several edits in one transaction.
- Stale full-file hashes, concurrent saves, invalid edits, outside-root paths,
  symlink escapes, invalid sessions/origins, and oversized requests are rejected.
  Failed saves preserve both the file and the user's draft. Duplicate request IDs
  do not write twice. External edits invalidate stale preview revisions.
- Production bundle inspection finds no editor UI, source paths/maps, compiler,
  bridge, token, or source writer. Requests to editor endpoints fail on the static
  preview server, including a build made with mode named `development`.

Gate: the complete toggle demonstration and production boundary must pass before
calling the MVP complete. Source preservation and safe conflict handling are
functional requirements, not optional editor polish.

## Smallest experiments and technical risks

Experiments validate the approved design; results are recorded in
[validation.md](validation.md). Each must produce a minimal fixture, a result, and a documented decision before expanding.

| Experiment                      | Risk                                                            | Smallest proof and pass condition                                                                                                     | If it fails                                                                                |
| ------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| E1: CST boundaries              | Opaque CSS and newline separators conflict with recovery        | Parse one multiline Liva call with single-line CSS values plus malformed variants; exact round trip, safe termination, useful ranges  | Refine lexical rules before general parser expansion                                       |
| E2: Node WASM contract          | Packaging and Rust/JS data drift                                | Compile one definition in Node; decode a golden IR fixture and diagnostic with Unicode ranges                                         | Adjust bridge packaging; keep semantics in Rust                                            |
| E3: Spring curve                | Overshoot without CSS interpolation may vary by browser         | Two endpoint translation and color effects driven by sampled `linear()`; compare sampled progress and rendered output across browsers | Evaluate browser-owned sampling or explicitly narrow baseline; no custom CSS interpolation |
| E4: Interruption                | Computed style/cancel ordering may flash or snap                | Reverse translate/color at 25%, 50%, and 75%; verify continuity and final cleanup                                                     | Fix read/write ordering and ownership contract before integration                          |
| E5: Custom block and directives | Definition lookup and hook ordering may depend on Vue internals | One SFC with two roots, root-as-target, child target, nested root, unmount, and HMR; no private APIs                                  | Adopt explicit composable and document template/API change                                 |
| E6: Source patching             | Byte/UTF-16 mismatch or stale writes can corrupt SFCs           | Edit one timing argument and insert a frame in an emoji/CRLF fixture; reject an external edit conflict                                | Reduce editable operations until preservation is proven                                    |
| E7: Dev isolation               | Editor code/write capability may leak into builds               | Build normal and development-named modes; inspect emitted graph and request routes under preview                                      | Split imports/hooks and repeat before editor acceptance                                    |

E1 precedes syntax implementation expansion. E2 precedes integration. E3/E4 precede
runtime completion, E5 precedes adapter commitment, and E6/E7 precede editor
completion. Tiny platform experiments may be done ahead of their full milestone
within the approved implementation plan; dependent layers still require their
prerequisite validation gates to pass.

## Review and release checklist

- Implement the confirmed language and architecture decisions. Determine remaining
  runtime parameters through the stated experiments and update the source documents.
  If evidence requires changing an approved design, document the change explicitly
  rather than letting test fixtures silently redefine semantics.
- Pin tested Vite+, pnpm, Node, and Rust versions and commit lockfiles when workspaces
  are instantiated. Make clean-checkout checks reproducible.
- Record browser support and solver tolerances from measured experiments.
- Run Rust, resolver, browser, integration, source-edit, and production-isolation
  checks at the milestones that introduce those behaviors.
- Keep the playground a normal application. The final walkthrough is: interact,
  select an instance, preview, cancel, preview again, save, verify source, verify
  sibling instances, and verify a production build has no editing capability.
