# Language specification

A motion declares layers, lifecycle animations, let bindings, and host parameters.
CSS interpolation follows the browser's Web Animations behavior.

## Motion declarations and types

Every top-level definition starts with `motion`:

```liva
motion card {
  let movement = drag(target: body)

  layer interaction {
    body {
      translate: 0 0
      @tween(duration: 200, easing: easeOut)
      scale ~> { 100%: 1 }
    }

    state idle initial {}
    state dragging {
      body { translate: ${movement.offset.x}px ${movement.offset.y}px; scale: 1.05 }
    }

    transition idle -> dragging when movement.active
    transition dragging -> idle when !movement.active {
      body {
        @spring(stiffness: 300, damping: 20)
        translate ~> {}
        @tween(duration: 180, easing: easeOut)
        scale ~> {}
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
The primitive types are `number`, `boolean`, and `string`. A parameter may also
require one quoted string or a finite union of quoted strings:

```liva
motion sample(position: "start" | 'end', axis: "x") {
  let selectedPosition = position
  layer base { --position: ${selectedPosition}; --axis: ${axis} }
}
```

String annotations use the same quote and escape rules as expression strings.
Whitespace and comments may separate members and `|`. Values are compared after
decoding, with no trimming, case folding, or coercion; duplicate members and order
do not change compatibility. Empty strings and Unicode are allowed. Every union
member must be a quoted string: mixed unions such as `string | "x"` and missing
members are errors. A singleton parameter keeps its literal type; a multi-member
parameter keeps its declared finite set through aliases and derived bindings.

Type annotations are declaration-time metadata, not function arguments or runtime
values. User-defined functions and other parameter type forms are outside scope.

Parameters, let bindings, and targets share one variable namespace throughout their
motion, regardless of declaration order. Each target declared in a layer or local state
introduces a target-valued variable; the same target across layers is one
variable. Duplicate declarations and collisions between variable kinds are errors.
Names are local to each motion. Unknown types, invalid
parameter declarations, unresolved references, and primitive member access are errors.

## Parameters, let bindings, and selection

Motion parameters receive host application values. The object in
`v-liva:toggle="{ checked }"` supplies the named parameter of
`motion toggle(checked: boolean)`. Each instance retains its own values.
Updates reevaluate conditions and CSS templates.
Every declared parameter is required; the object is a full parameter snapshot.
Missing parameters are errors, including on updates; no implicit defaults are used.
Explicit `0`, `false`, and `""` are valid when permitted by the declared type. Unknown names, wrong types, and
non-finite numbers are rejected without coercion. Invalid updates report a runtime diagnostic and retain the last
valid parameters, derived values, and presentation together; invalid initial inputs
reject instance creation. Constrained string inputs must belong to their declared
candidate set on creation, every update, and definition replacement. A valid value
remains an ordinary JavaScript string.

A `let` declaration binds the value of an expression:

```liva
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
an optional trailing comma. Calls must match a built-in function signature;
missing required arguments, duplicate or unknown arguments, and incompatible
argument types are compile errors.

The built-in `drag` function accepts one required `target` argument of target type.
In `drag(target: body)`, `body` is an ordinary variable reference resolved in the
motion's scope. Its value refers to the `body` target declared in that motion's
layers. Argument expressions use the same name resolution and type checking as
other expressions. A string-valued variable does not satisfy a target parameter.
The return value has
`active: boolean`, `released: boolean`, and `offset: { x: number, y: number }`. These fields belong to
the built-in return type; object-valued motion parameters are outside scope.
Ordinary function results are reused while argument values are unchanged and
recomputed when arguments change. Reactive built-ins expose current values that
update independently of their arguments. Each instance has its own target values
and host parameters before evaluating `let` initializers.

Drag values expose `active`, `offset.x`, and `offset.y`. Offsets are pixel
displacements from the current pointer-down, reset on each new gesture and retained
on release until the next gesture. Only the primary left-button pointer is tracked.
Pointer-up sets `released` to true after publishing the final offset. The flag
remains true until the next pointer-down; cancellation and lost capture end the
gesture with `released: false` and never trigger release events. Target
replacement and disposal remove listeners and release capture. Set `touch-action:
none` on draggable targets; the adapter does not change application CSS.

### Browser interaction input

`interaction(target: body)` returns a reactive record with five Boolean fields:

| Member         | Browser pseudo-class |
| -------------- | -------------------- |
| `hover`        | `:hover`             |
| `active`       | `:active`            |
| `focus`        | `:focus`             |
| `focusVisible` | `:focus-visible`     |
| `focusWithin`  | `:focus-within`      |

