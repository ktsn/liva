# Language specification

A motion declares layers, lifecycle animations, let bindings, and host parameters. Rust
compiles lossless CST into serializable Definition IR; the browser interpolates
CSS through WAAPI.

## Motion declarations and types

Every top-level definition starts with `motion`:

```css
motion card {
  let movement = drag(target: body)

  layer interaction {
    body { translate: 0 0; scale @tween(duration: 200, easing: easeOut) { 100%: 1 } }

    state idle initial {}
    state dragging {
      body { translate: ${movement.offset.x}px ${movement.offset.y}px; scale: 1.05 }
    }

    transition idle -> dragging when movement.active
    transition dragging -> idle when !movement.active {
      body {
        translate @spring(stiffness: 300, damping: 20) {}
        scale @tween(duration: 180, easing: easeOut) {}
      }
    }
  }
}

motion progressIndicator(
  progress: number,
  enabled: boolean,
  label: string
) {
  layer base {
    body { opacity: ${progress}; --label: ${label} }
  }
}
```

The parameter list is optional; `motion card()` is also valid. Parameters require
`name: type` annotations, separated by commas; a trailing comma is allowed.
The primitive types are exactly `number`, `boolean`, and `string`. Type references
are declaration-time metadata, separate from runtime expression nodes. Annotations
are never function arguments or runtime values. User-defined functions and advanced parameter types are outside scope.

Parameters, let bindings, and targets share one variable namespace throughout their
motion, regardless of declaration order. Each target declared in a layer or local state
introduces a target-valued variable; the same target across layers is one
variable. Duplicate declarations and collisions between variable kinds are errors.
Names are local to each motion. Unknown types, invalid
parameter declarations, unresolved references, and primitive member access are errors.

## Parameters, let bindings, and selection

Motion parameters receive host application values. The object in
`v-liva:toggle="{ checked }"` supplies the named parameter of
`motion toggle(checked: boolean)`. Each instance retains its own values, separate
from the immutable Definition IR. Updates reevaluate conditions and CSS templates.
Every declared parameter is required; the object is a full parameter snapshot.
Missing parameters are errors, including on updates; no implicit defaults are used.
Explicit `0`, `false`, and `""` are valid values. Unknown names, wrong types, and
non-finite numbers are rejected without coercion. Invalid updates report a runtime diagnostic and retain the last
valid values; invalid initial inputs reject instance creation.

A `let` declaration binds the value of an expression:

```css
let movement = drag(target: body)
let doubled = progress * 2
let horizontal = movement.offset.x + doubled
```

The compiler infers each `let` binding's type from its initializer. Bindings can refer to
parameters, targets, and other let bindings, including bindings declared later in the
motion. Cyclic let dependencies are compile errors. Initializers are evaluated
in dependency order. Parameter and built-in value changes reevaluate let
expressions before conditions and CSS templates. Evaluation errors retain the last
valid values and rendered state, and report a runtime diagnostic.

Calls use `functionName(argumentName: expression, ...)`, with named arguments and
an optional trailing comma. The parser represents calls independently of function
names. The compiler resolves names against its built-in function signatures and
checks required arguments, duplicate/unknown arguments, and argument types.

The built-in `drag` function accepts one required `target` argument of target type.
In `drag(target: body)`, `body` is an ordinary variable reference resolved in the
motion's scope. Its value refers to the `body` target declared in that motion's
layers. Argument expressions use the same name resolution and type checking as
other expressions. A string-valued variable does not satisfy a target parameter.
The return value has
`active: boolean`, `released: boolean`, and `offset: { x: number, y: number }`. These fields belong to
the built-in return type; object-valued motion parameters are outside scope.
Function implementations return either an ordinary value or a reactive subscription.
The runtime classifies each result by its value, not by the function's name.
Ordinary results are reused while argument values are unchanged and recomputed when
arguments change. A subscription exposes a current value and a binding operation;
its current value is read on updates without calling the function again. Changed
arguments invoke the function again and replace any active subscription. Each
instance creates target values and receives host parameters before evaluating
`let` initializers. These values belong to the instance, while the Definition IR
contains variable references.

Drag values expose `active`, `offset.x`, and `offset.y`. Offsets are pixel
displacements from the current pointer-down, reset on each new gesture and retained
on release until the next gesture. Only the primary left-button pointer is tracked.
Pointer-up sets `released` to true after publishing the final offset. The flag
remains true until the next pointer-down; cancellation and lost capture end the
gesture with `released: false` and never trigger release events. Target
replacement and disposal remove listeners and release capture. Set `touch-action:
none` on draggable targets; the adapter does not change application CSS.

