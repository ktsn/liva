# Liva vision

Status: vision, MVP language decisions, and architecture confirmed. Implementation
follows the incremental MVP plan, with experiments validating the selected design.

## Purpose

Liva describes UI states and the animation between them. Developers should be able
to coordinate multiple DOM elements and CSS properties in readable source, then
adjust those animations while interacting with their real application.

Vue and TypeScript retain component structure, application state, event handling,
and business logic. Liva supplies named animation states, transition timing, and
property keyframes. It complements a frontend framework rather than replacing one.

## Confirmed decisions

- Use CSS-inspired blocks and standard CSS property names, with opaque CSS values.
- Animate properties whose values differ between states; support tween, duration
  spring, physics spring, and property keyframes.
- Merge general and directional transitions by property. Timing values and
  keyframe collections are atomic overrides.
- Use a Rust language core and TypeScript runtime, with a lossless CST and separate
  Definition IR and resolved runtime tracks.
- Accept arbitrary CSS properties and values without Liva CSS validation; browser
  no-ops and unsupported animation are acceptable from the MVP onward.
- Delegate CSS value interpolation to WAAPI. Interruptions start from the displayed
  value; preserving spring velocity is outside the MVP.
- Use Vite+ for JS/TS development tooling, with pnpm and Cargo workspaces.
- Integrate first through Vue SFC `<liva>` blocks and Vite. Definitions can be reused
  by independent runtime instances.
- Edit inside the normal application page. Preview on one instance, then persist
  confirmed changes with targeted source edits that preserve unrelated text.
- Ship no editor bridge or source writer in production.

## Editing model

| Concept               | Meaning                                                      |
| --------------------- | ------------------------------------------------------------ |
| Execution environment | The normal application served by its Vite development server |
| Editing scope         | One named Liva definition in a component source file         |
| Preview target        | One mounted runtime instance of that definition              |

Dragging a timing control previews an in-memory override on the selected instance.
Saving changes the shared source definition; after successful compilation and HMR,
all instances use the new definition. Canceling a preview does not modify source.
The editor does not take ownership of Vue application state.

## First demonstration

A real Vue page hosts at least two toggle switches using the same definition.
Each switch has `off` and `on` states, a track color, thumb translation, and thumb
scale. The page demonstrates directional overrides, both spring configurations,
tween keyframes, and rapid reversals. The editor selects one switch, previews a
change without affecting its sibling, and saves it back into the SFC.

Success means predictable behavior, readable source, useful diagnostics, and
format-preserving edits. It does not mean supporting arbitrary CSS animation or
building a comprehensive animation authoring application in the first release.

## State values beyond the MVP

The MVP requires every state to declare all animated target/property values.
This is a temporary scope constraint. The future language will allow omitted
properties to obtain their values from the actual DOM at runtime, independently
for each instance. Sampling and restoration semantics will be designed before
implementation; DOM fallback is not part of MVP acceptance.

## Boundaries

Standalone `.liv` imports, other framework adapters, reusable timelines,
user-defined functions, complex gestures, a full formatter/linter, and an LSP are
future possibilities, not MVP dependencies. There is no isolated component preview
system and no custom CSS value interpolation engine.

## Review map

- [Language](language.md): confirmed syntax, semantics, defaults, and examples.
- [Architecture](architecture.md): dependency boundaries, contracts, integration,
  editing protocol, and confirmed workspace plan.
- [MVP plan](mvp.md): milestones, experiments, tests, and acceptance criteria.

Language decisions L1–L10 and architecture decisions A1–A7 are confirmed. Complete
each milestone’s validation before building dependent capabilities. Details not yet
specified, such as spring calibration, are resolved through the planned experiments.
