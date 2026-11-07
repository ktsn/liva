# Timeline editor

The development editor docks to the bottom of the application page. It edits one
shared Liva definition and previews one mounted instance. Vue retains application
state; saving changes the inline `<liva>` source through the guarded editor server.
The language and its property-specific percentage keyframes are unchanged.

## Layout and selection

The header selects the preview instance. The toolbar selects common settings or a
directional transition and its source/destination states. For common settings,
the state pair supplies preview endpoints without applying directional overrides.

Targets start collapsed. Their rows summarize all child keyframes at their actual
times; summary markers are not editable. Expanding a target reveals one timeline
row for each CSS property declared in its states, including unchanged properties.
The right inspector edits the selected property or keyframe. The page reserves
space below its content for the dock and scrolls a newly selected instance into the
remaining viewport when needed. Nested application scroll containers may still
require manual scrolling.

All rows share a millisecond axis. A frame's time is its percentage multiplied by
that property's duration. Equal percentages on differently timed properties have
different screen positions. Physics spring duration comes from the runtime solver;
solver failures appear on the affected track and leave its controls editable.

## Keyframes and timing

- Double-click a property lane or use **New keyframe at playhead**, then enter a
  CSS value and select **Add keyframe**. Adding at an existing frame selects it.
- Select a key to edit its raw CSS value, percentage, time, and outgoing interval
  easing. Empty easing inherits the track default. CSS interpolation remains the
  browser's responsibility; the editor does not infer a value for new keys.
- Drag explicit keys horizontally. Positions snap within seven screen pixels of
  ruler ticks or other keys' actual times. Hold Alt to bypass snapping. Percentages
  are rounded to four decimal places (normalized offsets to six decimal places).
  Moving onto another explicit key is rejected without overwriting either value.
- Drag a duration handle or enter the duration in the property inspector. All
  percentages remain unchanged, so the keys move proportionally in real time.
  A zero-duration tween settles immediately and has no intermediate-key insertion.
- Duration springs support a duration and bounce. Physics springs expose stiffness,
  damping, and mass; their calculated duration cannot be dragged. Springs accept
  endpoints only, without frame easing. Remove incompatible frames/easing before
  switching timing mode.

Hollow diamonds are state-derived endpoints. Selecting one allows editing the
state value (which affects other transitions) or creating an explicit endpoint
override. State endpoints cannot be dragged. Explicit endpoints retain the language
semantics: at completion, the destination state takes effect even if the explicit
last key differs. Such a difference can snap.

## Inheritance and source writes

Inherited frames use a distinct border and an inspector label. Editing one in a
directional transition copies that property's entire effective explicit collection
into the direction. Timing is copied only when timing is edited. **Use common
keyframes** and **Use common timing** remove those overrides independently.

The language has no empty collection override. Deleting the last directional key
therefore leaves explicit endpoints to suppress inherited intermediate keys. Use
**Use common keyframes** to restore inheritance instead. An empty common collection
has no explicit frames and derives its endpoints from states.

Track updates replace only the edited property block, creating missing containers
as needed. A property block containing comments requires direct source editing;
the editor rejects replacement rather than losing comment placement. Untouched
source, including other component blocks, remains unchanged. State-value edits
use the existing individual field operation. All candidate edits are validated on
the server before preview or persistence.

## Playback and lifecycle

The playhead seeks the actual DOM using paused WAAPI effects. **Play** advances
from the current position, or restarts at zero when already at the end. **Pause**
holds the pose. Shorter tracks settle to their destination while longer tracks
continue. Playback ends at the longest displayed track. Enabling reduced motion
settles automatic playback immediately; explicit manual scrubbing remains available.

**End preview** restores the committed definition and latest Vue-requested state,
retaining the draft. Closing the dock also ends preview. Application state updates,
instance removal, instance selection, and source invalidation stop pending previews
and active playback. Out-of-order server replies cannot restore obsolete effects.

**Discard changes** restores the application and reloads the source revision.
**Save to source** writes the validated draft and waits for HMR to synchronize all
instances of the definition. Source conflicts and failed saves retain the draft.
External source changes require discarding/reloading before further preview or save.