Every motion requires at least one layer. Ordinary layers independently activate
from Boolean conditions. Stateful layers retain one local state and advance through
guarded transitions. Initial presentation settles without animation. Updates start
from displayed values, including interrupted springs, without carrying velocity.
A dynamic property without timing follows input immediately; unrelated running effects
continue. Timing and value ownership follow the layer cascade described below.

## Expressions and CSS templates

Expressions support finite decimal numbers, Booleans, quoted strings, parameter and let identifiers,
member access, parentheses, unary `!`, `+`, `-`, arithmetic `+ - * / %`, comparison
`< <= > >=`, equality `== != === !==`, and logical `&& ||`. Operators use normal
precedence; arithmetic requires numbers, logical operations require Booleans, and
comparison requires matching scalar types. Function calls are parsed as expressions;
subscription-producing built-ins are used in `let` initializers. There are no assignments,
computed member accesses, objects, arrays, or implicit unit conversions.

CSS values remain opaque text except for `${expression}` templates:

```css
translate: ${movement.offset.x}px ${movement.offset.y}px
```

Units are explicit text. The compiler validates expression references and member
paths. Non-finite runtime arithmetic reports a diagnostic and retains valid styles.
CSS validity is delegated to the browser. Omitted properties expose lower active
layers or external CSS. There is no requirement for a complete fallback state.

## Inline keyframes

```css
scale @tween(duration: 350, easing: easeInOut) {
  40%: 1.3 1 @easeIn
  70%: 0.95 1 @cubicBezier(x1: 0.2, y1: 0.8, x2: 0.2, y2: 1)
  100%: 1
}
```

Offsets are unique finite percentages in `[0, 100]`; IR sorts keyframes while
preserving layer and state declaration order. A top-level `@expression` supplies
typed interval easing; quoted or grouped `@` characters remain CSS text. Style tracks
require an explicit 100% destination. Transition endpoints may be omitted and use
the displayed start and resolved destination. Tween easing is the default per
interval; frame easing overrides it. WAAPI effect easing remains linear for tweens.
Spring tracks use the solver curve and do not expose per-frame easing controls.
CSS templates are supported in style, transition, and lifecycle frames. Completion
restores the resolved destination even when an explicit transition endpoint differs.

## Enter, leave, and events

A motion may declare one `enter` and one `leave` directly in its body. Targets
must be declared in its layers (including local states). The root
is animated only when explicitly bound as a named target. Lifecycle timing is
independent of ordinary layer timing. Lifecycle property timing overrides target
timing, which overrides the lifecycle shared decorator. All are captured at start.

```css
motion panel(open: boolean) {
  layer base { content { opacity: 1; scale: 0.9 } }
  layer opened when open { content { scale: 1 } }

  enter {
    content @tween(duration: 250, easing: easeOut) { opacity: 0; scale: 0.8 }
  }
  leave {
    content @tween(duration: 200, easing: easeIn) { opacity: 0; scale: 0.9 }
  }
}
```

Declare DOM lifecycle animations directly in the motion using `enter { ... }`
and `leave { ... }`. Use guarded `transition A -> B` inside a stateful layer for
state-change animation. Layers cannot declare their own enter/leave blocks.

A direct declaration in enter is the 0% frame; in leave it is the 100% frame.
Explicit keyframe blocks and `${expression}` values are also supported. Duplicate
properties are errors. Enter snapshots the fully cascaded destination and its
animation expressions at insertion/showing. Missing 100% endpoints use that
snapshot. Leave snapshots the currently displayed presentation and its expressions
before disposal/hiding; missing 0% endpoints use that display, including interrupted
animations.

Only properties explicitly animated by a lifecycle receive lifecycle precedence.
Other properties continue to follow layer changes. Enter never retargets while
running: completion applies the latest layer presentation, which can visibly jump
if inputs changed. Leave ignores later layer changes and signals Vue to finish
removal/hiding when its tracks complete. This snapshot limitation is intentional;
smooth lifecycle retargeting and layer-local lifecycle composition are unsupported.

State and expression changes do not retarget an existing lifecycle session.
Existing cancellation and replacement behavior still applies, for example when
showing an element again during leave. During leave, ordinary transitions do not
take over the properties owned by that session.

