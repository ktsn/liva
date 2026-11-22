# Reactive inputs and property controllers

[Language specification](README.md)

Observe browser interactions or elapsed time in a motion. Use property controllers
to turn input changes into movement and release events to choose a destination.

## Reactive inputs

### Drag input

`drag(target: self)` tracks the primary pointer when its main button is pressed.
Pass a target variable such as `self` or `thumb`. The target argument has target
type, so a string containing the name is invalid. Set
`touch-action: none` on draggable elements in your application CSS.

| Member                    | Value                                                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `active`                  | Boolean indicating an active drag.                                                                                              |
| `offset.x` and `offset.y` | Pixel displacement from the current pointer-down. It resets on the next pointer-down and retains the last offset after release. |
| `released`                | Boolean that becomes true after a successful pointer-up publishes its final offset. It stays true until the next pointer-down.  |
| `release`                 | Event emitted once for each successful pointer-up. See [release event transitions](#release-event-transitions).                 |

Cancellation and lost capture end the gesture with `released: false` and emit no
release event. Target replacement and disposal remove the listeners and release
pointer capture.

### Browser interaction input

`interaction(target: self)` exposes the target's browser-managed interaction
state. Each Boolean reports whether the element matches the corresponding
pseudo-class.

| Member         | Browser pseudo-class |
| -------------- | -------------------- |
| `hover`        | `:hover`             |
| `active`       | `:active`            |
| `focus`        | `:focus`             |
| `focusVisible` | `:focus-visible`     |
| `focusWithin`  | `:focus-within`      |

```liva
motion button(disabled: boolean) {
  let ui = interaction(target: self)

  layer base { scale: 1 }
  layer hover when ui.hover && !disabled { scale: 1.05 }
  layer press when ui.active && !disabled { scale: 0.95 }
  layer focus when ui.focusVisible { outline-width: 2px }
}
```

Pass application state such as `checked`, `selected`, or `disabled` as parameters.
Guard disabled hover and press styles explicitly because a disabled element may
still match `:hover`. Keyboard, touch, and pen activation follow the browser's
native CSS behavior. `active` therefore reflects `:active` even when a device's
pressed state differs.

Liva reads the initial snapshot when the target binds, before initial styles settle.
Pointer, mouse, focus, keyboard, click, capture, visibility, and window focus
events trigger an immediate check and one coalesced check on the next animation
frame to observe browser default actions. Only changed snapshots notify. A style
change or scrolling under a stationary pointer can change a match without a
trigger. The value catches up on the next observed event. Each instance has its
own subscription. Replacement and disposal clean up listeners and pending
checks. `interaction` and `drag` can observe the same target.

### Motion-local feedback timers

`timeout(when: boolean, duration: number)` returns a reactive Boolean, initially
false. A true condition starts a timer, and expiration publishes true. Duration
is finite nonnegative milliseconds, with zero still scheduled asynchronously.

```liva
let expired = timeout(when: status == "success" || status == "error", duration: 1500)
```

Use the result in a guarded transition to return feedback to idle. A false
condition cancels pending work and resets the result. Unchanged arguments leave
the timer alone, so changing from success to error in the example keeps the
original schedule. Changing the duration while the condition is true starts a new
timer from that update, including after expiration. Unbinding, replacement,
disposal, and hot reload cancel obsolete timers. Vue owns the request, its
outcome, and prevention of duplicate submissions.

## Property controllers and release events

Use `link` with `:=` to control a CSS property with changes in an input.
Here, dragging the root horizontally changes its width from the width it had
when the drag started.

```liva
motion resize {
  let pointer = drag(target: self)

  layer base { width: 160px }

  layer resizing when pointer.active {
    width := link(input: pointer.offset.x)
  }
}
```

This form takes one number and returns a scalar controller. Use it with
`width`, `height`, `inline-size`, `block-size`, physical and logical inset
longhands, or scalar `rotate`.

Map a number to one axis of `translate` by passing `component: "x"` or
`component: "y"`.

```liva
translate := link(input: pointer.offset.x, component: "x")
```

To control both axes of `translate`, pass a record with numeric `x` and `y`
fields, such as the drag offset.

```liva
translate := link(input: pointer.offset)
```

An input delta of one moves the property by one CSS pixel or degree before
applying `sensitivity`, which defaults to `1` and can be negative. Translate
uses CSS pixels and preserves captured Z and any unmapped axis. Convert
viewport input explicitly if the property needs deltas in local coordinates.

A component expression must have a type whose possible values are all `"x"` or
`"y"`. For example, `link(input: distance, component: axis)` accepts a parameter
declared as `axis: "x" | "y"`. Either value can initialize a controller. Changing
it during that controller's lifetime causes a runtime diagnostic and retains
the last valid state.

Every controller, including a controller created in `let`, must attach to exactly
one target/property pair. Repeating the attachment in different layers or states
is valid at that same pair. Aliases refer to the original controller. Separate
inline calls create separate controllers. Unattached controllers, attachment to
multiple addresses, and input feedback cycles are compile errors. The compiler
checks that `:=` receives a controller. Use the property and input combinations
above to get a working runtime binding.

### Controller position and velocity

If you grab a card while it is animating at `translate: 40px 0`, dragging
12 px farther to the right moves it to `52px 0` at the default sensitivity.
The drag starts from the position you see on screen.

When a controller takes over, it captures the displayed property value `P0` and
current input `I0`. It then applies `P0 + (input - I0) * sensitivity` immediately.
Acquiring control or changing sensitivity establishes a new baseline from the
displayed value. Ordinary input updates preserve the baseline. When control ends,
the destination comes from the current ordinary layers. To keep a resized value,
commit it in application state.

| Member     | Meaning                                                                                                                                               |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `value`    | Displayed property value, or the proposed control position during input evaluation.                                                                   |
| `velocity` | Rate of committed input changes after sensitivity and axis mapping, in CSS pixels or degrees per millisecond. Unmapped axes have zero input velocity. |
| `attached` | Whether the controlled property is available on a rendered target.                                                                                    |

The scalar controller's position and velocity are numbers. The translate
controller exposes `x`, `y`, and `z` for each. Updates and explicit snapshot reads
refresh these values without animation-frame polling. The velocity reflects input
and can differ from displayed motion when CSS constrains the property or when
another effect animates it. Acquisition and sensitivity changes reset input
history. Expired movement reads as zero even if the input value has stayed the same.

If the target is absent, detached, or unrendered, `value` falls back to the mapped
input and `attached` is false. Target availability alone does not publish a
snapshot, and input velocity continues to update independently. If a visible
property cannot be decoded, binding or control reports a deduplicated diagnostic
and preserves ordinary presentation until recovery. Invalid or non-finite input
retains the last committed state.

### Release event transitions

Use `on pointer.release { ... }` in a [stateful layer](layers.md#stateful-layers)
to choose a transition on each successful pointer-up. A guard reads the final
position and input velocity, which lets you choose a destination using both how
far and how fast the element was dragged.

```liva
motion swipe {
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
}
```

Here, the projection looks 200 ms ahead and uses 48 px as the decision threshold.
Those two values are part of the example's snap behavior.

An `on` block accepts an event expression, including an alias, and contains only
transitions for its layer. Each transition can have an optional guard. Boolean
expressions belong in guards. Nested event blocks and arbitrary callbacks are
unsupported.

Each occurrence supplies one snapshot to all layers. Event and ordinary
transitions share the same source order, and the last eligible transition from
each layer's starting state wins. Occurrences are processed in order without
coalescing. Unmatched events are discarded. Mount, reconnection, target
replacement, hot reload, and disposal never replay past releases.

The pointer-up input is applied to the previously active controller before any
release guard runs. All guards see that terminal control position and input
velocity. After transition selection, the released property can carry that
velocity into an [endpoint-only spring](animation.md#automatic-spring-momentum).
