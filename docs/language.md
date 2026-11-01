# Language specification

A motion declares states, transitions, let bindings, and host parameters. Rust
compiles lossless CST into serializable Definition IR; the browser interpolates
CSS through WAAPI.

## Motion declarations and types

Every top-level definition starts with `motion`:

```css
motion card {
  let movement = drag(target: body)
  state idle { body { translate: 0 0 } }
  state dragging when movement.active {
    body { translate: ${movement.offset.x}px 0 }
  }
  transition { @spring: 300 20 1 }
}

motion progressIndicator(
  progress: number,
  enabled: boolean,
  label: string
) {
  state idle {
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
motion, regardless of declaration order. Each target declared in a state's target
block introduces a target-valued variable; the same target across states is one
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
states. Argument expressions use the same name resolution and type checking as
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

Each definition has exactly one unconditional fallback state. Conditions use
`state on when checked { ... }`, without interpolation delimiters. Conditions are
Boolean; the last declared true condition wins. Declaration order is significant.
Initial selection settles without animation. Same-state variable updates update
only affected dynamic values, without replaying a transition. Dynamic properties
follow input immediately: a newer value cancels that property's running effect,
while unrelated effects (such as scale) continue. State changes start from displayed
values, including interrupted return springs, without carrying release velocity.

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
CSS validity and easing validity are delegated to the browser. Conditional states inherit omitted targets and properties from the unconditional
fallback state. The fallback must provide the complete state property set; implicit
DOM fallback for missing state properties remains outside scope. Dynamic destination
properties without transition timing update immediately.

## Animation declarations

```css
@tween: 350ms ease-out
@tween-duration: 200ms
@tween-easing: cubic-bezier(0.2, 0.8, 0.2, 1)
@spring: 300 20 1
@spring: 350ms 0.2;
```

Tween shorthand expands duration and easing (default `linear`). Spring shorthand
expands stiffness/damping/mass (mass defaults to 1) or duration/bounce (bounce
defaults to 0). Longhands use the corresponding `@spring-` prefixes. Duration is
finite `ms` or `s`; tween duration is nonnegative and spring duration positive.
Physics parameters are positive. Bounce is in `[0, 1)`.

Later declarations override earlier fields. Shorthands reset their whole timing
configuration. A tween/spring family switch clears the previous family. Mixing
physics and duration spring longhands is an error unless a shorthand resets the
configuration. Longhands may complete earlier longhands in the same block; a
complete normalized timing is required locally. They do not partially merge with
an inherited transition. Normalization is local to each block.

General and directional transitions merge per property: directional property,
general property, directional global, then general global timing. Timing is an
atomic override. A property's explicit keyframe collection replaces the inherited
collection as a whole. No timing for an animated property is a compilation error.

## Inline keyframes

```css
40%: 1.3 1 @ ease-in 70%: 0.95 1 @ cubic-bezier(0.2, 0.8, 0.2, 1);
```

Offsets are unique finite percentages in `[0, 100]`; IR sorts keyframes, never
states. A top-level `@` separates optional interval easing from the opaque CSS
value; quoted or grouped `@` characters remain CSS text. Missing endpoints derive
from the states. Tween easing is the default per interval, overridden by each
frame's easing. WAAPI effect easing stays linear for tweens. Intermediate frames
or frame easing with springs are errors. Explicit endpoints can differ from states
but warn because final settlement uses the destination state. Runtime templates are supported in state CSS values and lifecycle keyframes.
Ordinary transition keyframe templates remain unsupported.

## Enter, leave, and events

A Motion may declare one default `enter` and one default `leave` block, plus one
`enter stateName` and one `leave stateName` per state. State names must resolve in
the same Motion. Lifecycle timing is independent of ordinary state transitions.
Targets must already be declared in the Motion's states. The root is animated
only when explicitly bound as a named target.

```css
motion panel(open: boolean, distance: number) {
  state closed {
    content { opacity: 1; scale: 0.9; translate: 0px 0 }
  }
  state opened when open {
    content { scale: 1 }
  }
  transition { @tween: 150ms }

  enter {
    @tween: 250ms ease-out
    content { opacity: 0 }
  }
  enter opened {
    content { scale: 0.8 }
  }
  leave {
    @tween: 200ms ease-in
    content { opacity: 0 }
  }
  leave opened {
    content { scale: 1.2; translate: ${distance}px 0 }
  }
}
```

The state selected at insertion/showing chooses `enter stateName`; the state
selected at removal/hiding chooses `leave stateName`. Properties not mentioned
by the state-specific block inherit the default. For each property, timing uses
this precedence: state-specific property, default property, state-specific block,
default block. Existing `@tween`, `@spring`, and their longhands retain their
CSS-like declaration-order behavior. A property with authored frames replaces the
entire inherited frame set; a timing-only property inherits the default frames.

A direct CSS declaration in a lifecycle target is endpoint shorthand:

```css
enter { content { opacity: 0 } } // opacity { 0%: 0 }
leave { content { opacity: 0 } } // opacity { 100%: 0 }
```

These examples show property syntax only; effective timing must also be supplied.
Shorthand and explicit keyframes can coexist for different properties. Repeating
a property within one target is an error, including mixing shorthand and explicit
frames for that property. Across default and state-specific blocks, shorthand
replaces the complete inherited frame set just like explicit keyframes.

CSS names retain standard CSS spelling. Values remain CSS text; `${expression}`
embeds a scalar from the Motion's existing expression environment. Units are never
added automatically. Both shorthand and explicit lifecycle frames support these
templates, evaluated only when that lifecycle starts, after state-specific
inheritance. Ordinary state CSS declarations retain their existing meaning.

Enter runs on initial insertion, subsequent insertion, and showing. Missing final
endpoints use the captured state's resolved CSS values where available. Its initial
presentation is installed before insertion; disconnected elements do not require
computed styles when the state supplies the value. Completion settles to the
captured state. Leave captures the state, expression values, and displayed
presentation before disposal or hiding. Its omitted starting frame uses that
presentation, including an interrupted animation, rather than blindly using state
CSS. Explicit frames remain authored overrides. Leave ends at its final keyframe
and then permits removal or hiding.

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

The [swipe playground](../playground/src/SwipeDismissDemo.vue) combines drag,
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
may span lines. Strings, escapes, `//` and `/* */` comments are preserved. Motion,
state names follow `[A-Za-z_][A-Za-z0-9_-]*`. Variable names (targets, let bindings,
and parameters), function names, and expression member names follow
`[A-Za-z_][A-Za-z0-9_-]*`. A hyphen without surrounding whitespace belongs to the
identifier: `max-min` is one name. Binary subtraction requires whitespace on both
sides, as in `max - min`; unary minus remains valid in `-1` and `-value`. CSS property names also allow custom properties.