A conditional event is independent of state selection and animation completion:

```css
event dismiss when movement.released
  && movement.offset.x > 120
```

Conditions must be Boolean expressions. Each Motion instance remembers its own
condition values and emits once on each false-to-true edge. An initially true
condition does not emit. The Vue adapter dispatches a bubbling `CustomEvent`
named `liva-dismiss` from the Motion root; no payload expression is supported.
Use ordinary DOM listeners such as `@liva-dismiss="removeItem(item.id)"`.
Application state changes immediately; it never waits for the leave animation.

The [swipe playground](../playground/src/pages/swipe.vue) combines drag,
events, a return spring, and leave animation. Each draggable list item has its
own Motion instance. No velocity or inertia is calculated.

## Vue presence support

The SFC compiler plans lifecycle boundaries and generates internal Vue
`Transition` or `TransitionGroup` integration. Users only author `v-liva`,
`v-liva-target`, ordinary Vue structural directives, and Liva declarations.
Generated components add no DOM wrapper. Existing element keys, props, listeners,
and scoped CSS remain intact.

Supported operations on native elements are direct or ancestor `v-if`, complete
`v-if`/`v-else-if`/`v-else` chains, keyed `v-for`, and direct or ancestor
`v-show`. Nested operations each receive a boundary; targets sharing an operation
share a completion barrier. Motion-root removal and nested Motion instances work
within these native structures. Repeated lifecycle targets can share a Motion;
use an independent Motion root per item when the item has a drag subscription.

Persisted transitions leave `v-show` elements visible during leave and let Vue
apply `display: none` after completion. Showing uses Vue's display restoration.
A reversal cancels the obsolete session so its completion cannot hide new content.
Newly captured nested leaves participate in a parent's barrier. Already-running
child exits are cancelled when their owning boundary is destroyed.

Targets and Motion roots are SFC-local. Parent-controlled child component removal,
cross-component target resolution, dynamic Motion/target directive arguments,
structural `template` fragments, unkeyed repetition, and combined structural
directives on one element are unsupported.
Move structural directives onto separate nested native elements as diagnostics
recommend. A user-authored `Transition` or `TransitionGroup` owning the same
operation is a compile error, even without props. Remove that Vue transition and
define the animation in Liva. Unrelated transitions remain unchanged.

## Syntax and recovery

Declarations are separated by newline or optional semicolon. Balanced CSS groups
may span lines. Strings, escapes, `//` and `/* */` comments are preserved. Motion, layer, and
state names follow `[A-Za-z_][A-Za-z0-9_-]*`. Variable names (targets, let bindings,
and parameters), function names, and expression member names follow
`[A-Za-z_][A-Za-z0-9_-]*`. A hyphen without surrounding whitespace belongs to the
identifier: `max-min` is one name. Binary subtraction requires whitespace on both
sides, as in `max - min`; unary minus remains valid in `-1` and `-value`. CSS property names also allow custom properties.

Numbers with units, such as `20px` and `100ms`, are single lexical tokens.
They remain opaque CSS values; unit-bearing arithmetic in Liva expressions
is unsupported. URLs must be quoted, including arguments to `url()`, for example
`url("https://example.com/image.png")` or `url("image.png")`.

String spelling is preserved by the lexer. Expression strings decode `\n`, `\r`,
`\t`, `\\`, `\'`, and `\"`; unsupported escapes are diagnosed. CSS strings retain
all escapes verbatim for the browser. Interpolation parsing recovers at an unquoted
newline if `}` is missing, so subsequent declarations remain available to tooling.

The Rowan CST preserves every byte, trivia and UTF-8 ranges, including malformed
input. Diagnostics prevent execution of invalid definitions while development
retains the last valid definition. Production fails on any compilation error.

## Limitations and unresolved semantics

Standalone file imports, framework adapters other than Vue, SSR animation,
component-root directive forwarding, Teleport targets and Shadow DOM target
traversal are unsupported.

Velocity input, inertia, state-change persistence events, scroll/orientation sources,
user functions, custom CSS interpolation, and a standalone preview environment are
unsupported. The editor edits resolved layer values, typed timing, existing transition
frames, and motion-level lifecycles. Let bindings, guards, and new state-machine
structure are authored in source.

## Toggle example

