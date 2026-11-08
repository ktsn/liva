# Architecture

See [language.md](language.md) for syntax and semantics, [development.md](development.md)
for build and verification commands, and [editor-internals.md](editor-internals.md)
for preview and source-writing contracts.

## Module boundaries

| Module                 | Responsibility                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------ |
| `crates/liva_syntax`   | Lossless Rowan CST, lexer, recovery parser, typed AST views                          |
| `crates/liva_compiler` | Semantic analysis, diagnostics, Definition IR, source mappings and edit planning     |
| `crates/liva_wasm`     | Node-targeted WASM JSON boundary for compilation and editing                         |
| `crates/liva_lsp`      | Document synchronization, hover, diagnostics and Vue block mapping                   |
| `packages/runtime`     | Expression evaluation, track resolution, springs, instance state and WAAPI execution |
| `packages/vue`         | Directives, target ownership, presence integration and disposal                      |
| `packages/vite`        | SFC compilation, HMR, development editor and guarded source writes                   |
| `editors/zed`          | Language configuration, highlighting grammar and LSP executable lookup               |
| `playground`           | Vue demos and integration fixtures                                                   |

Vite loads the Rust compiler through Node WASM and supplies serialized definitions
to the Vue adapter and runtime. The runtime imports neither the compiler nor Vite.
Rust has no Vue or DOM dependency. Mutable instance state and development source
mappings stay outside Definition IR. The editor lives in `packages/vite/src/editor/`
with separate server and client responsibilities.

## Rust syntax infrastructure

The Rowan CST is the source of truth for syntax and UTF-8 byte ranges. Whole-block
reparsing preserves source text; nesting is limited to 64 blocks to bound recursion. A hand-written recovery parser emits nodes,
tokens, and diagnostics while preserving trivia. Typed AST views wrap syntax nodes
and return optional fields for incomplete input. Semantic analysis consumes these
views and emits validated data without putting semantic state into the tree.
All views implement `liva_syntax::ast::AstNode`, which provides checked casts,
access to the underlying Rowan node, text, and absolute byte ranges. `Document`
exposes `Motion` views; motions expose parameters, let bindings, layers, events,
and animation blocks. `enters()` and `leaves()` select lifecycle declarations;
`transitions()` traverses all animation blocks, including enter and leave.
`animation_properties()` visits direct shorthand declarations and `property ~>` tracks
in source order. It also accepts layer, state, and lifecycle scopes, whose direct
properties lower to `self` without synthetic CST nodes or rewritten source ranges.
These iterators preserve source order, duplicates, and malformed headers so
semantic validation can diagnose them. `events()` exposes event declarations,
with optional name and condition accessors. Targets contain property declarations or property blocks with
keyframes. Expression views (`ast::expression::Expr`, `Name`, and `Argument`)
use the same interface.

Casts classify syntax without requiring semantic validity. Structural roles use
block position and header keywords; incomplete fields return `Option`. Generic
`Block` views and `MotionItem::Invalid` preserve unrecognized items for diagnostics.
Shared `HasHeader`, `HasValue`, and `HasItems` interfaces support validation across
constructs, including misplaced declarations and bindings.

A single lexer produces source-backed tokens for document structure and expressions.
Identifiers include hyphens; numbers with units are dimension tokens. Quoted strings
retain their spelling, with embedded template tokens using the same lexer and absolute
byte ranges. Expression literals decode escapes during lowering; CSS text retains them.

The document parser passes slices of this token stream to the expression parser for
let initializers, layer conditions, transition guards, and interpolations. Both parsers write directly to
the same Rowan builder. No intermediate document tree or expression retokenization is
needed. Interpolation recovery belongs to the parser and stops at an unquoted newline
when the closing brace is missing. The compiler reads the completed CST through typed
views; output-only `liva_compiler::expression::Expression` carries no source locations.

The syntax crate separates these responsibilities:

| Location                                     | Responsibility                                                 |
| -------------------------------------------- | -------------------------------------------------------------- |
| `lib.rs`                                     | Public entry points and parse results                          |
| `kind.rs`, `diagnostic.rs`                   | Rowan kinds, byte ranges, and diagnostic data                  |
| `lexer.rs`                                   | Shared token vocabulary and source-preserving lexical scanning |
| `literal.rs`                                 | Quoted-string boundaries and expression escape decoding        |
| `parser/mod.rs`                              | Structural parsing, recovery, and header validation            |
| `parser/expression.rs`, `parser/template.rs` | Expression parsing and quoted CSS template assembly            |
| `ast/`                                       | Common view interfaces and structural/expression accessors     |

