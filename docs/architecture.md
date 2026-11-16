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

The runtime keeps its public entry point at `packages/runtime/src/index.ts` and
groups implementation files and their tests by responsibility:

| Runtime directory | Responsibility                                                                                  |
| ----------------- | ----------------------------------------------------------------------------------------------- |
| `model/`          | Definition IR, validation, evaluated presentation types, and target contracts                   |
| `evaluation/`     | Expressions, timing values, let dependencies, reactive calls, and notifications                 |
| `composition/`    | Layer selection, state transitions, cascade precedence, and resolved tracks                     |
| `motion/`         | Numeric property rules/codecs, controllers, motion histories, springs, and WAAPI property names |
| `layout/`         | Layout bounds and shared per-document measurement scheduling                                    |
| `execution/`      | Instance ownership, DOM binding, playback, previews, and lifecycle sessions                     |
| `builtins/`       | Language-callable functions and their registration                                              |

Tests spanning evaluation, composition, and spring resolution remain in `src/__test__/`.
These directories group responsibilities; they do not impose a one-way dependency
hierarchy. For example, expression rendering uses cascade timing helpers, while
composition resolution evaluates expressions.

The public `execution/instance.ts` facade routes logical requests to `Runtime` and
DOM-bearing requests directly to `PresentationExecutor`. Runtime owns accepted
parameters and let environments, reactive-call lifetime, ordinary layer/state
history, conditional events, binding revisions, and the update queue. It does not
receive elements or native effects. `execution-contracts.ts` defines the logical
execution requests and evaluation callbacks shared by these modules; the executor
does not import Runtime.

`presentation-planner.ts` calculates declaration order, target-wide controller
ownership, changed/removed properties, observation needs, final tracks, ordered
writes, and affected effect identities from supplied values and snapshots. It
reuses `composition/layers.ts` for timing and frame resolution. Ordinary layer
selection and presence adapters produce evaluated layers with identifier-based
receiver scopes. Their common cascade keeps value and timing precedence independent
and retains authored declaration identity after canonical expansion. Public
composition contains only ordinary selections; Definition IR is never modified.
Plans contain receiver and effect identifiers, never elements or native effects.

Runtime coordinates evaluation and controller ownership through `ExecutionPort`.
Its presentation request enters one synchronous observation/planning/commit path in
the executor, also usable after Runtime disposal. The executor supplies observations
to the existing pure planner stages; ownership, track selection, frame construction,
and cancellation decisions remain in those stages:

1. Validate ordinary selection, applicable presence expressions, and events before
   accepting reactive calls. Publish values and deliver events while public
   composition is still old. After revision checks, request terminal controller
   writes and motion-history recording.
2. Request receiver-specific canonical addresses. Calculate target-wide controller
   ownership, ask the executor to acquire selected controllers and release old
   owners, then resolve supplied controller CSS values or normal fallbacks.
3. Select changed declarations and omitted starting endpoints. Request displayed
   starts and addresses only for affected targets. Browser CSS shorthand splitting
   remains an observation operation; the planner decides canonical ownership and
   receiver-specific interruption from the resulting facts.
4. Request only needed displayed/motion/reference observations after controller
   release has transferred velocity. Calculate final frames, timing, cancellation,
   restoration, and ordered writes, then hand the complete plan to the executor.

Notification-time expression snapshots and later displayed snapshots have separate
lifetimes. They cannot be reused across terminal writes or controller acquisition
and release. Observations and plans are consumed synchronously against the current
binding; rebinding/disposal invalidates queued input work and releases receiver
references. Unchanged untimed updates require no CSSOM reads. Numeric facts use
canonical component units and units per millisecond; the existing property codec
and spring solver supply serialization and trajectories. `PropertyMotion.prepareSpring`
remains a browser-observing compatibility adapter over the shared pure calculation.

The executor owns DOM bindings and subscription connections, controller operations,
style restoration, motion history, native effects, and reference observation.
It prepares all replacement effects before accepting a live plan. Preparation
failure cancels newly prepared effects and preserves old effects and composition.
On acceptance it publishes the resolution to Runtime, cancels affected old effects,
and applies planned writes/playback; unrelated effects remain active. Earlier
accepted reactive calls, events, and terminal writes are not rolled back. Style
restoration still protects external edits inside the executor.