```liva
motion button(disabled: boolean) {
  let ui = interaction(target: body)

  layer base { body { scale: 1 } }
  layer hover when ui.hover && !disabled { body { scale: 1.05 } }
  layer press when ui.active && !disabled { body { scale: .95 } }
  layer focus when ui.focusVisible { body { outline-width: 2px } }
}
```

Each field reads the target element's `matches()` result, including descendant focus
for `focusWithin`. The initial snapshot is taken when the target binds, before its
initial presentation settles. Each instance has independent subscriptions; replacement
and disposal remove listeners and cancel pending rechecks. `interaction()` and
`drag()` can observe the same target without changing native input behavior.

Pointer, mouse, focus, keyboard, click, capture, visibility, and window focus events
trigger a synchronous check and one coalesced check on the next animation frame.
The deferred check observes browser default actions and pseudo-class changes that
occur after dispatch. Unchanged snapshots do not notify subscribers. This is
event-driven observation, not continuous selector polling: changes caused solely by
DOM/style changes, scrolling under a stationary pointer, browser UI, or modality
changes without any observed event are picked up on the next supported trigger.
Keyboard, touch, and pen activation follow the browser's CSS behavior; `active` does
not synthesize a keyboard-pressed or pointer-down state.

This input supplies browser-managed transient state, not raw events or pointer details.
Keep selected, checked, disabled, and other application states in the application and
pass them as motion parameters. Guard hover/press layers explicitly when disabled;
a disabled element may still match `:hover`.

Every motion requires at least one layer. Ordinary layers independently activate
from Boolean conditions. Stateful layers retain one local state and advance through
guarded transitions. Initial presentation settles without animation. Updates start
from displayed values, including interrupted springs. Supported endpoint-only springs
also inherit displayed velocity, as described under Automatic spring momentum.
A dynamic property without timing follows input immediately; unrelated running effects
continue. Timing and value ownership follow the layer cascade described below.

## Property controller option types

The `link` function has these signatures:

- `link(input: number, sensitivity: number = 1)` returns a scalar controller.
- `link(input: number, component: "x" | "y", sensitivity: number = 1)` returns an
  XYZ vector controller, placing the scalar input on the selected axis.
- `link(input: { x: number, y: number }, sensitivity: number = 1)` returns an XYZ
  vector controller. A component argument is not accepted for vector input.

Omitting `component` preserves the scalar/vector input distinction. When supplied,
its type must be a subset of `"x" | "y"`. Direct literals, parentheses, aliases
(including forward bindings), and host parameters such as `axis: "x" | "y"` are
accepted. Broad `string`, unsupported strings such as `"z"`, and non-string inputs
fail compilation. The compiler does not require the component to have one possible
value; changing it after a call is created is checked by the runtime.

```liva
motion mapped(axis: "x" | "y", input: number) {
  let selected = axis
  let movement = link(input: input, component: (selected))
  layer base { translate := movement }
}
```

A controller must attach to one target/property address with `:=`; repeating the
same address is allowed. Permitted components do not relax input-shape or attachment
checks. Either component can initialize the call, but changing the selected axis
during that call causes a runtime error and retains the last committed state.

## Expressions and CSS templates

A quoted string expression has the literal type of its decoded value: `"x"`
has type `"x"`. Parentheses, let bindings, aliases, and forward references preserve
that type. A finite string union such as `"x" | "y"` represents a set of allowed
decoded strings; duplicate members and member order do not affect compatibility.
A literal is assignable to a union containing it and to `string`. A finite union
is assignable to another union when every source member belongs to the destination,
and to `string`. A broad `string` cannot be assigned to a literal or finite union.
These rules do not add structural record compatibility or implicit conversions.

String equality and ordering comparisons use the string primitive category, so
distinct literals and broad strings may still be compared. All string types support
CSS interpolation; none support arithmetic. Runtime values remain ordinary strings.
Parameter annotations can declare these literal types and finite unions.

Expressions support finite decimal numbers, Booleans, quoted strings, parameter and let identifiers,
member access, parentheses, unary `!`, `+`, `-`, arithmetic `+ - * / %`, comparison
`< <= > >=`, equality `== != === !==`, and logical `&& ||`. Operators use normal
precedence; arithmetic requires numbers, logical operations require Booleans, and
comparison requires matching scalar types. Function calls are parsed as expressions;
subscription-producing built-ins are used in `let` initializers. There are no assignments,
computed member accesses, objects, arrays, or implicit unit conversions.

CSS values remain opaque text except for `${expression}` templates:

