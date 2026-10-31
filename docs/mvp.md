# MVP implementation plan

The repository implements Rust syntax/semantics, Definition IR, WAAPI execution,
Vue/Vite integration and an in-page editor. These subsystems support the
Motion/Parameter/Let/State/Transition language; specifications alone do not establish validation.
Run `sh scripts/verify.sh` to reproduce the checks below. The
[validation record](validation.md) records the browser baseline and bounded choices.

## Language and compiler gate

- Preserve CST bytes, comments, whitespace, UTF-8 ranges and malformed-prefix recovery.
- Parse mandatory `motion` declarations, optional typed parameter lists, function-call initializers, conditional state headers, CSS templates, `@` animation
  declarations and inline keyframes. Keep CSS text separate from typed expressions.
- Validate lowercase primitive types, parameter uniqueness/scope, let expression inference, dependency cycles, call signatures, references/member paths, expression types and exactly
  one fallback. Preserve state order and normalize timing/offsets only.
- Test shorthand resets, longhand order, both spring families, mixed-family errors,
  CSS easing text, frame replacement and inherited spring/frame errors.
- Maintain Rust/JSON/TypeScript fixtures, including reactive toggle and drag card.
  Keep DOM, Vue, source mappings and mutable values outside Definition IR.
- Verify type references remain separate from expressions and malformed parameters
  recover.

Implemented in `liva_syntax`, `liva_compiler` and `liva_wasm`.

## Let bindings and runtime gate

- Typed parameter updates select the last matching state, otherwise the fallback.
  Initial selection settles directly; repeated selection never restarts effects.
- CSS templates use explicit units. Same-state changes update affected properties
  and cancel only their stale effects, preserving unrelated animations.
- Built-in function signatures and implementations live in dedicated `builtins/`
  directories. Test generic call parsing, argument type checks, return-field resolution,
  and per-instance initialization. The drag function owns pointer capture/listeners.
  Verify movement, release, cancellation, lost capture, disposal and target rebinding.
- Release transitions sample the displayed position and return to idle without
  release-velocity propagation. Verify interrupted/repeated interactions and cleanup.
- Retain scalar spring sampling, browser CSS interpolation, reduced motion,
  generation guards, inline-style ownership and independent runtime instances.

Unit tests cover selection, rendering and normalization. Real browser tests prove
WAAPI interpolation, Pointer Events and interruption; mocks do not establish those
behaviors. Run Chromium, Firefox and WebKit through Playwright.

## Vue and playground gate

- Vue Router separates toggle, beacon, and drag into individual pages, mounting
  one demo at a time. The toggle page contains two independent instances.
  Vue passes named parameter objects and never selects states for these examples.
- Keep nearest-root target ownership, nested roots, conditional targets, unmount
  cleanup, compiler diagnostics and last-valid-definition HMR behavior.
- Production keeps immutable definitions and runtime only. Verify both normal and
  `development`-named builds contain no editor, compiler or source-writing service.
- Check TypeScript plus playground and editor Vue templates explicitly.

## Editor and source-writing gate

- Select mounted instances separately from shared source definitions. Inspect
  current states and transition tracks, including the card.
- Edit tween/spring parameters and inline keyframes through the existing timeline.
  Preview remains instance-local; cancel restores application-selected state.
- Save atomic property-track edits with `@` declarations and inline keyframes, retaining unrelated source
  bytes, comments and newline style. Ambiguous comment-containing replacements fail.
- Verify stale revisions, session/origin checks, bounded requests, path confinement,
  atomic writes, HMR synchronization and independent sibling instances.

The editor does not author let bindings or conditions. Dynamic state endpoint templates
remain visible as source text; manually editing one replaces its expression with
the entered CSS value. Card preview uses current variable values, so an idle card's
zero drag offset produces no preview translation; interacting with the card supplies
real offsets. Editing the gesture itself is outside this iteration.

## Explicit boundaries and future decisions

No velocity propagation, inertia, retained states, persistence events, simultaneous
state layers, scroll/orientation sources, arbitrary functions, custom CSS
interpolation, or isolated preview environment. Missing state properties still
fail completeness checks. DOM fallback and runtime keyframe interpolation require
separate semantic design. The local longhand/default policy and built-in subscription lifecycle
choices are specified in [language.md](language.md), not inferred by the editor.