Numbers with units, such as `20px` and `100ms`, are single lexical tokens.
They remain opaque CSS/timing values; unit-bearing arithmetic in Liva expressions
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

No velocity input, inertia, retained states, state-change persistence events,
simultaneous state layers, scroll/orientation sources, user functions, custom CSS
interpolation, or standalone preview environment. Omitted-state CSS sampling and
additional source types are unsupported. DOM-derived state values require decisions
about when to sample computed or animated styles, when to refresh them, and how to
restore the CSS cascade after removing Liva-owned inline values. The editor edits
existing transition parameters and frames; let/condition authoring is textual.

## Toggle example

```css
motion toggle(checked: boolean) {
  state off {
    track {
      background-color: #888
    }

    thumb {
      translate: 0 0
      scale: 1
    }
  }

  state on when checked {
    track {
      background-color: #34b27b
    }

    thumb {
      translate: 24px 0
      scale: 1
    }
  }

  transition {
    @tween: 350ms ease-out

    track {
      background-color {
        @tween-duration: 200ms
        @tween-easing: ease-in-out
      }
    }

    thumb {
      translate {
        @spring: 300 20 1
      }

      scale {
        40%: 1.3 1 @ ease-in

        70%: 0.95 1 @ ease-out
      }
    }
  }

  transition on -> off {
    thumb {
      translate {
        @spring: 350ms 0.2
      }
    }
  }
}
```