```liva
translate: ${movement.offset.x}px ${movement.offset.y}px
```

Units are explicit text. The compiler validates expression references and member
paths. Non-finite runtime arithmetic reports a diagnostic and retains valid styles.
CSS validity is delegated to the browser. Omitted properties expose lower active
layers or external CSS. There is no requirement for a complete fallback state.

## Expression names and shadowing

Built-in functions and easing constants belong to a parent scope. Each Motion has
one child scope shared by parameters, `let` bindings, and named targets. A name
may be declared only once in that Motion, regardless of declaration order. Reusing
a named target across layers or states refers to the same target rather than
redeclaring a variable.

Motion declarations may shadow ordinary built-ins. References and calls resolve
the closest declaration: with `let tween = 1`, `tween` is a number and `tween()` is
an error. There is no fallback to the built-in function. Functions cannot be used
as values. Forward let references follow the same rules and cycles are errors.
Only `self` is reserved against all declarations.

## The Motion root and implicit declarations

`self` is the built-in target bound to the Motion root (the element carrying `v-liva`).
It is always available to target-taking functions such as `drag(target: self)`.
Parameters and `let` bindings cannot rebind `self`. Explicit `self { ... }` blocks
configure the existing root target; they do not declare a new target or require a
`v-liva-target` directive.

CSS declarations and tracks directly inside a reactive layer, stateful layer's common
styles, state, directional transition, `enter`, or `leave` apply to `self`:

```liva
motion button {
  @tween(duration: 180)
  layer base {
    scale: 1
    opacity: 1
    icon { rotate: 0deg }
  }
  @tween(duration: 120)
  enter { opacity: 0 }
}
```

Direct declarations can mix with named target blocks. Declaring the same root
property twice in one animation scope, including a value plus a track, reports a
duplicate. Property timing decorators apply only to their property.

An explicit self block is valid wherever a named target block is valid, including
layers, common styles of stateful layers, states, directional transitions, and
motion-level enter/leave. It can coexist with shorthand root properties and tracks
when their property names are distinct. Both forms address the same root: duplicates
within one animation scope are errors, including value/track duplicates split
between the forms. A second self block in the same scope is also a duplicate.

```liva
motion card {
  @tween(duration: 150)
  layer base {
    opacity: 1

    @spring(stiffness: 300, damping: 20)
    self {
      translate: 0 0
      scale: 1 @tween(duration: 200)
    }

    icon { rotate: 0deg }
  }
}
```

Only `translate` inherits the self block's spring; `scale` overrides it with its own
tween. The shorthand `opacity` and sibling `icon` keep the layer's 150 ms tween.
Putting the spring on `layer base` instead would make it the enclosing default.
Self-block timing remains local to the properties declared inside that block while
participating in the normal cross-layer, state, transition, and lifecycle timing
cascade. Root shorthand continues to work without any explicit block.

The delimiter determines the meaning without consulting CSS property names:
`property: value` is a value, `property ~> { ... }` is a track, and `target { ... }`
is a target block. Future CSS properties and custom properties use the same forms.
For example, `opacity { opacity: 1 }` names a target called `opacity`, while
`--progress ~> { 0%: 0; 100%: 1 }` animates a custom property on `self`.
Structural timing decorators precede blocks and tracks; ordinary property timing
and individual frame easing follow their values.

### Target binding and CSS behavior

Targets bind within their declaring Vue component to the nearest Motion root;
ownership does not cross nested Motion roots. Ordinary targets bind one element,
while lifecycle targets can bind multiple keyed elements. Missing or duplicate
required targets suspend the affected instance with diagnostics; read-only
measurement targets may be absent. Removing a target cancels its animations.
Rebinding settles the current composition without replaying old animations.

Liva passes CSS properties and values to the browser without an allowlist or
support checks. Unsupported CSS may produce no visible change without a diagnostic.
Overlapping shorthands/longhands and transform combinations follow browser behavior.
Animated properties require exclusive ownership: competing Vue style bindings,
CSS transitions, and external animations on those properties are unsupported.
When Liva releases a property, it restores the original inline value where it still
owns that property, preserving external edits.

Actual Web Animations construction or playback exceptions report a diagnostic for
the affected track; subsequent input updates can still be processed.

When `prefers-reduced-motion: reduce` is active, animations settle immediately;
direct control and application state remain responsive.

## Immediate timing

`instant` is a built-in timing value. `@instant` immediately applies the resolved
destination, cancelling any running tween or spring for that property. It explicitly
overrides inherited timing; omitting timing continues to inherit. Other properties
keep their independently resolved timing, and removing the instant contribution
restores the usual timing cascade.

