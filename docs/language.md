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
`active: boolean` and `offset: { x: number, y: number }`. These fields belong to
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
Cancellation and lost capture release the gesture just like pointer-up. Target
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
CSS validity and easing validity are delegated to the browser. States must declare
the same target/property set; implicit DOM fallback remains future work.

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
an inherited transition. These are the minimal local normalization rules.

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
but warn because final settlement uses the destination state. Runtime templates are currently supported only in state CSS values. Keyframe
templates are diagnosed; their evaluation timing remains future design work.

## Syntax and recovery

Declarations are separated by newline or optional semicolon. Balanced CSS groups
may span lines. Strings, escapes, `//` and `/* */` comments are preserved. Motion,
state names follow `[A-Za-z_][A-Za-z0-9_-]*`. Variable names (targets, let bindings,
and parameters) follow `[A-Za-z_][A-Za-z0-9_]*`, so subtraction is unambiguous. CSS property names also allow custom properties.

The Rowan CST preserves every byte, trivia and UTF-8 ranges, including malformed
input. Diagnostics prevent execution of invalid definitions while development
retains the last valid definition. Production fails on any compilation error.

## Scope

No velocity input, inertia, retained states, state-change persistence events,
simultaneous state layers, scroll/orientation sources, user functions, custom CSS
interpolation, or standalone preview environment. Omitted-state CSS sampling and
additional source types remain unresolved future design work. The editor edits
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
