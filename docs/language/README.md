# Language specification

Liva defines how Vue elements change appearance in response to application state,
browser input, and DOM changes. Write a `motion` in a Vue single-file component's
`<liva>` block to declare the styles that apply in each situation and the timing
for changes between them. Vue owns the elements and application state.

- [Layers and state transitions](layers.md) for targets, states, and the CSS cascade.
- [Animation timing and keyframes](animation.md) for decorators, easing, and spring momentum.
- [Reactive inputs and property controllers](interaction.md) for browser input, timers, and drag release.
- [Vue lifecycle and events](vue.md) for element presence and events sent to Vue.
- [Layout measurement and animation](layout.md) for `measure()` and `$layout`.

## A motion in Vue

This switch passes its checked state to Liva. The base layer sets the thumb's
position and animation timing. When `checked` is true, the later layer changes
the position. The thumb uses the base timing in both directions.

```vue
<script setup>
import { ref } from 'vue'

const checked = ref(false)
</script>

<template>
  <button
    v-liva:toggle="{ checked }"
    type="button"
    role="switch"
    :aria-checked="checked"
    @click="checked = !checked"
  >
    Wi-Fi
    <span v-liva-target:thumb class="thumb" aria-hidden="true">●</span>
  </button>
</template>

<style scoped>
.thumb {
  display: inline-block;
}
</style>

<liva lang="liva">
motion toggle(checked: boolean) {
  layer base {
    @tween(duration: 180, easing: easeOut)
    thumb { translate: 0 0 }
  }

  layer checked when checked {
    thumb { translate: 16px 0 }
  }
}
</liva>
```

