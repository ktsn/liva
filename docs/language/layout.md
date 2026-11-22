# Layout measurement and animation

[Language specification](README.md)

Read element geometry with `measure()` and animate Vue-driven layout changes
with `$layout`.

## Reactive layout bounds

Use `measure(target: label, relativeTo: self)` to read the layout of a target
relative to itself or an ancestor. `relativeTo` defaults to the Motion root.
The result is a reactive record in fractional physical CSS pixels.

| Member               | Meaning                                                                 |
| -------------------- | ----------------------------------------------------------------------- |
| `x` and `y`          | Position from the reference padding-box origin, just inside its border. |
| `width` and `height` | Target border-box dimensions.                                           |
| `attached`           | Whether the target and reference provide supported layout geometry.     |

X increases rightward and Y downward, including in RTL. Measuring a target
relative to itself gives `x = y = 0`.

Use an empty target block to declare a read-only measurement target. It may be
absent without suspending the motion.

```liva
motion underline {
  let bounds = measure(target: label)

  layer base {
    label {}
    indicator {
      translate: ${bounds.x}px ${bounds.y}px
      width: ${bounds.width}px
    }
  }
}
```

Place the indicator in a compatible containing block. To use the measured width
directly, give the indicator `box-sizing: border-box` or convert the width
in application code. For expansion animations, measure naturally sized inner
content and animate its surrounding shell. A feedback loop can occur if you
measure an element's width and set its width to the measured value plus 10 px.

### Supported geometry

Measurements remove the effects of scrolling and supported 2D transforms,
including transforms on ancestors. The supported layout is ordinary single-box
HTML. Missing, disconnected, `display: none`, and unsupported boxes return zero
for all dimensions and positions and `attached: false`. `visibility: hidden`
and genuine zero-size boxes are measurable.

Fragmented inline boxes, SVG, sticky or fixed positioning, CSS zoom, perspective,
3D transforms, and unresolved transforms are unsupported. Percentage
`translate` uses content dimensions for HTML `content-box` and `fill-box`
and border dimensions for `border-box` and `view-box`. Returned dimensions are
always border-box dimensions. HTML `stroke-box` transforms are unsupported
because browsers disagree on their percentage reference sizes. Content- or
fill-box rotation, scale, and skew are unsupported when content and border boxes
differ because browser-computed styles can lose the percentage origin needed to
recover the pivot. These cases report a diagnostic and return `attached: false`.
Translation alone works in content and fill boxes. Retained `calc()`
expressions that cannot be decoded are unsupported. Very small invertible
scales can amplify browser rounding even when the returned values are fractional.

### Measurement updates

The first measurement is synchronous at binding and is available before the
initial presentation settles. Later invalidations coalesce into one animation-frame
pass. Liva completes all reads before publishing changed snapshots. Writes
triggered by publication can schedule a read for a later frame.

Document structure, text, attribute changes, target and reference size changes,
window resizes, and load or font completion can trigger new reads. Liva-managed
CSS animations that change layout update measurements while they run. Scrolling
or transforms alone leave layout coordinates unchanged. Automatic `$layout`
transform output does not start a read on every frame.

Third-party animations, direct CSSOM edits, and arbitrary script writes may leave
the measurement stale until a supported invalidation. Writes after a read can
therefore briefly leave JavaScript and the rendered box out of sync. Continuous
polling is unavailable.

## Layout configuration

Use `$layout` to animate changes to an element's layout position or visual size
while Vue manages the elements and applies the destination layout. A layout
declaration opts the root or a named target into automatic correction. Liva
writes a temporary `transform` for translation and scaling, so text uses the
destination line breaks throughout the animation.

```liva
motion item(dragging: boolean) {
  layer base {
    $layout: position size @spring(stiffness: 300, damping: 25)
    content { $layout: y height }
  }

  layer dragging when dragging {
    self { $layout: none }
  }
}
```

| Selection                                   | Effect                                                                                  |
| ------------------------------------------- | --------------------------------------------------------------------------------------- |
| `position` or individual `x`, `y` axes      | Translate along the selected physical axes, with X increasing rightward and Y downward. |
| `size` or individual `width`, `height` axes | Scale along the selected physical axes. Vue and CSS supply the width and height.        |
| `none`                                      | Disable all automatic correction. It must appear alone.                                 |

