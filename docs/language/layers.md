# Layers and state transitions

[Language specification](README.md)

A motion requires at least one layer. Layer names are unique within a motion.

## Targets and the Motion root

The element carrying `v-liva` is the **Motion root** and is available to
expressions as the target `self`. A CSS declaration or track directly inside a
layer, state, directional transition, `enter`, or `leave` applies to the root.
Use a named target block to style another element.

```liva
layer base {
  opacity: 1
  self { scale: 1 }
  icon { rotate: 0deg }
}
```

Both `opacity` and `scale` style the root. An explicit `self` block can give
its declarations shared timing and needs no `v-liva-target` binding. Use
distinct properties when mixing the two forms. A second `self` block or a
repeated property in the same scope is an error, including a value and a track
for the same property.

Bind a named target with `v-liva-target:name`, such as `v-liva-target:icon`. The
target belongs to the nearest Motion root in the same Vue component. Ordinary
targets bind one element. Lifecycle targets can bind multiple keyed elements
as described under [Vue presence support](vue.md#vue-presence-support). Missing or
duplicate required targets suspend the instance and report a diagnostic.
Read-only measurement targets may be absent. Removal cancels a target's
animations. Rebinding applies the current composition without replaying
previous animations.

## Conditional layers

Use conditional layers for independent visual conditions. An unconditional layer
is always active, while `layer name when condition` is active whenever its Boolean
condition is true. Several layers can be active together.

```liva
motion button(hovered: boolean, pressed: boolean) {
  layer base { scale: 1 }
  layer hover when hovered { scale: 1.05 }
  layer press when pressed { scale: 0.95 }
}
```

## Stateful layers

Use a stateful layer when a visual state must persist until a transition is
eligible. Each stateful layer is always active, has its own state names, and
requires exactly one `initial` state. Styles directly under the layer are common
to every state. The current state's styles replace common styles per property.
Use `when` on transitions to select the next state. Stateful layers and their
states do not accept their own `when` clauses. A transition needs a body only
when it declares property values or tracks.

```liva
motion submission(pending: boolean, completed: boolean) {
  layer feedback {
    opacity: 1

    state idle initial { spinner { opacity: 0 } }
    state loading {
      opacity: 0.5
      spinner { opacity: 1 }
    }
    state success { spinner { opacity: 0 } }

    transition idle -> loading when pending {
      opacity: 0.5 @tween(duration: 150)
    }
    transition loading -> success when completed
  }
}
```

The first transition animates the root opacity to `0.5`. The second needs only
a guard and uses the destination state's styles.

On initialization and on each parameter or reactive input update, the layer
evaluates transitions out of its current state. The last eligible transition in
declaration order wins. A guard that is already true at initialization is eligible.
If nothing matches, the layer keeps its current state. Each layer can advance at
most once per update, and several layers can advance in the same update. A new
input notification is needed to take a further transition. Initial guards resolve
before target binding.

## Layer cascade and guarded updates

Active layers contribute styles in declaration order. Each later layer can replace
the CSS value of a property contributed by an earlier layer. In the button example,
`press` wins when both conditions are true. Values are resolved per target and
property, so unrelated properties remain active. If no active layer supplies a
property, the original CSS applies. Interpolated values are reevaluated on each
input update.

CSS values and [timing](animation.md#layer-animation-selection) cascade independently. A layer
can replace a value while inheriting an earlier layer's timing.

## CSS ownership

Give Liva exclusive control of authored animation properties. A competing Vue
style binding, CSS transition, or external animation on the same property is
unsupported. When Liva releases a property it still owns, it restores the original
inline value and preserves external edits.

Web Animations construction or playback failures report a diagnostic for the
affected track. Later updates can still be processed. With
`prefers-reduced-motion: reduce`, animations settle immediately while direct
control and application state remain responsive.
