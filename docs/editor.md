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

The editor does not add targets or CSS properties absent from the state declarations.
Clips, delays, looping, curve graphs, automatic key recording, multiselection,
undo/redo history, and a separate preview canvas are outside this implementation.