Motion headers contain parameter and type-reference CST nodes, distinct from call
arguments and runtime expressions. Semantic analysis resolves parameters, let bindings, and targets
in one motion-local namespace; instance initialization validates host parameters
separately from creating drag values and browser subscriptions.

[Rowan](https://docs.rs/rowan/latest/rowan/) provides generic lossless tree
primitives. [rust-analyzer's syntax design](https://rust-analyzer.github.io/book/contributing/syntax.html)
motivates separating syntax from meaning and retaining invalid input.
[Biome's architecture](https://biomejs.dev/internals/architecture/) is a reference
for structured diagnostics and recoverable tooling. These are architectural
references, not dependencies on their full language tooling stacks.

## Built-in functions

`crates/liva_compiler/src/builtins/` registers function signatures. Each function
has its own module; `drag.rs` and `interaction.rs` declare target arguments and typed return fields.
The compiler places functions, easing constants, and the reserved `self` target in a
built-in parent scope. A Motion child scope holds parameters, named targets, and let
bindings; all names are declared before dependency inference. Same-scope duplicates
are errors, while child declarations shadow ordinary built-ins. Parameters and let
bindings cannot rebind `self`; an explicit self block configures the existing root
without introducing a variable. References, calls, hover, and completion use the
same symbol lookup. The generic call checker evaluates argument
types through the expression checker and selects a matching overload. Required
arguments and incompatible overload groups produce diagnostics.
Let type inference follows dependencies and rejects cycles. Expression member checking
follows the variable's inferred type. The syntax parser
uses ordinary call/argument nodes without knowing any built-in function names.

`packages/runtime/src/builtins/` registers the implementations. `drag.ts` defines
`drag`, its per-instance value, and Pointer Events handling. `interaction.ts` reads browser
pseudo-class snapshots and coalesces event-triggered rechecks. A built-in subscription
returns a value and a binding function whose cleanup releases browser resources.
`LivaInstance` delegates handle binding and cleanup to the let graph without
built-in-specific branches. The let binding graph reevaluates expressions in dependency order before
layer resolution and template rendering. `FunctionResult` is a `RuntimeValue`,
`ReactiveSubscription`, or stateful `ReactiveCall`, defined in `reactive-value.ts`. The runtime recognizes subscriptions by their `value` and
callable `bind` members. Ordinary records remain ordinary values. Each call site
caches its evaluated arguments and result; unchanged arguments reuse that result.
Subscription results expose their latest value. Changed arguments invoke ordinary
functions again or prepare an update on a retained `ReactiveCall`. Nested calls use the same evaluation rules. Active subscriptions
are bound and cleaned up when branches or returned results change. Call-site caches
are committed only after the complete graph evaluates successfully. Replacing a definition retains handles for matching initializers and arguments;
cleanup releases gestures before reattachment while preserving retained offsets.
Before evaluating let initializers, the runtime creates target values from the
motion's declared targets and merges them with host parameter values. All argument
expressions evaluate against this environment. Target values identify bindings in
the current instance, so two instances can resolve the same name to different DOM
elements. The expression evaluator returns variable values and traverses record
members; operators and CSS templates require scalar values.

## Compiler boundary and Definition IR

Compiler boundary: `compile(source, options)` returns an envelope containing
`schemaVersion`, valid definitions, diagnostics, and optional development mappings.
The source argument is the UTF-8 contents of one Liva block; Vite owns its enclosing
SFC location. Production serialization includes only the Definition IR. The
compiler owns the schema; a TypeScript mirror is checked against Rust serialization
fixtures.

The following describes data contracts, not executable source:

```text
DefinitionBundle {
  schemaVersion: 1
  definitions: Definition[]
}
Definition {
  name: string
  parameters?: MotionParameter[]
  letBindings?: LetBinding[]
  events?: { name: string, when: Expression }[]
  layers: Layer[]
  enter?: Transition
  leave?: Transition
}
Layer {
  name: string
  when?: Expression
  timingExpression?: Expression
  targets: Target<Property>[]
  states?: State[]
  initialState?: string
  transitions?: { from: string, to: string, when: Expression, transition: Transition }[]
}
State {
  name: string
  timingExpression?: Expression
  targets: Target<Property>[]
}
Target<T> {
  name: string
  timingExpression?: Expression
  timingProperties?: string[]
  properties: T[]
}
Property {
  name: string
  value: string
  template?: (string | Expression)[]
  timingExpression?: Expression
  keyframes?: Frame[]
}
Transition {
  timing?: Timing
  timingExpression?: Expression
  targets: Target<PropertyTransition>[]
}
PropertyTransition {
  name: string
  timing?: Timing
  timingExpression?: Expression
  keyframes?: Frame[]
}
Frame {
  offset: number
  value: string
  template?: (string | Expression)[]
  easing?: string
  easingExpression?: Expression
}
Timing =
  { kind: "tween", durationMs: number, easing: string }
  | { kind: "spring-duration", durationMs: number, bounce: number }
  | { kind: "spring-physics", stiffness: number, damping: number, mass: number }
```

`MotionParameter` contains a name and a lowercase `number`, `boolean`, or `string`
type. It contains no runtime value. `LetBinding` represents a `let` binding and contains a name and an `Expression`
initializer. Call expressions contain a function name and named argument expressions. Target variables use ordinary
`{ kind: "reference", path: ["body"] }` expressions. `Expression` is a
tagged scalar/reference/call/unary/binary tree, validated in Rust and evaluated without
JavaScript code generation. CSS templates retain the original opaque `value` for
inspection and expose text/expression segments for runtime rendering. The IR uses schema version 1. The compiler
requires at least one layer and one initial state per stateful layer. Manual editor
playback selects compositions without evaluating guards.

Offsets normalize to `[0, 1]`; times normalize to milliseconds. CSS values and
easing remain strings. Preserve definition/state/target/property source order for
inspection and sort frame offsets semantically. `keyframes` absent means inherit;
an empty array has no source-level override meaning and is not emitted. Timing
arguments have already been validated and defaults applied within each atomic
value. Ordinary transition inheritance and missing endpoints are resolved at runtime;
motion-level lifecycle tracks are compiled as described below.

The runtime resolves layer timing against current inputs without serializing a
flattened transition matrix. Production IR contains neither source ranges nor
mutable application state.

Definition IR contains no DOM handles, source paths, source ranges, clocks,
instance IDs, mutable caches, or animation objects. Deeply read-only TypeScript
views discourage accidental mutation. Reject unsupported schema versions at the
boundary. JSON encoding must reject non-finite numbers and escape embedded source
safely when generating JavaScript modules.

## Resolved animation contract

```text
ResolvedTrack {
  target: string
  property: string
  timing: Timing
  keyframes: { offset: number, value: string, easing?: string }[]
  destinationValue: string
}
```

Each track has resolved timing and explicit endpoints, with no remaining
inheritance. The executor separately binds logical targets to DOM elements and
owns WAAPI objects; they do not enter reusable definitions. Spring curves and
browser property-name conversion belong to execution, not to the language model.

Resolution order:

1. Validate parameters and resolve ordinary layer activation and retained local
   states. Advance each stateful layer at most once through the last eligible guard.
2. Cascade property values and timing independently. Only the final value owner's
   selected transition supplies temporary timing and frames. Schedule changed values
   and explicit tracks, including equal-value pulses.
3. Complete omitted endpoints from displayed presentation and resolved destination.
   During interruption, replace the first frame with the displayed value. Retain
   remaining frames and restart their full timeline without preserving velocity.
4. Validate resolved track structure and timing, normalize interval easing, and pass
   tracks with destination values to the executor.

## Runtime lifecycle and interruption

An instance owns parameter values, let values and built-in subscriptions, target bindings, layer selections, animation generation,
active effects, and original inline property values/priorities. Instance lifecycle:
`create -> bind -> settle composition -> update* -> dispose`.

`updateParameters` accepts a complete named parameter snapshot and reevaluates
selection and templates.
Definition replacement retains values for parameters with matching names and types
and removes obsolete values. A new required parameter or incompatible type rejects
the replacement before changing the instance or its effects; no defaults are supplied.
Matching drag bindings retain offsets while releasing active gestures.

For each composition or rendered-value change, batch-read displayed values for the union of old active and new
tracks using computed style before canceling anything. Validate Liva constraints
and prepare the next tracks before disturbing current effects; do not validate
CSS properties or values. Cancel old effects, retain captured
values as the temporary baseline, then start new tracks in the same rendering
turn. Tracks that do not need motion settle to resolved destination values. Use one
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

Catch actual WAAPI construction/playback exceptions
and report the affected instance/track with the original error. Clean up partially
created effects for that request and keep the runtime usable for subsequent input
changes. This is exception containment, not CSS validation. Ignored properties
need neither a diagnostic nor a fallback, and are not treated as failed requests.

The runtime's explicit composition preview prepares the same effects without
completion callbacks. Effects use backwards fill over a resolved-destination inline
baseline, allowing repeated forward/backward seeks and correct settlement at each
track's end. Manually paused effects survive reduced-motion changes; the editor
stops automatic playback when that preference becomes active. The editor owns the
playhead clock, server validation, and restoring the application's composition.
See the [timeline editor guide](editor.md) for controls and lifecycle behavior.

On completion, write the destination values to inline style and cancel filled
effects. Catch cancellation rejections and guard completion callbacks with the
animation generation so stale effects cannot overwrite newer states. On disposal,
cancel effects and restore original inline values only where Liva still owns them.
Require exclusive ownership of animated properties: competing Vue style bindings,
CSS transitions, and external animations on those properties are unsupported.

Invalid parameter updates retain the prior values and composition and emit a diagnostic.
Missing/duplicate targets suspend the affected instance with diagnostics; target
removal cancels its effects. Rebinding settles the current composition without replaying old animations. If
subscription cleanup changes logical inputs, guards reevaluate once; an unchanged
input snapshot does not advance state-machine history. The reduced-motion policy settles immediately
when `prefers-reduced-motion: reduce` is active; controls and application state
continue working. Initial mount never animates from an unspecified state.

## Spring execution

[The scalar solver](../packages/runtime/src/spring.ts) computes progress for
`mass * x'' + damping * x' + stiffness * (x - 1) = 0`, with zero initial velocity.
Analytic solutions cover underdamped, critical and overdamped responses. Sampled
CSS `linear()` effect easing lets WAAPI interpolate raw CSS endpoints, including
overshoot. Tween tracks instead use linear effect easing and per-frame easing.

Duration mode maps bounce to damping ratio `1 - 0.9 * bounce` and scales the
unit-frequency settling time to the requested duration. Physics mode requires
absolute displacement below 0.00025 and velocity below 0.001 per second for 64 ms.
Its search step is at most 1/240 s and 0.1/natural-frequency, with limits of 10 s
and 200,000 solver steps. Easing sampling uses 0.0005 midpoint error and at most
8,192 samples; final progress is exactly one. Exceeding a limit reports an error.

CSS interpolation remains browser-owned. Unsupported CSS can produce no visible
animation; Liva does not probe support or provide an interpolation fallback.
See [CSS Easing Level 2](https://www.w3.org/TR/css-easing-2/) and
[Web Animations easing](https://www.w3.org/TR/web-animations-1/).

## Vue and Vite integration

The Vite plugin compiles inline `<liva>` blocks through Node WASM. Following the
[Vue plugin custom-block contract](https://github.com/vitejs/vite-plugin-vue/tree/main/packages/plugin-vue#example-for-transforming-custom-blocks),
the generated module augments the component with immutable definitions.
Directives read them through `binding.instance.$options`. External `src` blocks
are unsupported.

Application code imports the default plugin from `@liva/vue`. This is a typed,
runtime-only package export. The Vite development server intercepts that entry
and supplies editor integration; builds use `@liva/vue/runtime`. The public entry
is excluded from dependency prebundling to preserve development interception.
Explicit plugin construction uses `createLivaPlugin` from `@liva/vue/runtime`.

Targets reconcile in a queued pass against the nearest Motion root and their
declaring component. Every root is automatically bound as `self`, independently of
any named alias on the same element; ownership never crosses nested Motion roots. Ordinary targets bind one element, while lifecycle targets can bind
multiple keyed elements. Each Motion instance owns its parameters and subscriptions.
Invalid HMR retains the last valid definition; successful HMR can reload Vue state.

Development behavior is enabled through `configureServer`, not a mode name.
Production builds include only definitions, the adapter and runtime, even when
built with mode `development`. Static preview servers expose no source writer.

## Compiler-owned Vue presence

`packages/vite/src/presence.ts` traverses the SFC template AST and returns a
boundary plan with structural operation, source range, Motion/target references,
required phases, and integration strategy. It groups conditional chains, deduplicates
shared operations, plans every nested operation, and diagnoses conflicting user
Transitions. The transform preserves source maps and inserts a boundary component
and the internal `v-liva-entry` directive on structural elements. Owner metadata is
carried by `v-liva`, and target registration metadata by `v-liva-target`.
Compiler-generated bindings use the reserved `compiled` modifier and a wrapper
containing the original `value` and internal metadata. The adapter unwraps current
and previous values before handling parameter updates; ordinary parameter
objects are never interpreted as metadata based on their property names.

Each owner identity consists of its static SFC root ID and enclosing keyed-loop
values, scoped to the Vue component instance. Each boundary has keyed entry
objects; generated target bindings explicitly register with those entries.
The adapter never discovers structural ownership by traversing the DOM.
Ordinary target registration retains nearest-root behavior for existing directives.

`packages/vue/src/presence.ts` uses public JavaScript hooks on Vue Transition and
TransitionGroup; persisted Transition handles v-show. Before target or Motion
disposal, the adapter captures resolved work into all applicable boundary entries.
Snapshots unused by that render patch are released in a microtask. Vue component
unmount hooks and reactive-effect disposal retain their normal ordering; retained
DOM does not keep the original Motion alive.

`packages/runtime/src/lifecycle.ts` resolves lifecycle tracks from resolved layer
values and a presentation snapshot. A session owns only resolved tracks, element
references, temporary inline presentations, and WAAPI handles. Completion joins
all tracks. Supersession, owner teardown, cancellation/failure, and normal
completion have distinct results with idempotent cleanup. Only a current session
may release Vue's removal/hide callback. Enter sessions are registered with live
Motion instances so explicitly animated properties are protected during layer updates. Enter completion restores the latest cascade, including properties removed during entry; leave sessions remain independent of the disposed instance.

The core runtime contains no Vue structural semantics. It shares transition IR,
spring sampling, CSS-property conversion, and browser interpolation with normal
state transitions. Conditional events are evaluated after let updates and before
visual selection, and the adapter translates event names into DOM CustomEvents.

### Lifecycle normalization and layer capture

Lifecycle CSS shorthand lowers to Frame IR at offset 0 for enter and offset 1 for
leave. Frames retain scalar templates and typed timing/easing expressions. The
compiler accepts lifecycle declarations only at motion scope. Each motion has
at most one enter transition and one leave transition.

Boundary planning uses the motion-level lifecycle target set. At capture, the
runtime renders the selected lifecycle and uses the instance's resolved layer
presentation, including all active local states, for missing enter endpoints.
Leave samples current displayed values before ordinary effects are released.
Only explicit lifecycle properties release ordinary effects; unrelated animation
continues. Sessions protect these properties from layer writes until completion.
Enter completion restores original ownership and applies the latest cascade;
leave completion releases Vue's pending removal/hide callback. No new Vue boundary
or directive is needed, and component/application data remains Vue-owned.

### Product examples and editor safety

Toggle and async-submit demonstrate local machines and directional tracks;
interactive-button demonstrates overlapping reactive layers; drag/swipe combine
reactive input with motion-level presence. Every executable motion uses layers and
typed animation expressions. States and guarded transitions are scoped to their
declaring layer.

The editor uses composition selectors, shared timeline/playback controls, and typed
source operations. The lossless parser and language-server expression hovers cover
layer guards and decorators. There is no standalone Liva formatter; tools preserve
custom block text and decorator nodes.

## Composition inspection and manual resolution

`LivaInstance.composition` returns an isolated snapshot of ordinary layer activation
(`layers`, including disabled layers) and current stateful layer states (`states`).
It reads retained state-machine history without reevaluating guards. Every definition
has layers, so the getter always returns a composition.

`resolveComposition(definition, values, composition, from?, transitions?)` resolves
an explicit complete selection using the normal property and independent timing
cascades. Ordinary layers, including unconditional ones, can be disabled for
preview. Stateful layers always select one declared state. Guards are not evaluated;
CSS and timing expressions still use the supplied values. Invalid or incomplete
compositions throw without modifying application state.

Transitions are opt-in `{ layer, index }` identities, with a zero-based index into
that layer's transition declarations in the current definition. Both endpoint
compositions must match the declaration. No transition is inferred from a state
pair, and identities must be refreshed after a definition replacement. Multiple
transitions with the same endpoints remain distinct. Only the final value owner's
transition contributes animation instructions, including intermediate motion when
the endpoints are equal.

`LivaInstance.previewComposition(from, to, transitions?, definition?)` prepares
paused effects for explicit compositions using the instance's current input and let
values. An optional candidate definition affects only that preview; the application
definition and state-machine history remain intact. The `animations` interface
supports forward and backward `currentTime` seeks, including under reduced motion.
Equal compositions can still contain intermediate style or transition motion.

`endCompositionPreview()` releases the effects and restores the application's
composition and external CSS. Parameter or reactive-input updates, definition
replacement, target changes, and disposal supersede the session. Preparation errors
restore application presentation, report a diagnostic, and throw with the original
cause. The editor rejects stale or out-of-order replies and ends previews on close,
discard, or selection changes. Source conflict checks still apply to previews with
no edits; source mutation remains subject to the editor's supported-edit checks.

### Shared timing in explicit root blocks

The compiler merges shorthand root declarations and an explicit self block into one
`self` target. Optional `timingProperties` on Target IR limits that block's shared
timing to the properties declared inside it. Omitted metadata preserves ordinary
target-wide timing. Runtime cascade and transition rendering consult this property
set, so target timing cannot leak into root shorthand outside the block. Source
mappings retain each property's original location and the explicit block's shared
decorator; editor provenance uses the same timing selection.

## Shared layout measurement

`layout-scheduler.ts` owns per-document invalidation and batching, independently of
`measure()` language registration and `layout-bounds.ts` coordinate decoding.
Read callbacks return publication closures: a pass completes all reads before any
closure publishes. Reactive notifications run after all snapshots are installed.
Initial registration reads synchronously; subsequent invalidations coalesce into
one animation-frame pass, and writes never cause a recursive same-frame read.

The geometry reader reconstructs transformed border origins from affine box corners,
then removes local transform-origin shifts while accumulating ancestor-relative
layout deltas and scroll offsets. It retains fractional CSSOM sizes and excludes the
reference border. Unsupported geometry uses the explicit unattached snapshot;
unexpected implementation exceptions propagate with their original causes.

Liva layer/lifecycle effects register their layout-affecting animations with the
scheduler. Normal invalidation remains detection-based; external animation tracking
and automatic layout animation are separate features.

## Stable reactive calls

A stateful built-in may return a `ReactiveCall` from `reactive-value.ts`. It exposes
an immutable readable `value`, a subscription binding, `prepareUpdate(args)`, and
`dispose()`. Each evaluated call site retains its instance across argument updates;
aliases share its snapshot, while distinct calls own independent instances.
Ordinary functions keep argument-based result caching.

`LetBindingGraph` owns dependency ordering, expression evaluation, and validation.
`ReactiveCallStore` owns call-site caches, candidate snapshots, subscriptions,
update commit/discard, disposal, and notification deferral. Each store evaluation
runs a synchronous callback that reads calls by binding name and call-site index.
The graph validates the complete candidate environment inside that callback; only
its successful return allows the store to activate subscriptions and commit updates.
Compatible initializer detection stays in the graph, which supplies the binding
names whose cached calls a replacement store may borrow.

Preparation must be pure: it returns a candidate snapshot plus `commit()` and
`discard()` without mutating committed state, allocating active browser resources,
or publishing. The graph evaluates all initializers and validates the resulting
presentation before committing updates. A failed evaluation discards updates and
disposes newly created calls. Commit must be infallible. Each implementation owns
idempotent resource cleanup and immutable snapshots. A transaction reads each call
once; commit-time notifications are deferred to a microtask after all calls commit.

Subscriptions activate only when DOM targets bind. Source replacement transfers
calls only for the same binding name, structurally identical initializer, and
unchanged arguments. Changed or removed calls dispose; editor inspection uses an
inactive graph and cannot update retained live calls. Binding cleanup cancels
active resources; final graph disposal also releases the call instance.
