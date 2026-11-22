# Animation timing and keyframes

[Language specification](README.md)

Timing values set how properties animate. Keyframes supply values along the way.
Springs can carry velocity from an interrupted animation or drag.

## Timing and easing values

A timing value describes how an animation moves between its endpoints. Apply it
with a decorator or bind it with `let` for reuse. Timing and easing values
cannot be interpolated into CSS or used as Boolean guards. Write numeric
arguments without CSS units.

### `tween`

Use `tween(duration: 180, easing: easeOut)` to animate over a fixed duration.
`duration` is a finite, nonnegative number in milliseconds. It defaults to
`300`. A duration of `0` settles immediately.

`easing` controls how progress changes over the duration, or over each
[keyframe interval](#inline-keyframes). It defaults to `ease`. Built-in
easing values include `linear`, `ease`, `easeIn`, `easeOut`, `easeInOut`,
`stepStart`, and `stepEnd`. Use `steps` or `cubicBezier` to specify a curve.

#### `steps`

`steps(count: 4, position: "end")` divides progress into discrete jumps.
`count` is a required positive integer. `position` defaults to `"end"` and
accepts `"start"`, `"end"`, `"jump-start"`, `"jump-end"`, `"jump-none"`, and
`"jump-both"`. `"jump-none"` requires at least two steps.

Pass a string literal or a value whose type is limited to the supported
positions, such as a parameter declared as `"start" | "end"`.

#### `cubicBezier`

`cubicBezier(x1: 0.2, y1: 0, x2: 0.4, y2: 1)` defines an easing curve
through two control points. All four coordinates are required and finite.
The X coordinates must be in `[0, 1]`. The Y coordinates may overshoot.

### `spring`

Use a spring for motion that accelerates toward its destination and can
overshoot. Choose either the physics parameters or the duration parameters.

- `spring(stiffness: 300, damping: 20, mass: 1)` specifies the physics
  parameters. Each must be positive and finite. The defaults are `100` for
  `stiffness`, `10` for `damping`, and `1` for `mass`.
- `spring(duration: 350, bounce: 0.2)` specifies a settling target and
  bounce. `duration` is required and must be positive and finite, in
  milliseconds. `bounce` is finite and in `[0, 1)`, and defaults to `0`.

### `instant`

Use `instant` to apply the destination immediately, even when timing would
otherwise be inherited. It cancels current animation and skips intermediate
frames for the affected property. When the override stops contributing, the
usual timing cascade applies again.

```liva
opacity: 0 @instant
```

## Typed animation decorators

Use `@expression` to attach timing or easing to a declaration.

Put a timing decorator before a block to give its properties a shared timing.
A layer can use it as shown below. States, directional transitions, lifecycle
blocks, target blocks, and whole keyframe tracks also accept a timing prefix.

```liva
@tween(duration: 180)
layer base { opacity: 1; scale: 1 }
```

Put timing after a property value to apply it to that property. A `$layout`
selection uses the same placement.

```liva
opacity: 1 @tween(duration: 180)
```

Put easing after an individual keyframe to change progress through the next
interval. Here `easeOut` applies from `50%` to `100%`.

```liva
opacity ~> {
  50%: 0.7 @easeOut
  100%: 1
}
```

## Inline keyframes

Use `~>` to supply intermediate CSS values for a property. Frame offsets must be
unique finite percentages from `0%` to `100%` and play in offset order. Frame
values support the same CSS templates as ordinary values.

```liva
@tween(duration: 350, easing: easeInOut)
scale ~> {
  40%: 1.3 1 @easeIn
  70%: 0.95 1 @cubicBezier(x1: 0.2, y1: 0.8, x2: 0.2, y2: 1)
  100%: 1
}
```

A track in a layer or state requires an explicit `100%` destination. For a
directional transition a missing `0%` frame uses the displayed value, and a
missing `100%` frame uses the final cascaded value. Lifecycle tracks use the
[enter and leave endpoint rules](vue.md#enter-and-leave).

Tween easing applies to each interval by default, with linear easing for the
overall Web Animations effect. The easing on a frame such as `40%` overrides
the interval from that frame to the next, including an implicit endpoint.
Easing on `100%` produces a warning because there is no outgoing
interval. Spring timing applies its solver curve to the whole track, including
intermediate waypoints. It has no per-frame easing controls. Only a top-level
`@` starts an easing decorator. Inside quotes or CSS groups it remains CSS text.

## Layer animation selection

Each target/property gets its resolved value and timing from the active layers.
Within a layer, Liva looks for timing in this order, from highest to lowest
precedence. See [layer cascade](layers.md#layer-cascade-and-guarded-updates).

| Contribution                                                               | Timing precedence within the contribution |
| -------------------------------------------------------------------------- | ----------------------------------------- |
| Selected directional transition of the layer supplying the final CSS value | Property, target, then transition default |
| Destination state                                                          | Property, target, then state default      |
| Common layer styles                                                        | Property, target, then layer default      |

State defaults also apply to properties inherited from the common styles. Missing
timing can inherit from a lower layer. A property with no effective timing applies
immediately. Transition defaults can animate properties without individual tracks.
Only the layer supplying the winning CSS value can add temporary transition timing
or keyframes for that property. Tracks from obscured transitions neither animate
nor report endpoint warnings.

A direct CSS value in a directional transition supplies a `100%` frame. If an
explicit `100%` differs from the cascaded destination, Liva reports
`runtime.endpoint` and restores the cascaded value when the animation finishes.
Only the selected transition evaluates its timing and frame expressions.

A changed property retargets from its displayed value. Explicit intermediate
frames restart their full timeline and can animate even when the endpoints agree.
Unchanged animations continue running.

## Automatic spring momentum

### Interrupting an animation

When a spring takes over a property, it can start with the velocity the property
had on screen. For example, if a panel is sliding right in a tween when a spring
retargets it to the left, the panel can continue briefly to the right before
turning back. The new spring starts at the displayed position and carries the
previous animation's momentum.

This applies to springs with only start and end frames. They can inherit
velocity from direct updates, tweens, or other springs, even when a different
layer takes ownership. When a track has intermediate keyframes, the spring
follows those frames without inherited velocity.

### Releasing a drag

Use [drag input](interaction.md#drag-input) and a [property controller](interaction.md#property-controllers-and-release-events)
to pass the release velocity to a spring.

```liva
motion snapBack {
  let pointer = drag(target: self)

  layer resting { translate: 0 0 @spring(duration: 350) }

  layer dragging when pointer.active {
    translate := link(input: pointer.offset)
  }
}
```

On release, the spring returns the element to its resting position using the
controller's most recent drag velocity. If you release while dragging right,
the element can travel a little farther right before springing back.

### Supported properties and units

Momentum is tracked per component for `translate`, `scale`, scalar `rotate`,
`opacity`, numeric dimensions, and physical or logical insets. Inset shorthands
resolve to independently owned physical longhands.

Lengths resolve to CSS pixels, scale and opacity to unitless numbers, and
scalar rotation to degrees. Rotation uses the numeric destination without
shortest-arc wrapping. The browser resolves compatible units, numeric `calc()`,
and percentages for these properties. Translate percentages use the untransformed
border box. Other length percentages use their CSS containing block.

If a relative destination changes with reference sizes, variables, fonts, or
viewport size, the spring retargets from the displayed pose. Active direct
control keeps its captured pixel baseline. Auto, discrete, unreadable, and
3D rotation values use ordinary browser animation.

### Velocity samples and settling

Direct updates use recent displayed samples. Controller release uses recent
input velocity after sensitivity and axis mapping. Both expire after 80 ms
without movement. A nonzero incoming velocity can animate equal endpoints.
Opacity clamps to `[0, 1]` when rendered, while internal spring velocity
continues. Mount, target replacement, and disposal reset motion history.

Both spring forms preserve incoming velocity. A duration spring treats duration
as a settling target while preserving the requested bounce. Physics springs
must settle within 10 seconds. Exceeding that limit or the sampling limit
of 8192 samples reports an error.