```liva
motion draggable {
  let movement = drag(target: self)

  @spring(stiffness: 300, damping: 20)
  layer base { translate: 0 0; scale: 1 }

  layer dragging when movement.active {
    translate: ${movement.offset.x}px ${movement.offset.y}px @instant
    scale: 1.05
  }
}
```

Translation follows the pointer immediately, then springs back on release. `instant`
works at every timing-decorator scope (including tracks, targets, layers, states,
directional transitions, and enter/leave), or in a timing-valued `let` binding.
An instant track applies its destination without intermediate frames. It is not an
easing value and cannot be used as keyframe-segment easing. It uses the existing
zero-duration tween behavior; `@tween(duration: 0)` remains valid. Like other ordinary
built-ins, `instant` can be shadowed by a motion declaration.

## Inline keyframes

```liva
@tween(duration: 350, easing: easeInOut)
scale ~> {
  40%: 1.3 1 @easeIn
  70%: 0.95 1 @cubicBezier(x1: 0.2, y1: 0.8, x2: 0.2, y2: 1)
  100%: 1
}
```

Offsets are unique finite percentages in `[0, 100]`; keyframes run in offset order.
A top-level `@expression` supplies
typed interval easing; quoted or grouped `@` characters remain CSS text. Style tracks
require an explicit 100% destination. Transition endpoints may be omitted and use
the displayed start and resolved destination. Tween easing is the default per
interval; frame easing overrides it. WAAPI effect easing remains linear for tweens.
Spring tracks use the solver curve and do not expose per-frame easing controls.
CSS templates are supported in style, transition, and lifecycle frames. Completion
restores the resolved destination even when an explicit transition endpoint differs.

## Enter, leave, and events

A motion may declare one `enter` and one `leave` directly in its body. Named targets
must be declared in its layers (including local states). The built-in `self` target
is always bound to the Motion root, including lifecycle-only declarations. Lifecycle timing is
independent of ordinary layer timing. Lifecycle property timing overrides target
timing, which overrides the lifecycle shared decorator. Enter uses this timing for
its initial animation; a later ordinary layer change uses that change's timing.

```liva
motion panel(open: boolean) {
  layer base { content { opacity: 1; scale: 0.9 } }
  layer opened when open { content { scale: 1 } }

  enter {
    @tween(duration: 250, easing: easeOut)
    content { opacity: 0; scale: 0.8 }
  }
  leave {
    @tween(duration: 200, easing: easeIn)
    content { opacity: 0; scale: 0.9 }
  }
}
```

Declare DOM lifecycle animations directly in the motion using `enter { ... }`
and `leave { ... }`. Use guarded `transition A -> B` inside a stateful layer for
state-change animation. Layers cannot declare their own enter/leave blocks.

A direct declaration in enter is the 0% frame; in leave it is the 100% frame.
Explicit keyframe blocks and `${expression}` values are also supported. Duplicate
properties are errors. Enter starts from its declared 0% presentation and animates
toward the ordinary cascade. Missing 100% endpoints use that cascade. Leave starts
from the displayed presentation, including interrupted animations, and applies an
internal exit layer containing only its declared properties. Explicit 100% frames
remain animation endpoints even when enter completion restores a different ordinary
value.

Ordinary changes retarget an in-flight enter from its displayed value, using the new
ordinary transition's timing. Supported endpoint-only springs carry displayed
velocity into leave and back into re-entry. Numeric support and fallback behavior
match ordinary transitions; arbitrary CSS, tweens, and intermediate-keyframe tracks
do not promise velocity continuity. Relative-reference changes use the same
retargeting rules without requiring input notifications.

While Motion remains connected, applicable lifecycle expressions follow accepted
input updates. Leave keeps precedence only for its own declarations, so unrelated
properties continue following ordinary layers. On Motion disposal, subscriptions
are released. Ongoing or captured leave work retains its source definition's final
accepted inputs and ordinary presentation across disposal or definition replacement.
Necessary DOM-relative observations continue until its effects end.
Vue waits for the currently applicable effects, including replacements, before
removing or hiding the boundary. Reduced motion settles live playback immediately.

A conditional event is independent of state selection and animation completion:

```liva
event dismiss when movement.released
  && movement.offset.x > 120
```

Conditions must be Boolean expressions. Each Motion instance remembers its own
condition values and emits once on each false-to-true edge. An initially true
condition does not emit. The Vue adapter dispatches a bubbling `CustomEvent`
named `liva-dismiss` from the Motion root; no payload expression is supported.
Use ordinary DOM listeners such as `@liva-dismiss="removeItem(item.id)"`.
Application state changes immediately; it never waits for the leave animation.