Reference changes reuse that presentation path without advancing guards or events.
Ordinary completion reconciles the current receiving element. Grouped effects
remain executor-owned until their operation settles, while the DOM-free
`CompletionGroup` tracks only current effect IDs and results. Replacement publishes
membership together before cancelling old native effects; stale completion cannot
finish a replacement. Empty-work completion is deferred until participant startup
has joined the group. Cancellation, teardown, failure, and completion remain distinct
and idempotent. Reduced motion settles all live effects; manually seekable previews
remain frozen.

The executor keeps one operation registry for initialized presence layers and public
compatibility registrations. It retains physical receivers through rebinding while
an operation still uses them. Target aliases share receiver identities, and
controller effectiveness is decided across every receiver of a logical target.
Controller formatting retains the ordered logical declaration presentation by
reference. Candidate validation and accepted application compare this same baseline,
so an unchanged binding, an unreadable fallback, or an alias cannot falsely suppress
an active enter expression. Canonical takeovers compare the winning declaration
for each physical component. Lower obscured changes preserve higher effects; removing
a winner reveals its predecessor. Source-ordered writes can reapply an unchanged
higher declaration without cancelling that declaration's effect. Validation performs
no live controller operations.
Presence start/end refreshes ownership without waiting for another input:
released controllers transfer fresh input velocity, and reacquired controllers
capture the displayed origin before outgoing effects are cancelled. Evaluation
snapshots are refreshed after ownership changes.

Runtime also coordinates isolated inspection and preview planning. Preview effects
use the same final planner and native materialization, begin paused at zero, and
never join live completion groups. Exported preview Animation handles exclude
continuing leave effects, so editor seeking cannot scrub live presence. Live group
completion during preview releases its effects without changing frozen preview
styles. Ending or failing a preview restores application presentation.

`LifecycleSession` is a compatibility barrier over executor participants, allowing
one Vue boundary to aggregate repeated targets and multiple Motion instances.
Captured work retains source identity and an executor-owned input environment;
replacement/disposal preserves that definition's final accepted values before
subscriptions disconnect. Disposal severs Runtime callbacks and keeps only the
browser resources needed by detached leave. The same composition, observation,
planning, replacement, and reference tracking serve attached and detached playback.

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
follows the variable's inferred type. The syntax parser uses ordinary call/argument
nodes without knowing any built-in function names.

During definition lowering, a motion-local controller registry records inferred
controller declarations and aliases alongside let IR. Style bindings resolve these
origins through cached aliases and assign one target/property address directly to
the originating call. Inline controllers acquire independent scope-based identities
at the declaration site. At motion completion, only unmatched controller definitions
need diagnostics; controller validation and attachment lowering do not rescan the
complete syntax tree or IR. Property-specific value-shape compatibility is not
checked by the compiler.

`packages/runtime/src/builtins/` registers the implementations. `drag.ts` defines
`drag`, its per-instance value, and Pointer Events handling. `interaction.ts` reads browser
pseudo-class snapshots and coalesces event-triggered rechecks. A built-in subscription
returns a value and a binding function whose cleanup releases browser resources.
Runtime connects the call store through the executor without built-in-specific
branches. The executor binds adapters to receiving elements and owns their browser
cleanup. The let graph evaluates expressions in dependency order before layer
resolution and template rendering. Builtins return `BuiltinResult`: a `RuntimeValue`,
`ReactiveSubscription`, or stateful `ReactiveCall`. The store retains the same
adapter objects through the DOM-free `FunctionResult` source/call views defined in
`reactive-value.ts`. Source recognition uses the adapters' `value` and callable
`bind` members. Ordinary records remain ordinary values. Each call site
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
  schemaVersion: 2
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
MotionParameter {
  name: string
  type: "number" | "boolean" | "string"
    | { kind: "stringUnion", values: string[] }
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
  value: PropertyValue
  timingExpression?: Expression
}
PropertyValue =
  { kind: "literal", value: string }
  | { kind: "template", parts: (string | Expression)[] }
  | { kind: "binding", expression: Expression }
  | { kind: "keyframes", frames: Frame[] }
CssValue =
  { kind: "literal", value: string }
  | { kind: "template", parts: (string | Expression)[] }
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
  value: CssValue
  easing?: string
  easingExpression?: Expression
}
Timing =
  { kind: "tween", durationMs: number, easing: string }
  | { kind: "spring-duration", durationMs: number, bounce: number }
  | { kind: "spring-physics", stiffness: number, damping: number, mass: number }