The argument to `v-liva` names the motion. The directive's value supplies its
parameters, and `v-liva-target:thumb` binds the target named `thumb`. Initial layer
styles settle immediately. See the [Vue setup instructions](../../README.md#vue-integration)
and the complete [switch component](../../playground/src/components/Toggle.vue).

## Motions

A `motion` is a named definition for a group of related animations.

### Parameters

Name each parameter and its [type](#built-in-types) as `name: type`. Separate
parameters with commas. A trailing comma is optional.

```liva
motion progress(value: number, enabled: boolean) {
  layer base { opacity: 0 }
  layer visible when enabled { opacity: ${value} }
}
```

A motion without parameters can omit the parentheses or use `()`.

Each motion instance receives a complete parameter object on creation, on
updates, and on definition replacement. Unknown names, missing parameters,
incorrect types, non-finite numbers, and values outside a declared string set
cause an error. An invalid initial input rejects creation. An invalid update
reports a runtime diagnostic and retains the previous valid parameters, derived
values, and presentation together. The same retention applies when evaluating
a new input produces an error.

### Let bindings

Use `let name = expression` to name a derived value. The compiler infers its type.

```liva
let doubled = value * 2
```

Bindings may refer to parameters, targets, and other bindings, including later
declarations. Cycles are compile errors. When parameters or reactive sources
change, Liva evaluates bindings in dependency order before conditions and CSS
templates.

## Built-in types

| Parameter type           | Example annotation           |
| ------------------------ | ---------------------------- |
| Number                   | `progress: number`           |
| Boolean                  | `enabled: boolean`           |
| String                   | `label: string`              |
| Single string literal    | `axis: "x"`                  |
| Union of string literals | `position: "start" \| 'end'` |

String literal types use the [expression string rules](#syntax-and-recovery).
Each member of a union is quoted. Comments and whitespace may surround the `|`
separators. Empty strings and Unicode are supported.

A quoted value has the literal type of its decoded text. A union represents the
set of its decoded members regardless of order or duplication. A literal or union
satisfies another string constraint when all its possible values are allowed by
that constraint. Both also satisfy `string`. A general `string` satisfies only the
unconstrained string type. Parentheses and aliases preserve literal and union
types, so you can pass constrained parameters through `let` bindings to built-in
options.

## Expressions and CSS templates

### Literals

Write finite decimal numbers, Booleans, and strings. Strings use single or double
quotes.

```liva
let distance = 12.5
let enabled = true
let label = "Open"
```

### References and member access

Refer to a parameter, target, or binding by name. Use `.` to read a member of a
value returned by a built-in, such as the horizontal offset of a drag. Here,
`distance` refers to the binding in the previous example.

```liva
let limit = distance
let pointer = drag(target: self)
let dragging = pointer.active
let horizontal = pointer.offset.x
```

Parameters, `let` bindings, and targets share a scope within each motion regardless
of declaration order. Each name can declare one variable. Referencing the same
target in several layers or states uses the same variable.

Built-in functions and easing constants are in the enclosing scope. A motion
declaration can shadow them. With `let tween = 1`, a reference to `tween` reads the
number and `tween()` is invalid. Functions cannot be used as values. The target
name `self` is reserved.

### Function calls

Pass arguments by name. Calls allow a trailing comma and use built-in signatures.

```liva
let quick = tween(duration: 180, easing: easeOut)
```

Ordinary call results are reused while arguments stay the same. Reactive
built-ins such as `drag` can publish new values even when their arguments stay
the same. Define calls that subscribe to reactive input in `let` initializers.

### Operators and grouping

Operators use their usual precedence. Use parentheses to group an expression.
In this example, the addition happens before multiplication.

```liva
let travel = (distance + 2) * 3
let farEnough = dragging && travel > 30
```

| Operation  | Operators                   | Operand types         |
| ---------- | --------------------------- | --------------------- |
| Arithmetic | `+ - * / %` and unary `+ -` | Numbers               |
| Ordering   | `< <= > >=`                 | Matching scalar types |
| Equality   | `== !=`                     | Matching scalar types |
| Logic      | `&&`, `\|\|`, and unary `!` | Booleans              |

`==` and `!=` compare matching scalar types without coercion. `===` and `!==`
are not supported; replace them with `==` and `!=`, respectively.

All string types share the same comparison rules, so a literal, a union, and a
general string can be compared with one another. Expressions have no assignments,
computed member access, object or array literals, or implicit conversions.

### CSS templates

A CSS declaration retains ordinary CSS syntax. Use `${pointer.offset.x}` to
insert a scalar expression, and write any CSS units outside the interpolation.
Custom properties use the same syntax as other CSS properties.

```liva
translate: ${pointer.offset.x}px ${pointer.offset.y}px
```

Non-finite arithmetic results report a runtime diagnostic. Liva delegates CSS
validation and interpolation to the browser's CSS and Web Animations
implementations. Unsupported CSS may have no visible effect and produce no
diagnostic. Overlapping CSS shorthands, longhands, and transform properties
follow browser rules.

## Syntax and recovery

Separate declarations with a newline or semicolon. Balanced CSS groups and
structural headers can span lines. The syntax supports `//` and `/* */`
comments. Block nesting is limited to 64 levels.

Motion, layer, state, variable, function, and expression member names follow
`[A-Za-z_][A-Za-z0-9_-]*`. CSS property names also allow custom properties.
A hyphen within a name is part of the identifier, so write binary subtraction
with spaces on both sides as in `max - min`. Unary minus works in `-1` and
`-value`. Unit-bearing tokens such as `20px` and `100ms` are CSS text. Liva
arithmetic works on unitless numbers.

Expression strings decode `\n`, `\r`, `\t`, `\\`, `\'`, and `\"`.
Other escapes produce diagnostics. CSS strings pass their escapes to the
browser as written. Quote URLs, including inside `url()`, as in
`url("https://example.com/image.png")` or `url("image.png")`.

If an interpolation is missing its closing `}`, recovery stops at an unquoted
newline so later declarations can still be diagnosed. Definitions with errors
do not run. During development, invalid source edits retain the last valid
definition. In production, any compile error fails the build.