## Vue presence support

Use `v-liva`, `v-liva-target`, ordinary Vue structural directives, and Liva
declarations to animate element presence. Presence integration adds no DOM wrapper;
existing element keys, props, listeners, and scoped CSS remain intact.

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

Expression strings decode `\n`, `\r`, `\t`, `\\`, `\'`, and `\"`; unsupported
escapes are diagnosed. CSS strings retain all escapes verbatim for the browser.
If an interpolation's closing `}` is missing, recovery stops at an unquoted newline
so subsequent declarations can still be diagnosed.

Diagnostics prevent execution of invalid definitions. During development, invalid
source updates retain the last valid definition. Production compilation fails on
any error. Block nesting is limited to 64 levels.

## Limitations

Standalone file imports, framework adapters other than Vue, SSR animation,
component-root directive forwarding, Teleport targets and Shadow DOM target
traversal are unsupported.

Explicit authored velocity arguments, free-running inertia, state-change persistence events, scroll/orientation sources,
user functions, and custom CSS interpolation are unsupported.

## Toggle example

```liva
motion toggle(checked: boolean) {
  @tween(duration: 350, easing: easeOut)
  layer toggle {
    track { background-color: #888 @tween(duration: 200, easing: easeInOut) }
    thumb { translate: 0 0 @spring(stiffness: 300, damping: 20); scale: 1 }

    state off initial {}
    state on {
      track { background-color: #34b27b }
      thumb { translate: 24px 0 }
    }

    transition off -> on when checked {
      thumb { scale ~> { 40%: 1.3 1 @easeIn; 70%: 0.95 1 @easeOut } }
    }
    transition on -> off when !(checked) {
      thumb {
        @spring(duration: 350, bounce: 0.2)
        translate ~> {}
        scale ~> { 40%: 1.3 1 @easeIn; 70%: 0.95 1 @easeOut }
      }
    }
  }
}
```

## Reactive layer declarations

An unconditional layer is always active; conditional layers are independently active
when their Boolean expressions are true. Declaration order determines property-level
cascade precedence. Layers do not imply additive composition.

```liva
motion button(hovered: boolean, pressed: boolean) {
  layer base { body { scale: 1 } }
  layer hover when hovered { body { scale: 1.05 } }
  layer press when pressed { body { scale: 0.95 } }
}
```

Layer names are unique within a motion. CSS values retain CSS syntax and units;
`${expression}` interpolates scalar values. Active values and timing are resolved
on each input update.

### Stateful layers

Use reactive layers for independent Boolean visual conditions. Use a stateful layer
when an interaction must retain one of several exclusive states. Each stateful layer
owns its state names and requires exactly one `initial` state:

```liva
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
use guarded transitions instead of `state ... when` selection.

### Layer cascade and guarded updates

Active layers contribute CSS in declaration order. A later layer replaces earlier
values per property; it does not add values or run a separate animation. A state's
properties override its layer's common properties before the global layer cascade.
Inactive layers contribute nothing. If a property has no remaining contribution,
the runtime restores the element's original inline style. Interpolated values are
re-evaluated with each input update.

```liva
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

## Timing and easing values

Animation settings are immutable expression values: `tween` and `spring` return
`timing`; easing constants, `cubicBezier`, and `steps` return `easing`. They describe an
animation without starting one. Bind and reuse them through `let`:

```liva
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
- `steps(count: number, position: "start" | "end" | "jump-start" | "jump-end" | "jump-none" | "jump-both" = "end")`:
  position is optional and defaults to `"end"`. Count is a positive integer;
  `"jump-none"` requires at least two steps. Count constraints remain runtime checks.
- `cubicBezier(x1: number, y1: number, x2: number, y2: number)`: all arguments are
  required and finite; x coordinates must be in `[0, 1]`. Y coordinates may overshoot.
- Easing constants: `linear`, `ease`, `easeIn`, `easeOut`, `easeInOut`, `stepStart`, `stepEnd`.

Physics springs follow `mass * x'' + damping * x' + stiffness * (x - destination) = 0`.
Duration springs use damping ratio `1 - 0.9 * bounce`; increasing bounce reduces
damping, while duration controls the settling target.

A timing value is replaced as a whole. Different calls never merge their parameters.
Timing and easing values cannot be interpolated into CSS or used as Boolean guards.
Types are checked by the compiler; argument value errors from evaluated expressions
are reported by the runtime. Use typed easing values, rather than CSS strings, as
`tween` arguments. Animation configuration uses typed expressions exclusively.