```

`MotionParameter` contains a name and either a lowercase primitive type name or a
`stringUnion` descriptor. Its candidate array contains one or more exact decoded
strings; a singleton annotation has one candidate, which may be the empty string.
The compiler emits sorted unique candidates, while runtime validation also accepts
duplicate or reordered members with the same membership semantics. Host parameter
values remain ordinary scalars validated against this metadata before an instance
or updated snapshot is accepted. `LetBinding` represents a `let` binding and contains
a name and an `Expression` initializer. Call expressions contain a function name and named argument expressions. Target variables use ordinary
`{ kind: "reference", path: ["body"] }` expressions. `Expression` is a
tagged scalar/reference/call/unary/binary tree, validated in Rust and evaluated without
JavaScript code generation. A property's `value.kind` selects exactly one declaration
source. Templates retain only their text/expression segments; development source mappings
provide the original authored text for inspection and editing. Keyframe sources contain
an ordered array of frames, including a required 100% destination; the runtime derives
the final CSS value from that frame instead of storing it twice. Frame values can be
literals or templates, but cannot contain bindings or nested keyframes. Evaluated
presentation values use separate runtime types containing CSS strings. The IR uses
schema version 2 and rejects older serialized bundles. The compiler requires at least
one layer and one initial state per stateful layer. Manual editor playback selects
compositions without evaluating guards.

Offsets normalize to `[0, 1]`; times normalize to milliseconds. CSS values and
easing remain strings. Preserve definition/state/target/property source order for
inspection and sort frame offsets semantically. Within `PropertyTransition`,
`keyframes` absent means inherit; an empty array has no source-level override meaning
and is not emitted. Timing arguments have already been validated and defaults applied within each atomic
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
   remaining authored intermediate frames and restart their full timeline. Supported
   endpoint-only springs instead inherit displayed per-component velocity through
   the property-motion sampler.
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

[The ordinary scalar progress solver](../packages/runtime/src/motion/spring.ts) computes progress for
`mass * x'' + damping * x' + stiffness * (x - 1) = 0`, with zero initial velocity.
Analytic solutions cover underdamped, critical and overdamped responses.
Endpoint-only property handoffs use the same analytic solutions with the incoming
component velocity, as described under Property motion and event transactions.
Sampled CSS `linear()` effect easing lets WAAPI interpolate raw CSS endpoints, including
overshoot. Tween tracks instead use linear effect easing and per-frame easing.

`springState` is the shared scalar analytic solver for arbitrary start/end values
and incoming velocity in units per second; `springResponse` uses its rest unit-step
case. Property handoffs convert their component velocities from units per millisecond
at this boundary. Their settling and sampling policies remain separate from ordinary
progress easing.

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

`packages/runtime/src/execution/lifecycle.ts` resolves lifecycle declarations and
preserves `LifecycleWork[]`, `LifecycleSession`, and public resolution helpers.
Sessions retain compatibility work and completion results; the executor owns every
native effect, inline style, motion sample, and observer. A boundary joins all
participants' current effect IDs, including replacements. Only its current session
may release Vue's removal/hide callback.

### Lifecycle normalization and layer capture

Lifecycle CSS shorthand lowers to Frame IR at offset 0 for enter and offset 1 for
leave. The compiler accepts one lifecycle declaration per phase at motion scope;
source syntax and Definition schema are unchanged. Presence adapters evaluate only
applicable declarations, complete omitted endpoints with ordinary/displayed values,
and produce scoped evaluated layers. Authored frame endpoints remain distinct from
ordinary completion values. Existing property codecs expand supported logical and
shorthand declarations without losing relative units or declaration identity.

Enter initializes its current declared starting values before paint, preserving
explicit displayed-start rebases from Vue reversal. Its initial timing follows
property, target, then lifecycle-wide precedence, independently of ordinary timing.
A new ordinary transition takes over affected canonical components, uses displayed
starts and its own timing, and leaves unrelated components running. Leave supplies
an exit layer only for its declarations; unrelated ordinary updates continue.
Applicable expressions remain live while connected, and the final accepted input
environment survives disposal/replacement without subscriptions. DOM-relative
reference observation can continue during detached leave.