```css
motion toggle(checked: boolean) {
  layer toggle @tween(duration: 350, easing: easeOut) {
    track { background-color: #888 @tween(duration: 200, easing: easeInOut) }
    thumb { translate: 0 0 @spring(stiffness: 300, damping: 20); scale: 1 }

    state off initial {}
    state on {
      track { background-color: #34b27b }
      thumb { translate: 24px 0 }
    }

    transition off -> on when checked {
      thumb { scale { 40%: 1.3 1 @easeIn; 70%: 0.95 1 @easeOut } }
    }
    transition on -> off when !(checked) {
      thumb {
        translate @spring(duration: 350, bounce: 0.2) {}
        scale { 40%: 1.3 1 @easeIn; 70%: 0.95 1 @easeOut }
      }
    }
  }
}
```

## Reactive layer declarations

An unconditional layer is always active; conditional layers are independently active
when their Boolean expressions are true. Declaration order is preserved in Definition
IR for property-level cascade resolution. Layers do not imply additive composition.

```css
motion button(hovered: boolean, pressed: boolean) {
  layer base { body { scale: 1 } }
  layer hover when hovered { body { scale: 1.05 } }
  layer press when pressed { body { scale: 0.95 } }
}
```

Layer names are unique within a motion. CSS values retain CSS syntax and units;
`${expression}` interpolates scalar values. The compiler preserves the layer declarations; the runtime resolves their active
values and timing on each input update.

### Stateful layers

Use reactive layers for independent Boolean visual conditions. Use a stateful layer
when an interaction must retain one of several exclusive states. Each stateful layer
owns its state names and requires exactly one `initial` state:

```css
layer submission {
  button {
    opacity: 1;
  }
  state idle initial {
    spinner {
      opacity: 0;
    }
  }
  state loading {
    button {
      opacity: 0.5;
    }
    spinner {
      opacity: 1;
    }
  }
}
```

Direct target declarations are common styles. The selected state's declarations
replace common values per CSS property. Other layers have independent current states.
Stateful layers are always active and cannot have a `when` condition; nested states
use guarded transitions instead of `state ... when` selection. The compiler keeps
common declarations and state declarations separate in IR, with an `initialState`
name. Runtime transition evaluation is handled independently of these declarations.

### Layer cascade and guarded updates

Active layers contribute CSS in declaration order. A later layer replaces earlier
values per property; it does not add values or run a separate animation. A state's
properties override its layer's common properties before the global layer cascade.
Inactive layers contribute nothing. If a property has no remaining contribution,
the runtime restores the element's original inline style. Interpolated values are
re-evaluated with each input update.

```css
layer submission {
  state idle initial { spinner { opacity: 0 } }
  state loading { spinner { opacity: 1 } }
  state success { spinner { opacity: 0 } }
  transition idle -> loading when loading
  transition loading -> success when completed
}
```

Each stateful layer evaluates outgoing guards at initialization and once per reactive
update. Guards read the current Boolean value, including values already true at
initialization. The last eligible transition in declaration order wins. If none is
eligible, the current state persists. Only one transition occurs per layer per update,
so cycles cannot drain synchronously. A subsequent parameter or reactive-source
notification schedules another evaluation; no internal loop or application-data
mutation is performed. Multiple stateful layers can advance on the same update.

Motion instances take parameter objects. Exclusive states are local to stateful
layers; the runtime exposes their current selections through `composition.states`.
Timing selection, transition animation ownership, and lifecycle precedence are separate
steps of the layer animation pipeline.

## Timing and easing values

Animation settings are immutable expression values: `tween` and `spring` return
`timing`; easing constants, `cubicBezier`, and `steps` return `easing`. They describe an
animation without starting one. Bind and reuse them through `let`:

```css
let curve = cubicBezier(x1: 0.2, y1: 0, x2: 0, y2: 1)
let quick = tween(duration: 150, easing: curve)
let bounce = spring(stiffness: 400, damping: 20)
```

Calls use the same named-argument syntax as other Liva functions. Numeric values
carry no implicit CSS units. The available signatures are:

- `tween(duration: number = 300, easing: easing = ease)`: duration is nonnegative
  milliseconds. Zero duration settles immediately.
- `spring(stiffness: number = 100, damping: number = 10, mass: number = 1)`:
  positive, finite physical parameters consumed by the runtime spring sampler.
- `spring(duration: number, bounce: number = 0)`: duration is required, finite,
  and positive in milliseconds; bounce is finite and in `[0, 1)`. This overload
  cannot be mixed with stiffness, damping, or mass.