`steps.position` accepts permitted literals, parentheses, aliases, and parameters
whose declared candidate set is a subset of the six choices. Unsupported strings,
non-string values, and broad `string` parameters are compile errors. Runtime calls
and untrusted definitions still validate positions and numeric count constraints.

Declare a host parameter using the choices the application supplies, for example:

```liva
motion stepped(position: "start" | "end", count: number) {
  let selected = position
  let curve = steps(count: count, position: selected)
  layer base { opacity: 1 @tween(easing: curve) }
}
```

### Typed animation decorators

Use `@expression` to apply a timing value to a layer, state, transition, lifecycle,
target, single declaration, or entire property track. Motion, let, and event
declarations cannot have timing decorators. A keyframe segment accepts an easing value:

```liva
motion button {
  let quick = tween(duration: 150, easing: easeOut)
  layer base {
    @quick
    body {
      opacity: 1
      scale: 1 @spring(stiffness: 300, damping: 20)
      @tween(duration: 400)
      translate ~> {
        0%: 0 20px
        50%: 0 5px @easeOut
        100%: 0 0
      }
    }
  }
}
```

Timing decorators precede layers, states, directional transitions, motion-level
enter/leave, targets, and property keyframe blocks. They attach to the next
structural declaration. Write each structural decorator on its own line, with
the block starting on the following line at the same indentation. The parser
also accepts same-line prefixes. Comments
between the expression and declaration are preserved. `motion`, `let`, and
`event` do not accept decorators.

Value declarations retain suffix decorators: `opacity: 1 @quick` supplies timing,
and `0%: 0 @easeOut` supplies easing for the outgoing interval to the next frame.
An easing decorator on 100% has no outgoing interval and produces a warning.
Omitted transition/lifecycle endpoints are completed at runtime, so an easing on
an earlier last explicit frame still controls the interval to the implicit 100%.
Timing and easing expressions use the ordinary expression grammar and type checks.

The target timing is a default; a property's decorator replaces that whole value.
Structural timing decorators precede the entire declaration. CSS values remain CSS, with `${...}`
for scalar interpolation. Style tracks require an explicit 100% destination;
transition tracks can omit endpoints for completion from their source/destination.
Only the selected transition or lifecycle evaluates its timing and frame expressions.

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

```liva
@tween (duration: 200)
layer interaction {
  body {
    opacity: 1;
  }
  state idle initial {
  }
  @spring (duration: 400)
  state active {
    body {
      opacity: 0.5;
    }
  }
  @tween (duration: 300, easing: steps(count: 4))
  transition idle -> active when enabled;
}
```

The layer contributing the final CSS value owns its animation. Only that owner's
selected transition may supply temporary timing or keyframes; obscured transition
tracks do not animate or produce endpoint warnings.

A transition can define a property keyframe track, or a direct property declaration
as its final keyframe. Properties without an override use the ordinary cascaded timing.
A missing start frame uses the displayed presentation, and a missing 100% frame uses
the final cascaded CSS value. An explicit differing 100% frame reports a
`runtime.endpoint` diagnostic; completion still restores the resolved CSS value.
Interrupted properties retarget from their current displayed value. Authored
intermediate frames remain and restart their full timeline. Explicit tracks can
animate even when their endpoints are equal. Unchanged property animations continue.
Properties with no timing apply immediately.

Spring timing on layer tracks applies the sampled spring curve to the complete track,
including intermediate waypoints. Initial state guards resolve before target binding;
DOM entry animation is controlled by the motion's lifecycle declaration rather than
replaying an initial machine transition during binding.

## Reactive layout bounds

`measure(target: target, relativeTo: target = self)` returns a reactive record with
`x`, `y`, `width`, `height`, and `attached`. Numbers are fractional physical CSS
pixels: x increases rightward and y downward, including under RTL. Positions are
relative to the reference padding-box origin, immediately inside its border.
Dimensions describe the target border box. The reference must be the target or an
ancestor. Self-measurement explicitly has x=y=0. Declare read-only named targets
with an empty target block; those targets can be absent without suspending Motion.

```liva
let bounds = measure(target: label)
layer base {
  label {}
  indicator { translate: ${bounds.x}px ${bounds.y}px; width: ${bounds.width}px }
}
```

The receiving element must use a compatible containing block. Border-box measurements
are not automatically converted into content-box CSS widths. Set
`box-sizing: border-box` or perform application conversion explicitly.

