# Vue lifecycle and events

[Language specification](language.md)

Animate elements as Vue inserts, removes, or hides them. Motion events notify
the Vue component when a condition becomes true.

## Enter and leave

Use `enter` and `leave` to animate DOM appearance and removal. Declare at most one
of each directly in a motion. Declare any [named targets](layers.md#targets-and-the-motion-root)
in a layer or state. Root declarations can use `self` even if the layers only style named
targets. Each lifecycle property requires timing independent of layer timing.
Property timing takes precedence over target timing, then the lifecycle default.

```liva
motion panel {
  layer base { content { opacity: 1; scale: 1 } }

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

| Lifecycle | Direct value   | How endpoints are filled                                                                        |
| --------- | -------------- | ----------------------------------------------------------------------------------------------- |
| `enter`   | A `0%` frame   | Uses the ordinary cascade for the destination when `100%` is omitted.                           |
| `leave`   | A `100%` frame | Starts from the displayed presentation, including interrupted animations, when `0%` is omitted. |

Both support explicit keyframe tracks and interpolation. Duplicate properties
are errors. Enter plays any explicit `100%` endpoint before restoring the ordinary
cascade. A layer update during enter retargets from the displayed pose with the
new layer timing.

Leave temporarily takes precedence for its own properties. Other properties
continue to follow active layers. While the motion is connected, lifecycle
expressions follow accepted input updates. Captured or ongoing leave work retains
the source definition's final accepted inputs and ordinary presentation through
disposal or definition replacement. DOM-relative observations needed by leave
continue until the effects end. A changed relative reference can retarget the
animation without a parameter update. Supported endpoint-only springs carry
displayed velocity into leave and re-entry, using the same property and unit rules
as [ordinary springs](animation.md#automatic-spring-momentum).

### Vue presence support

Use `v-liva` and `v-liva-target` with Vue's structural directives to animate
presence without adding a DOM wrapper. The supported operations on native
elements are direct or ancestor `v-if`, complete
`v-if`/`v-else-if`/`v-else` chains, keyed `v-for`, and direct or ancestor
`v-show`. These operations support removing a Motion root and nesting Motion
instances. Multiple instances of a lifecycle target can share one motion. Use
a separate Motion root per item when each item needs its own drag input.

Targets that share a structural operation share a completion boundary. Vue waits
for the applicable leave effects, including replacements, before removing or
hiding the DOM. With `v-show`, the element remains visible during leave, and Vue
applies `display: none` after completion. Showing again cancels the old leave
so it cannot hide the new presentation. Newly captured nested leaves participate
in the parent's completion boundary. Already-running child exits are cancelled
if their own boundary is destroyed.

Presence and target binding are local to the Vue component. Parent-controlled
child-component removal, structural `template` fragments, dynamic Motion or
target directive arguments, unkeyed repetition, and combined structural
directives on one element are unsupported. Split combined directives across
nested native elements. A Vue `Transition` or `TransitionGroup` on the same
operation is a compile error even without props. Define the presence animation
in Liva for that operation.

## Motion events

Use `event name when condition` to notify Vue when a Boolean condition becomes
true. Each instance emits once per false-to-true edge. A condition already true
at initialization does not emit. Emission is independent of state transitions
and animation completion.

```liva
event dismiss when pointer.released
  && pointer.offset.x > 120
```

Vue dispatches a bubbling `CustomEvent` named `liva-dismiss` from the Motion root.
Listen with `@liva-dismiss="removeItem(item.id)"` to update application state
immediately.
