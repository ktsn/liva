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
exposes `Motion` views; motions expose parameters, let bindings, states, events,
and animation blocks. `enters()` and `leaves()` select lifecycle declarations;
`transitions()` traverses all animation blocks, including enter and leave.
`lifecycle_state()` exposes an optional state selector; target
`animation_properties()` visits shorthand declarations and explicit tracks in source order.
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
let initializers, state conditions, and interpolations. Both parsers write directly to
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
has its own module; `drag.rs` declares its target argument and return fields.
The compiler builds one typed variable scope from parameters, inferred let expression types,
and the targets declared across states. The generic call checker evaluates argument
types through the expression checker and compares them with the signature.
Let type inference follows dependencies and rejects cycles. Expression member checking
follows the variable's inferred type. The syntax parser
uses ordinary call/argument nodes without knowing any built-in function names.

`packages/runtime/src/builtins/` registers the implementations. `drag.ts` defines
`drag`, its per-instance value, and Pointer Events handling. A built-in subscription
returns a value and a binding function whose cleanup releases browser resources.
`LivaInstance` creates, binds, and cleans up these handles without built-in-specific
branches. The let binding graph reevaluates expressions in dependency order before
state selection and template rendering. `FunctionResult` is either `RuntimeValue` or `ReactiveSubscription`, defined in
`reactive-value.ts`. The runtime recognizes subscriptions by their `value` and
callable `bind` members. Ordinary records remain ordinary values. Each call site
caches its evaluated arguments and result; unchanged arguments reuse that result.
Subscription results expose their latest value, while changed arguments invoke the
function again. Nested calls use the same evaluation rules. Active subscriptions
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
  enter?: Transition
  leave?: Transition
  stateEnters?: { state: string, transition: Transition }[]
  stateLeaves?: { state: string, transition: Transition }[]
  states: State[]
  generalTransition?: Transition
  directionalTransitions: { from: string, to: string, transition: Transition }[]
}
State {
  name: string
  when?: Expression
  targets: { name: string, properties: { name: string, value: string, template?: (string | Expression)[] }[] }[]
}
Transition {
  timing?: Timing
  targets: { name: string, properties: PropertyTransition[] }[]
}
PropertyTransition {
  name: string
  timing?: Timing
  keyframes?: { offset: number, value: string, easing?: string, template?: (string | Expression)[] }[]
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
requires exactly one fallback, while low-level editor playback can choose states.

Offsets normalize to `[0, 1]`; times normalize to milliseconds. CSS values and
easing remain strings. Preserve definition/state/target/property source order for
inspection and sort frame offsets semantically. `keyframes` absent means inherit;
an empty array has no source-level override meaning and is not emitted. Timing
arguments have already been validated and defaults applied within each atomic
value. Ordinary transition inheritance and missing endpoints are resolved at runtime;
motion-level lifecycle tracks are compiled as described below.

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
2. Merge property settings and resolve timing using the language precedence rules. Schedule
   state differences and explicitly keyed tracks, including equal-value pulses.
3. Complete missing endpoints from source/destination state values. During an
   interruption, replace the first frame with the displayed value even if an
   explicit `0%` was authored. Preserve remaining frames and restart their full
   timeline; do not attempt to preserve partial progress or spring velocity.
4. Validate Liva track structure and timing constraints, normalize interval easing, and pass resolved
   tracks to the executor together with destination values for settlement.

## Runtime lifecycle and interruption

An instance owns parameter values, let values and built-in subscriptions, target bindings, selected state, animation generation,
active effects, and original inline property values/priorities. Instance lifecycle:
`create -> bind -> apply initial state -> transition* -> dispose`.

`updateParameters` accepts a complete named parameter snapshot and reevaluates
selection and templates.
Definition replacement retains values for parameters with matching names and types
and removes obsolete values. A new required parameter or incompatible type rejects
the replacement before changing the instance or its effects; no defaults are supplied.
Matching drag bindings retain offsets while releasing active gestures.

For each selected-state change, batch-read displayed values for the union of old active and new
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

Catch actual WAAPI construction/playback exceptions
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
declaring component. A root may also be a target; ownership never crosses nested
Motion roots. Ordinary targets bind one element, while lifecycle targets can bind
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
and previous values before handling state or parameter updates; ordinary parameter
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

`packages/runtime/src/lifecycle.ts` resolves lifecycle tracks from active-state
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
compiler rejects state-specific and layer-local lifecycle declarations. Runtime
validation still reads historical `stateEnters`/`stateLeaves` compiled bundles;
new source cannot produce these fields.

Boundary planning uses the motion-level lifecycle target set. At capture, the
runtime renders the selected lifecycle and uses the instance's resolved layer
presentation, including all active local states, for missing enter endpoints.
Leave samples current displayed values before ordinary effects are released.
Only explicit lifecycle properties release ordinary effects; unrelated animation
continues. Sessions protect these properties from layer writes until completion.
Enter completion restores original ownership and applies the latest cascade;
leave completion releases Vue's pending removal/hide callback. No new Vue boundary
or directive is needed, and component/application data remains Vue-owned.

### Product migration and editor safety

Toggle and async-submit demonstrate local machines and directional tracks;
interactive-button demonstrates overlapping reactive layers; drag/swipe combine
reactive input with motion-level presence. Legacy states remain supported for
existing motions, but cannot be mixed with layers in one motion.

The timeline's legacy state-pair model cannot represent layer ownership or preserve
typed decorators through track replacement. Such definitions are inspectable but
read-only: the client hides editing/preview controls and the server rejects preview
and commit requests before applying edits. Edit source and exercise application
controls to preview these motions. The lossless parser and language-server
expression hovers cover layer guards and decorators. There is no standalone Liva
formatter; tools must preserve the custom block text and decorator nodes.