Measurements remove page, reference, and nested scroll offsets and supported 2D
transforms without changing application styles. The initial scope is ordinary
single-box HTML layout, including transformed ancestor chains. Fragmented inline
boxes, SVG, sticky/fixed positioning, CSS zoom, perspective/3D transforms, and
unresolvable transform expressions are unsupported. Unsupported, absent,
disconnected, or display:none boxes return all zeros and attached=false;
visibility:hidden and genuine zero-size boxes remain measurable. Layout changes
update the bounds; scrolling or transforms alone do not change layout coordinates.

Percentage `translate` values use the transform reference box: `content-box` and
`fill-box` use content dimensions for HTML, while `border-box` and `view-box` use
border dimensions. Border-box dimensions are still returned in all cases. HTML
`stroke-box` transforms are unsupported because engines disagree on their percentage
reference sizes. When content and border boxes differ, content/fill-box rotation,
scale, and skew are also unsupported: CSSOM can resolve a percentage transform-origin
against border-box dimensions while rendering against the content box, losing the
original unit and making the used pivot ambiguous. These cases diagnose and return
attached=false rather than publishing incorrect coordinates. Translation-only
content/fill-box transforms remain measurable because they do not depend on the
pivot. Resolving retained calc() expressions is outside the current numeric decoder.
Very small invertible scales amplify viewport-coordinate rounding during inversion;
fractional output does not imply a fixed positional error bound across engines.

Initial binding reads geometry synchronously before Motion settles its initial
presentation, without an initial animation. Later supported invalidations coalesce
into an animation-frame pass. All reads finish before snapshots publish; dependent
writes schedule further reads on a later frame. Unchanged snapshots do not notify.
Updates follow document structure, text, attributes, target and reference sizes,
window resizing, and load/font completion events. Liva-managed layout animations
also update measurements each frame while running.

External CSSOM edits, arbitrary script timing, and third-party CSS/Web Animations
are not continuously synchronized. A third-party write after the read phase may
leave a transient stale sample. There is no continuous polling option. Deferred
reads do not solve feedback cycles: measuring self.width and writing width+10 is
unsupported and can oscillate across frames.

Measure naturally sized inner content for expansion; do not measure the constrained
animated shell or remove application styles to discover intrinsic sizes.

## Motion-local feedback timers

`timeout(when: boolean, duration: number)` returns a reactive Boolean. Duration is
finite, nonnegative milliseconds. The result initially is false. A true condition
starts a timer when the binding activates; expiration publishes true. False cancels
pending work and resets the result. Unchanged arguments never restart the timer.
Changing duration restarts an active timer from that update, including after expiry.
A success-to-error status change whose condition remains true does not restart it.
Zero duration is scheduled asynchronously. Unbinding, replacement, disposal, and
HMR cancel obsolete work.

```liva
let expired = timeout(when: status == "success" || status == "error", duration: 1500)
```

Use the result in ordinary guarded transitions to return local feedback to idle.
Vue continues to own asynchronous requests, their outcomes, and duplicate submission
prevention.

## Property controllers and release events

`link(input: number)` returns a scalar controller. `link(input: {x, y})` returns a
translate controller; scalar input with `component: "x"` or `"y"` also targets
translate. The component selects the destination axis and accepts an ordinary string
expression, including a let binding or motion parameter. `sensitivity` defaults to 1
and can be negative. Attach with `:=`, keeping ordinary CSS destinations under `:`.

```liva
let pointer = drag(target: self)
let movement = link(input: pointer.offset.x, component: "x")
let projected = movement.value.x + movement.velocity.x * 200

@spring(stiffness: 300, damping: 25)
layer position {
  translate: 0 0
  state closed initial {}
  state open { translate: 96px 0 }
  on pointer.release {
    transition closed -> open when projected > 48
    transition open -> closed when projected <= 48
  }
}
layer dragging when pointer.active { translate := movement }
```

Every declared controller must have one statically resolved target/property address,
including unused controllers and aliases. Repeated declarations at that same address
are allowed. Aliases share the original controller; inline calls have separate
identities. Scalar adapters support width/height, inline/block-size,
physical/logical inset longhands, and scalar rotate. Input delta 1 means 1 CSS pixel
or 1 degree before sensitivity. Translate preserves captured Z and unmapped axes.
Generic inputs have no pointer provenance: transform viewport input explicitly when
local coordinates are needed. The runtime rejects component values other than `"x"`
or `"y"` and rejects a change of component during a controller's lifetime, preserving
the last committed state. The compiler checks the permitted component set;
component stability during a call's lifetime is checked at runtime.
Unbound controllers, multiple addresses, and input feedback cycles are compile errors.
The compiler checks that `:=` receives a controller, but does not check compatibility
between its value shape and the receiving CSS property. Pair adapters with the supported
property forms above; accepting a binding does not add runtime support for other properties
or shapes.