Combine axes in any order, with each axis selected once. Empty values, unknown
keywords, and overlapping aliases such as `position x` are errors. An absent
effective selection also disables correction. A later active layer or selected
state replaces all the axes, so overriding `position size` with `position` drops
size correction. Use layers and states to change selection. Interpolation,
controller attachment, and selection keyframes are errors.

A named target with its own `$layout` declaration receives its own correction and
compensation for participating ancestor scales. Descendants that do not participate
scale with their parent.

### Layout timing and transform ownership

Timing cascades independently of the axis selection and follows the
[ordinary timing precedence](animation.md#layer-animation-selection).
Missing timing settles immediately.
A directional transition can override timing with an empty layout track.

```liva
motion panel(expanded: boolean) {
  layer phase {
    $layout: position @spring(duration: 350)
    state closed initial {}
    state open {}

    transition closed -> open when expanded {
      @instant
      $layout ~> {}
    }
  }
}
```

Only a transition from the layer that owns the effective selection can supply
this override. It applies to the update that selects the transition. A later
geometry change resolves current declaration timing again without advancing the
state machine. `enter` and `leave` cannot use `$layout` declarations or tracks.

An effective Liva `transform` declaration, including `transform: none`, disables
automatic projection and child compensation on that target. While projection
owns a target, it overrides its ordinary CSS transform. For example, a stylesheet
rotation can disappear during the layout animation and return when it finishes.
Release reveals the current CSS, including edits made during playback. A CSS
transition on a temporarily corrected property can be interrupted. Unrelated CSS
and unprojected ancestors keep their ordinary ownership.

Changing a hidden target transform alone does not restart its layout motion.
Changes to the natural containing block of absolute descendants still count as
layout changes. CSS `width`, `height`, `translate`, and `scale` do not disable
projection and have no added continuity guarantee when combined with it.

### Vue-owned layout changes

Use keyed per-item Motion roots for reordering. Liva captures geometry before
Vue mutates the DOM and applies correction before paint. Other targets in the
same Vue application can move even when their own components do not render.
Applications have separate capture boundaries. Async and Suspense resolution,
Teleport moves, and KeepAlive activation follow these update boundaries.
On completion of a presence leave, Liva captures again before Vue removes or
hides the element so its neighbors animate when the space is released.

Only Vue mutation transactions start automatic layout motion. Window resizes,
image or font completion, and external DOM or CSS changes can refresh geometry.
An external change that alters layout ends an active correction immediately.
Scrolling alone does not start a transition.

Enabling layout while changing geometry in the same update uses a fresh
pre-update shape. Initial mount, replacement, missing geometry, and undefined
size ratios settle immediately. Interruption carries the displayed physical
origin, border edges, and velocity into the new destination using current timing.
Disabling layout or dropping an axis releases its correction. Reduced motion
settles immediately.

Projection uses the [measurement geometry contract](#supported-geometry),
including its single-box HTML scope, 2D transforms, and scroll-neutral coordinates.
Singular or unsupported geometry settles. Browser rounding can affect the
recovered positions and sizes. `measure()` keeps reporting the untransformed
destination even if the generated transform temporarily changes an absolute
child's containing block. Liva may temporarily fix a participating absolute
child's used logical padding and min/max sizes to preserve its destination text
layout. These adjustments honor writing mode and box sizing and are released
with the transform.

See the runnable [layout example](../../playground/src/pages/layout-animation.vue).

### Corner and shadow correction

Liva corrects corner radii and box shadows against current, uncorrected CSS
values, including values animated by Liva. Participating children use their
cumulative generated distortion. Radius percentages use the destination border
box. Source CSS edits refresh the correction, while already-running Liva effects
keep their timing. Third-party effects update at the usual observation points.

Corner correction preserves the ellipse's local radii under axis scaling before
the browser's overlap reduction. Shear can still distort corners. Shadow offsets
are transformed back through the full generated linear transform. Blur and spread
are divided by the geometric mean of the axis scales, so unequal scaling and
shear can leave residual distortion. If Liva cannot decode or represent a radius
or shadow value, the affected visual keeps its underlying CSS while other
corrections continue. Later CSS values can restore the correction.