- `steps(count: number, position: string = "end")`: count is a positive integer.
  Position is `start`, `end`, `jump-start`, `jump-end`, `jump-none`, or `jump-both`;
  `jump-none` requires at least two steps.
- `cubicBezier(x1: number, y1: number, x2: number, y2: number)`: all arguments are
  required and finite; x coordinates must be in `[0, 1]`. Y coordinates may overshoot.
- Easing constants: `linear`, `ease`, `easeIn`, `easeOut`, `easeInOut`, `stepStart`, `stepEnd`.

A timing value is replaced as a whole. Different calls never merge their parameters.
Timing and easing values cannot be interpolated into CSS or used as Boolean guards.
Types are checked by the compiler; argument value errors from evaluated expressions
are reported by the runtime. Use typed easing values, rather than CSS strings, as
`tween` arguments. Animation configuration uses typed expressions exclusively.

### Typed animation decorators

Use `@expression` to apply a timing value to a layer, state, transition, lifecycle,
target, single declaration, or entire property track. Motion, let, and event
declarations cannot have timing decorators. A keyframe segment accepts an easing value:

```css
motion button {
  let quick = tween(duration: 150, easing: easeOut)
  layer base {
    body @quick {
      opacity: 1
      scale: 1 @spring(stiffness: 300, damping: 20)
      translate @tween(duration: 400) {
        0%: 0 20px
        50%: 0 5px @easeOut
        100%: 0 0
      }
    }
  }
}
```

The target timing is a default; a property's decorator replaces that whole value.
Track timing goes before the opening brace. CSS values remain CSS, with `${...}`
for scalar interpolation. Style tracks require an explicit 100% destination;
transition tracks can omit endpoints for completion from their source/destination.
Only the selected transition or lifecycle evaluates its timing and frame expressions.

To migrate legacy `@tween: 150ms ease-out`, use `@tween(duration: 150, easing: easeOut)`
on the target or property track. Replace legacy frame suffix `@ ease-out` with
`@easeOut`, or reference a bound easing value. Removed animation declarations and
CSS easing suffixes produce actionable compiler errors. The lossless CST retains
invalid input for diagnostics and decorators separately from CSS value text.

### Layer animation selection

Layer values and explicitly supplied timing values cascade independently. A later layer
may replace a CSS value while retaining timing from a lower layer. Within a layer,
timing precedence, from highest to lowest, is:

1. Selected transition property, target, then shared timing.
2. Destination-state property, target, then shared timing.
3. Layer-common property, target, then shared timing.

State defaults also cover properties inherited from the layer's common style.
Shared transition timing can animate resolved properties without declaring tracks.
Headers can span lines, and a guarded transition can omit its body:

```css
layer interaction @tween(duration: 200) {
  body { opacity: 1 }
  state idle initial {}
  state active @spring(duration: 400) { body { opacity: 0.5 } }
  transition idle -> active
    @tween(duration: 300, easing: steps(count: 4))
    when enabled
}
```

Timing remains scoped in the IR so source tools can distinguish defaults and overrides.
The layer contributing the final CSS value owns its animation. Only that owner's
selected transition may supply temporary timing or keyframes; obscured transition
tracks do not animate or produce endpoint warnings.

A transition can define a property keyframe track, or a direct property declaration
as its final keyframe. Properties without an override use the ordinary cascaded timing.
A missing start frame uses the displayed presentation, and a missing 100% frame uses
the final cascaded CSS value. An explicit differing 100% frame reports a
`runtime.endpoint` diagnostic; completion still restores the resolved CSS value.
Interrupted properties retarget from their current displayed value. Unchanged property
animations continue. Properties with no timing apply immediately.

Spring timing on layer tracks applies the sampled spring curve to the complete track,
including intermediate waypoints. Initial state guards resolve before target binding;
DOM entry animation is controlled by the motion's lifecycle declaration rather than
replaying an initial machine transition during binding.

## Migration from motion-level states

Move independent visual conditions into ordinary layers. Move exclusive states into
a stateful layer with one `initial` state and explicit guarded transitions. Replace
motion-level general timing with shared layer or target decorators and directional
transitions with local guarded transitions. Pass a parameter object to `v-liva` and
`LivaInstance`; string state bindings and `setState` are unsupported. Use
`updateParameters` for application inputs and `composition` for resolved selections.
The runtime rejects Definition IR containing motion-level `states`,
`generalTransition`, or `directionalTransitions` instead of executing a compatibility path.