Control captures displayed property P0 and input I0 on activation, then writes
`P0 + (input - I0) * sensitivity` immediately. Ordinary input changes preserve this
baseline. Sensitivity changes rebase at the displayed pose. Losing and reacquiring
ownership captures a new baseline; retaining the same effective controller does not.
Underlying destination changes take effect when control ends. Resized application
state must be committed by the application. Reduced motion keeps direct control
responsive and settles subsequent animations immediately.

Controller snapshots expose `.value`, `.velocity`, and `.attached` on input/application
updates and explicit snapshot reads. They do not poll or notify on animation frames.
`.value` reads the displayed property, or the proposed relative-control position when
an input update is being evaluated. `.velocity` is derived only from committed input
changes after sensitivity/component mapping, in canonical units per millisecond.
It does not describe another owner's animation or the return spring. Unmapped
translate components have zero input velocity. Control acquisition and sensitivity
changes reset input history; expired movement reads as zero even when input is unchanged.

Missing, detached, or non-rendered targets return mapped-input fallback positions
with `attached: false`; availability changes alone do not publish updates. Input
velocity continues independently of target availability. Undecodable visible values
report a deduplicated diagnostic when binding/control is attempted and preserve normal
presentation until recovery. Invalid or non-finite inputs fail the transaction and
retain committed state. Input-derived velocity can differ from displayed motion if
external CSS constrains or overrides the controlled property.

`drag().release` is an event capability for each successful pointer-up. Existing
`.released` remains a persistent Boolean until the next gesture. Cancellation and
lost capture do not emit release. `on eventExpression { ... }` belongs inside a
stateful layer and contains only that layer's transitions; the guard is optional.
Aliases of event values work. Booleans, nested event blocks, and arbitrary callbacks
do not. Each occurrence evaluates outgoing candidates from the starting state once
per layer. Event and ordinary candidates share source order; the last eligible
candidate wins. Other layers receive the same occurrence and snapshot. Unmatched
occurrences are never retried, and observations cannot replay a release.

Terminal pointer-up input is incorporated into previously effective control before
guards read frozen terminal position/input-velocity snapshots. Once transitions are
selected, control release transfers that velocity to property motion history before
the selected spring is prepared. Distinct occurrences are queued in order, never recursively
evaluated or coalesced. Mount, reconnection, target replacement, HMR, and disposal
never replay historical events. The 200ms projection and 48px threshold above are
application policy.

## Automatic spring momentum

Endpoint-only springs inherit displayed velocity across direct updates, tweens,
and other springs, independently per component and across layer ownership changes.
Supported properties are translate, scale, scalar rotate, opacity, numeric dimensions,
and physical/logical insets. Inset shorthands resolve to independently owned physical
longhands, preserving shorthand/longhand handoffs. Explicit intermediate keyframes
retain their authored choreography without injected initial velocity.

Lengths resolve to CSS pixels, scale/opacity to unitless numbers, and scalar rotation
to CSS degrees. Rotation follows the numeric degree destination without implicit
shortest-arc wrapping; 3D rotation falls back to ordinary browser interpolation.
Compatible units, numeric calc(), and percentages resolve through browser computed
styles. Translate percentages use the element's untransformed border box. Other
length percentages use their CSS containing block. Relative destinations retarget
from the displayed pose when reference sizes, relevant variables, fonts, or viewport
change. Active direct-control sessions retain their captured pixel baseline during
layout changes. Auto, discrete, and unreadable values retain ordinary animation.
Authored units and expressions remain unchanged.

Controller release supplies recent mapped-input velocity; ordinary direct updates use
recent displayed samples. Both use an 80ms freshness window. Stationary holds expire
movement; same-time updates never divide by zero. Spring velocity persists beyond
rendered opacity bounds. Opacity rendering clamps to [0,1], without resetting the
internal spring. A nonzero incoming velocity animates even with equal endpoints,
and may initially move away before reversing. Replaced effects cannot write later.

Both physics and duration springs preserve initial velocity. Duration is a settling
target that preserves the requested bounce ratio and finishes at the destination;
it is not an exact trajectory or mathematical rest-time guarantee. Physics springs
must settle within 10 seconds, and sampling is limited to 8192 samples. Exceeding a
limit reports an error. Mount, target replacement, and disposal reset motion history.