Source-controller input derivatives keep their original per-component timestamps
through release. Displayed animation velocity is sampled separately from registered
native/analytic trajectories. Endpoint-only supported springs share ordinary
handoff and fallback rules across ordinary playback, leave, and re-entry. No
controller observation polling is added. Completion/failure releases styles while
preserving external edits; reacquiring a retired declaration captures its current
baseline even if another operation still owns a different field on the element.
The runtime contains no Vue structural semantics; component/application data and
boundary removal/hiding remain Vue-owned.

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

## Numeric property rules

`property-rules.ts` declares numeric kinds, canonical components, authored shorthand
longhands, units, serialization bounds, and writing-mode mappings without reading the
DOM. `property-codec.ts` uses these rules to decode CSSOM values and expand tracks;
`property-motion.ts` owns their histories and velocity-aware spring sampling. Property
ownership and track expansion therefore share the same component identities.

## Stable reactive calls

A stateful built-in may return a `ReactiveCall` from `reactive-value.ts`. It exposes
an immutable readable `value`, a subscription binding, `prepareUpdate(args)`, and
`dispose()`. Each evaluated call site retains its instance across argument updates;
aliases share its snapshot, while distinct calls own independent instances.
Ordinary functions keep argument-based result caching.

`Runtime` independently owns `LetBindingGraph` and `ReactiveCallStore`. Graph
construction analyzes dependencies, stable call-site identities, and receiving
addresses without evaluating calls. Each graph evaluation receives invocation
operations and an optional synchronous `afterEvaluate` validation/transformation.
Runtime runs both inside `ReactiveCallStore.evaluate`, before subscription
acceptance and prepared-call commit. Compatible graph metadata selects caches
borrowed by a replacement or isolated candidate. Acceptance disposes the retiring
live store while preserving calls held by the replacement. Rejection or inspection
completion disposes the candidate store while preserving calls held by the live store.

`ReactiveCallStore` owns caches, coherent source snapshots, prepared updates,
transactional acceptance/discard, and notification ordering. It connects evaluation
sources through a DOM-free `SourceConnection` supplied by the executor. The executor
invokes the existing adapter's `bind(elementMap, publish)` and owns native cleanup;
no target map is passed through Runtime, graph, or store. Source identity is retained
across interface views for snapshot maps and controller capability lookup.

Preparation must be pure: it returns a candidate snapshot plus `commit()` and
`discard()` without mutating committed state, allocating active browser resources,
or publishing. The graph evaluates all initializers and validates the resulting
presentation before committing updates. A failed evaluation discards updates and
disposes newly created calls. Commit must be infallible. Each implementation owns
idempotent resource cleanup and immutable snapshots. A transaction reads each call
once; commit-time notifications are deferred to a microtask after all calls commit.

Subscriptions activate only when DOM targets bind. Source replacement transfers
calls only for the same binding name, structurally identical initializer, matching
receiving addresses (including inactive states and aliases), and unchanged arguments.
Changed or removed calls dispose; editor inspection uses an unbound candidate store
and cannot update retained live calls. Executor-owned binding cleanup cancels browser
resources; final store disposal also releases owned call instances.

### Property motion and event transactions

Controller capability tokens live in a WeakMap keyed by immutable readable snapshots;
the expression evaluator uses the same transactional reactive-call protocol as other
builtins. HMR derives receiving addresses from property bindings and resolves whole-value aliases
to their originating calls. A call is reusable only when both its initializer and
receiving addresses match, so moving it to another address replaces it.
Compiler-only address validation stays in `ControllerBindings`; call expressions
carry no attachment metadata. Sessions and committed input histories
are instance-local. Controllers schedule no observation frames or notifications. They
sample displayed positions on demand and derive velocity only from input updates.
Acquisition resets input history; release seeds property motion with the fresh input
derivative before the next spring is prepared. Registered animation trajectories still
supply spring-to-spring velocity at interruption time, without polling. Property codecs
read/serialize canonical values separately from input mapping and effective ownership. Per-element physical/component histories
survive ordinary and lifecycle retargeting. Released input derivatives expire from
the original input sample time, rather than gaining a new freshness window at release.

Reactive notifications can carry an occurrence and timestamped source snapshot map.
The binding graph stages dependent expressions against that map. An instance first
applies terminal input to old owners, freezes observations, resolves all guards, then
commits composition and property effects. Publications during evaluation are queued;
event occurrences have FIFO identity and are never collapsed into ordinary updates.
Target/source replacement clears obsolete queued work. Inspection uses snapshot-only
evaluation and preview freezes on-demand controller snapshots; it cannot advance
input events.
