# Timeline editor

The development editor docks below the application page. It edits one shared Liva
definition and previews one mounted instance. Vue retains application state; saving
updates inline `<liva>` source through the guarded editor server.

## Layout and timing

The header selects a preview instance. Targets start collapsed; expanding a target
shows resolved property tracks. The inspector edits the selected property's source
values, typed timing, and available keyframes. The page reserves space for the dock
and scrolls selected instances into view; nested scroll containers may need manual
scrolling.

All rows share a millisecond axis. Each frame's time is its percentage multiplied by
its property's duration. Physics spring duration comes from the runtime solver;
failures leave timing controls available for correction. The playhead, zoom, and
panning change the preview without writing source.

Select **New keyframe at playhead** to author an explicit CSS value. Edit its source
value, percentage, or typed easing in the inspector. Offset collisions are rejected.
Hollow endpoints derive from resolved compositions; source fields appear only when
an editable declaration exists. Change typed timing directly, or explicitly replace
it through parameter controls. Duration edits preserve percentages. Timeline keys
and duration bars do not support source-changing drag gestures.

## Layer composition previews

Layer motions open with FROM set to the selected instance's current composition
and TO as an independent copy. Each side lists every layer. Checkboxes control
ordinary layers, including unconditional layers; stateful layers always select one
state. Disabled layers are dimmed, and differing selections are marked on both
sides. Swap exchanges the entire selections. These controls never edit guards.

The existing-transition shortcut changes only that layer's endpoint states.
Transition labels show the layer and state pair. Manual changes or Swap clear an
incompatible shortcut; no transition is inferred from a
state pair. Identical compositions are supported, including intermediate motion.

The timeline includes every resolved TO property, grouped by target, even when
its value is unchanged or it has no timing. It displays the effective owner's
frames and independently cascaded timing. Select a property to inspect endpoints;
Play, the playhead, and zoom use the existing timeline controls.
The inspector shows the layer and, when applicable, state or transition of the selected
value. Selecting an endpoint shows that endpoint's source value; selecting an explicit
keyframe shows its editing controls. Only the selected declaration is editable in the
value form. Timing controls identify the layer, state or transition where edits are written.
External CSS has no source field. Editing a shared declaration affects every composition
using that declaration.

Value edits preserve source expressions until explicitly replaced. Timing edits write
`@expression` on the selected transition property, or on the ordinary/style property
when no effective transition is selected. Removing a local override reveals its
inherited default. **Instant** is available as a timing choice and has no duration or easing fields.
It applies the resolved destination immediately in playback and scrubbing, including
tracks with intermediate authored frames. Removing its override reveals inherited
timing. Zero-duration tweens are displayed as Instant because they have identical
execution semantics. Timing parameters are shown directly; Apply timing replaces the
expression with those parameters. Unrelated edits retain existing expressions.

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

## Enter and leave editing

Choose **Enter** or **Leave** in **Existing transition**.
A single **Baseline** composition selects the settled layer presentation used for
lifecycle endpoints. The baseline is independent of application state and does not
create state-specific lifecycle declarations. Lifecycle-only properties and targets
from inactive layers remain visible in the timeline. Explicit endpoints edit lifecycle
keyframes. Implicit endpoints show and edit the contributing layer or state declaration
from the baseline; captured CSS has no editable source declaration.
Typed timing and keyframe edits use motion-level paths. A local timing override can
create a missing lifecycle block for a property already declared in a layer.

Play and scrub operate on the mounted preview instance without inserting, hiding,
or removing application elements. Templates use that instance's current parameters
and bindings. Leave starts from the selected baseline's settled presentation; it does
not simulate removal during an interrupted application animation. Unlike live
presence playback, a manual preview freezes its expression and baseline observations
for repeatable seeking. It shares the runtime cascade, final track planner and
native effect preparation, while its own teardown restores application presentation.
The final leave
pose remains visible until preview ends. End preview, closing the dock, application
updates, and source invalidation restore the committed definition and application
state. Missing targets are not mounted by the editor.

## Playback and lifecycle

The playhead seeks the actual DOM using paused WAAPI effects. **Play** advances
from the current position, or restarts at zero when already at the end. **Pause**
holds the pose. Shorter tracks settle to their destination while longer tracks
continue. Playback ends at the longest displayed track unless **Loop** is enabled.
**Speed** offers 0.1×, 0.25×, 0.5×, and 1× (the default). Timeline positions and
readouts remain animation milliseconds: 600 ms at 0.5× takes 1.2 seconds of real
time. Changing speed preserves the current position.

**Loop** defaults to off and repeats the full timeline at the selected speed,
carrying frame overshoot into the next pass. Each boundary snaps directly to the
starting pose without a return animation or pause. Lifecycle previews seek the
same effects without changing element presence or invoking completion callbacks.
Turning Loop off lets the current pass finish; toggling it while paused does not
start playback. Scrubbing and **To start** pause playback. Speed and Loop are
session preferences retained across replay and selection changes, reset on page
reload, and never saved into animation source. Zero-duration previews do not repeat. Enabling reduced motion
settles automatic playback immediately; explicit manual scrubbing remains available.

**End preview** restores the committed definition and latest application composition,
retaining the draft. Closing the dock also ends preview. Application state updates,
instance removal, instance selection, and source invalidation stop pending previews
and active playback. Out-of-order server replies cannot restore obsolete effects.

**Discard changes** restores the application and reloads the source revision.
**Save to source** writes the validated draft and waits for HMR to synchronize all
instances of the definition. Source conflicts and failed saves retain the draft.
External source changes require discarding/reloading before further preview or save.

The editor does not add targets or new CSS property names. Lifecycle scopes also
include properties already authored in lifecycle declarations.
Clips, delays, curve graphs, automatic key recording, multiselection,
undo/redo history, and a separate preview canvas are outside this implementation.
