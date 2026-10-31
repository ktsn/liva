# Language specification

A motion declares states, transitions, runtime sources, and host parameters. Rust
compiles lossless CST into serializable Definition IR; the browser interpolates
CSS through WAAPI.

## Motion declarations and types

Every top-level definition starts with `motion`:

```css
motion card {
  source movement = drag(target: body)
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
are never function arguments or runtime values. Functions and advanced types are outside scope.

Parameters and runtime sources share one expression namespace throughout their
motion, regardless of declaration order. Duplicate parameter names and collisions
with sources are errors. Names are local to each motion. Unknown types, invalid
parameter declarations, unresolved references, and primitive member access are errors.

## Parameters, sources, and selection

Motion parameters receive host application values. The object in
`v-liva:toggle="{ checked }"` supplies the named parameter of
`motion toggle(checked: boolean)`. Each instance retains its own values, separate
from the immutable Definition IR. Updates reevaluate conditions and CSS templates.
Every declared parameter is required; the object is a full parameter snapshot.
Missing parameters are errors, including on updates; no implicit defaults are used.
Explicit `0`, `false`, and `""` are valid values. Unknown names, wrong types, and
non-finite numbers are rejected without coercion. Invalid updates report a runtime diagnostic and retain the last
valid values; invalid initial inputs reject instance creation.

`source` is reserved for runtime-generated input, currently
`source movement = drag(target: body)`. Parameters and sources use the same
expression evaluator but separate initialization.
Drag sources expose `active`, `offset.x`, and `offset.y`. Offsets are pixel
displacements from the current pointer-down, reset on each new gesture and retained
on release until the next gesture. Only the primary left-button pointer is tracked.
Cancellation and lost capture release the gesture just like pointer-up. Target
replacement and disposal remove listeners and release capture. Set `touch-action:
none` on draggable targets; the adapter does not change application CSS.

Each definition has exactly one unconditional fallback state. Conditions use
`state on when checked { ... }`, without interpolation delimiters. Conditions are
Boolean; the last declared true condition wins. Declaration order is significant.
Initial selection settles without animation. Same-state source updates update
only affected dynamic values, without replaying a transition. Dynamic properties
follow input immediately: a newer value cancels that property's running effect,
while unrelated effects (such as scale) continue. State changes start from displayed
values, including interrupted return springs, without carrying release velocity.

## Expressions and CSS templates

Expressions support finite decimal numbers, Booleans, quoted strings, parameter and source identifiers,
member access, parentheses, unary `!`, `+`, `-`, arithmetic `+ - * / %`, comparison
`< <= > >=`, equality `== != === !==`, and logical `&& ||`. Operators use normal
precedence; arithmetic requires numbers, logical operations require Booleans, and
comparison requires matching scalar types. There are no calls, assignments,
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
state and target names follow `[A-Za-z_][A-Za-z0-9_-]*`; expression identifiers use
letters, digits and underscores, so subtraction is unambiguous. Sources and parameters use
expression identifiers. CSS property names also allow custom properties.

The Rowan CST preserves every byte, trivia and UTF-8 ranges, including malformed
input. Diagnostics prevent execution of invalid definitions while development
retains the last valid definition. Production fails on any compilation error.

## Scope

No velocity input, inertia, retained states, state-change persistence events,
simultaneous state layers, scroll/orientation sources, user functions, custom CSS
interpolation, or standalone preview environment. Omitted-state CSS sampling and
additional source types remain unresolved future design work. The editor edits
existing transition parameters and frames; source/condition authoring is textual.

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