The editor does not add targets or new CSS property names. Lifecycle scopes also
include properties already authored in lifecycle declarations.
Clips, delays, looping, curve graphs, automatic key recording, multiselection,
undo/redo history, and a separate preview canvas are outside this implementation.

## Reactive definitions

The same instance selector includes draggable cards. Variable updates supersede
manual playback, and condition-selected states remain visible in the inspector.
Timing edits serialize `@tween` / `@spring` declarations; keyframes serialize inline
percentages with optional `@` easing. Let bindings and `when` expressions are edited in
source, not through timeline controls. A preview uses the instance's current drag
offset; zero offset means no translation until the card has been dragged. State
endpoint fields show CSS templates as source text; replacing them is an explicit
CSS-value edit, not a visual expression editor.

## Enter and leave editing

Layer motions use the composition preview controls described below. Their lifecycle
source editing is not yet available. Legacy motions using typed decorators remain
read-only in the legacy editor. The server rejects unsupported edits and saves so
legacy track replacement cannot discard typed syntax.

For a legacy motion, choose **Enter · default** or **Leave · default** in **Editing**.
**State** selects the endpoint presentation used by the preview. State-specific
lifecycle blocks are no longer supported. Timing, template values, offsets, and
easing use the usual property inspector; edited shorthand becomes explicit frames.
Missing motion-level lifecycle blocks are created on save. Implicit lifecycle
endpoints describe captured state or DOM presentation and cannot edit state values.

Play and scrub operate on the mounted preview instance without inserting, hiding,
or removing application elements. Templates use that instance's current parameters
and bindings. Leave starts from the selected state's settled presentation; it does
not simulate removal during an interrupted application animation. The final leave
pose remains visible until preview ends. End preview, closing the dock, application
updates, and source invalidation restore the committed definition and application
state. Missing targets are not mounted by the editor.

## Layer composition previews

Layer motions open with FROM set to the selected instance's current composition
and TO as an independent copy. Each side lists every layer. Checkboxes control
ordinary layers, including unconditional layers; stateful layers always select one
state. Disabled layers are dimmed, and differing selections are marked on both
sides. Swap exchanges the entire selections. These controls never edit guards.

The existing-transition shortcut changes only that layer's endpoint states.
Declaration numbers distinguish transitions with the same state pair. Manual
changes or Swap clear an incompatible shortcut; no transition is inferred from a
state pair. Identical compositions are supported, including intermediate motion.

The timeline includes every resolved TO property, grouped by target, even when
its value is unchanged or it has no timing. It displays the effective owner's
frames and independently cascaded timing. Select a property to inspect endpoints;
Play, the playhead, zoom, and snapping use the existing timeline controls.
The inspector shows the layer and, when applicable, state or transition of the selected
value. Selecting an endpoint shows that endpoint's source value; selecting an explicit
keyframe shows its editing controls. Only the selected declaration is editable in the
value form. Timing controls identify their source and write destination separately.
External CSS has no source field. Editing a shared declaration affects every composition
using that declaration; the inspector marks this before editing.

Value edits preserve source expressions until explicitly replaced. Timing edits write
`@expression` on the selected transition property, or on the ordinary/style property
when no effective transition is selected. Removing a local override reveals its
inherited default. Timing parameters are shown directly; Apply timing replaces the
expression with those parameters. Edit timing expression exposes the original expression
for references and other source edits. Unrelated edits retain existing expressions.

Keyframe editing uses the explicitly selected existing transition in the final value
owner, or an ordinary layer style track. It never chooses a state style track or creates
a transition implicitly. Converting an ordinary value to a track retains its value as
the required 100% destination. Offset collisions and invalid destination removal are
rejected by the compiler. Frame easing uses typed expressions; spring tracks do not
expose editable per-frame easing.

Edits compile into an isolated candidate for the selected instance. Save checks the
source hash, writes a backup, and lets HMR update application instances. Source ranges
are UTF-8 byte offsets relative to the embedded Liva block and belong to the inspected
hash; a fresh compilation supplies ranges after each edit. Closing or ending a preview restores the
application composition without changing its state-machine history.
