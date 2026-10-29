# Language specification

Status: implemented MVP language specification. Runtime spring calibration is
specified in the [architecture](architecture.md), with measured behavior in the
[validation record](validation.md). Implicit DOM fallback remains outside the MVP.

## Structure and examples

**Confirmed:** a named animation contains states and transitions. State blocks map
named targets to standard CSS property names and raw CSS values. Target names are
logical bindings, not selectors. Unnamed transitions apply to all state changes;
`transition off -> on` applies only in that direction.

```liva
toggle {
  state off {
    track {
      background-color: #888
    }

    thumb {
      translate: 0 0
      scale: 1
    }
  }

  state on {
    track {
      background-color: #34b27b
    }

    thumb {
      translate: 24px 0
      scale: 1
    }
  }

  transition {
    timing: tween(
      duration: 350ms,
      easing: ease-out
    )

    track {
      background-color {
        timing: tween(
          duration: 200ms,
          easing: ease-in-out
        )
      }
    }

    thumb {
      translate {
        timing: spring(
          stiffness: 300,
          damping: 20
        )
      }

      scale {
        40% {
          value: 1.3 1
          easing: ease-in
        }

        70% {
          value: 0.95 1
          easing: ease-out
        }
      }
    }
  }

  transition on -> off {
    thumb {
      translate {
        timing: spring(
          duration: 350ms,
          bounce: 0.25
        )
      }
    }
  }
}
```

This example intentionally animates scale through intermediate keyframes even
though both states have `scale: 1`; that scheduling rule is confirmed in L3 below.
Springs and intermediate keyframes occur on different properties.

## State property completeness

**Confirmed MVP constraint:** every state must explicitly declare the same animated
target/property set. Missing state property values are compilation errors in the
MVP; there is no fallback to DOM values for omitted declarations.

**Confirmed future direction:** allow state property values to be omitted and
resolve them from the actual target DOM element at runtime. Completeness is an MVP
validation rule, not a permanent language restriction. The exact DOM sampling
policy remains to be designed: when values are captured, whether active Liva effects
and inline styles are excluded, and how omitted destination values are restored.
Computed styles are the recommended starting point for that design.

Omitted state properties are distinct from omitted keyframe endpoints. In the MVP,
missing `0%` and `100%` keyframes still derive from explicitly declared state values.
Reading displayed DOM values to interrupt an animation is also a separate,
already-required runtime behavior.

## Syntax model

The following is a structural sketch, not a parser implementation. `gap` denotes
whitespace and comments; declaration termination is defined separately below.

```text
Document       := Animation*
Animation      := Name '{' (State | Transition)* '}'
State          := 'state' Name '{' StateTarget* '}'
StateTarget    := Name '{' Declaration* '}'
Transition     := 'transition' (Name '->' Name)? '{' (Declaration | TrackTarget)* '}'
TrackTarget    := Name '{' PropertyTrack* '}'
PropertyTrack  := PropertyName '{' (Declaration | Keyframe)* '}'
Keyframe       := Percentage '{' Declaration* '}'
Declaration    := Name ':' Value Terminator
Call           := Name '(' (NamedArgument (',' NamedArgument)* ','?)? ')'
NamedArgument  := Name ':' RawArgument
```

**Confirmed:** animation, state, and target names match
`[A-Za-z_][A-Za-z0-9_-]*` and are case-sensitive. Property names also permit CSS
custom-property names such as `--offset`. This property-name allowance does not
extend the identifier grammar for animation, state, or target names.

Custom properties follow the same browser-delegated execution policy as all other
CSS properties; acceptance does not guarantee interpolation or visible motion.

**Confirmed:** parse unknown Liva declarations and generic calls, then diagnose
unsupported Liva semantics. CSS property names and values follow L8 and are not
subject to those semantic checks. `tween` and `spring` must never become
special lexer tokens or grammar productions.

A `timing` value uses the generic call structure. Each named argument's value is
an opaque slice: `cubic-bezier(...)`, `steps(...)`, and `linear(...)` inside it
remain raw CSS rather than Liva calls with positional arguments. State values
such as `translate: var(--offset, 24px) 0` remain raw values too. Syntax context
selects a generic call versus a CSS raw value, not the function name.

**Confirmed:** permit multiple definitions per document and one inline `<liva>`
block per SFC. There are no selectors, nesting selectors, expressions, imports,
variables, or user-defined functions in the MVP. CSS `var()` is browser syntax.

## Raw values, trivia, and statement boundaries

**Confirmed:** property declarations use newlines or semicolons as separators.
Multiple declarations on one line require semicolons. Function arguments instead
use commas. Newlines within a Liva call are whitespace, not argument separators;
semicolons do not separate arguments.

A comma separates arguments only outside nested parentheses within the value.
Commas inside `cubic-bezier(...)`, `var(...)`, or another parenthesized value remain
part of that value. The parser tracks structural boundaries without interpreting
CSS functions, their parameters, or their meaning.

```liva
timing: tween(
  duration: 350ms,
  easing: cubic-bezier(0.2, 0.8, 0.2, 1)
)
```

The equivalent same-line form requires no separator before the closing `)`:

```liva
timing: tween(duration: 350ms, easing: cubic-bezier(0.2, 0.8, 0.2, 1))
```

Nested values may also span lines because newlines do not separate arguments:

```liva
timing: tween(
  duration: 350ms,
  easing: cubic-bezier(
    0.2, 0.8,
    0.2, 1
  )
)
```

Prefer one property per line without semicolons, and one argument per line with
commas between arguments. **Confirmed:** a trailing comma after the final argument
is optional. Both forms are valid:

```liva
timing: tween(duration: 350ms, easing: ease-out)
timing: tween(duration: 350ms, easing: ease-out,)
```

**Confirmed:** reject leading commas and empty arguments between consecutive
commas. A single trailing comma does not create an empty argument.

```liva
// Invalid: leading comma
timing: tween(, duration: 350ms)

// Invalid: empty argument between commas
timing: tween(duration: 350ms,, easing: ease-out)

// Invalid: an extra trailing comma creates an empty argument
timing: tween(duration: 350ms,,)
```

These are syntax errors. An empty argument list, as in `tween()`, contains no
arguments rather than an empty argument; required-argument validation still
rejects it during semantic analysis.

**Confirmed scanner rules:**

1. Preserve every byte, including spaces, CRLF/LF, comments, invalid tokens, and
   original value spelling, in the CST. AST views never discard underlying text.
2. Scan raw arguments with a delimiter stack. At the argument-list level, a comma
   ends the argument and `)` ends the call. Nested parentheses are balanced first;
   extend the same grouping to brackets. Do not interpret nested function names
   or parse their CSS arguments. Preserve each argument as a raw source slice.
3. Recognize strings, escapes, and comments so commas and parentheses inside them
   do not affect argument boundaries. Support non-nesting `/* ... */` comments and
   `//` line comments at token boundaries; `https://` inside an unquoted token
   remains data. These comment rules apply to both properties and arguments.
4. Property declarations terminate at a newline, semicolon, enclosing `}`, or EOF
   outside structured calls and balanced groups. Apply the same balanced-group
   scanner to raw property values so nested CSS functions remain intact. A final property before `}` needs no
   semicolon; closing delimiters are not part of the preceding value.
5. Keep comments in CST. Replace them with whitespace in semantic
   raw values, trimming boundary trivia, and preserving strings and escapes.
6. A newline or semicolon cannot substitute for a missing argument comma. Do not
   heuristically split a second `name:` out of raw text. A malformed raw value such
   as `350ms easing: ease-out` fails semantic validation; where possible, suggest
   the missing comma. Unknown or duplicate argument names remain semantic errors.
7. Diagnose mismatched or unclosed delimiters while retaining the original text.
   EOF ends an incomplete call with a diagnostic rather than inserting source text.

Boundary fixtures must include same-line and multiline comma-separated calls,
multiple levels of nested parentheses, CSS function commas, strings/comments
containing delimiters, CRLF, missing commas, semicolon-separated invalid arguments,
and incomplete calls. Supporting opaque values does not require a CSS value grammar.

## Recovery and diagnostics

**Confirmed:** incomplete or invalid input should yield a recoverable, lossless
syntax tree with diagnostics wherever possible.

**Confirmed:** synchronize malformed blocks at a matching closing brace or a known
sibling construct at balanced depth. At unterminated strings/calls, preserve the
remainder as an error node when a safe boundary cannot be found. Never invent
source characters; missing-token diagnostics may use zero-width ranges. Every
recovery step must consume input or return to a caller, preventing infinite loops.
Typed AST accessors return optional children instead of assuming well-formed input.

Diagnostics carry a stable code, severity, message, primary range, and optional
related ranges. Duplicate definitions cite both occurrences. Syntax errors and
semantic errors prevent executable IR for the affected definition; other valid
definitions may still be inspected in development. A production build fails on
any error. During invalid edits, keep the last valid runtime definition.

## Timing functions

**Confirmed:** named-argument order is irrelevant; duplicates and unknown argument
names are errors. Semantic analysis interprets raw argument values by signature.
Duration and physics springs are distinct configurations. All CSS easing forms,
including keywords, `cubic-bezier()`, `steps()`, and `linear()`, must be preserved.

**Confirmed signatures (L5):**

| Function/configuration | Arguments                      | Validation and defaults                                                                              |
| ---------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `tween`                | `duration`, `easing`           | Duration required, finite nonnegative `ms` or `s`; easing defaults to `linear`                       |
| Duration `spring`      | `duration`, `bounce`           | Duration required and positive; bounce defaults to `0`, range `0 <= bounce < 1`                      |
| Physics `spring`       | `stiffness`, `damping`, `mass` | Stiffness and damping required and positive; mass positive, default `1`; all finite unitless numbers |

Presence of `duration` or `bounce` selects duration mode; physics arguments select
physics mode. Mixed families, no family, negative values, unsupported units,
`NaN`, infinities, and missing required arguments produce semantic errors.
A zero-duration tween applies the destination synchronously. Delay, repetition,
direction modes, spring initial velocity, and additional function arguments are
not in the MVP.

The compiler validates timing numeric signatures but preserves easing as nonempty
CSS text; browser validation catches invalid or unsupported easing before playback.
Adding a full Rust CSS easing parser is a separate decision, not a prerequisite.
Unknown Liva function names are semantic errors, though their syntax remains valid.

## Transition merging and keyframes

**Confirmed:** merge general and directional definitions at the target/property
level. A directional timing replaces the inherited timing entirely; argument
objects never merge. A directional keyframe collection replaces the inherited
collection entirely when any keyframes are provided. Unrelated tracks survive.

**Confirmed precedence (L2):** resolve transition-wide timing by choosing directional
then general. Resolve each property's explicit timing by choosing directional
property then general property, falling back to the resolved transition-wide
timing. Thus a general property override survives a directional global default.
No resolved timing means a compile-time error for an animated property (L1).

| General                               | Directional                        | Effective result under L2               |
| ------------------------------------- | ---------------------------------- | --------------------------------------- |
| Global tween 350ms; color tween 200ms | Global tween 500ms                 | Color 200ms; other tracks use 500ms     |
| Translate physics spring with mass 2  | Translate duration spring of 350ms | Duration spring only; no mass inherited |
| Scale frames at 40%, 70%              | Scale frame at 60%                 | Only 60% plus completed endpoints       |
| Color override                        | Translate override                 | Both property overrides retained        |

**Confirmed:** keyframes use blocks; missing `0%`/`100%` values derive from source/
destination states. Easing on a frame applies from that frame to the next.
Intermediate keyframes with spring timing are unsupported. No shorthand frames or
reusable timeline definitions are provided.

**Confirmed:** percentages are finite decimals in `[0, 100]`, unique per property,
and sorted numerically in IR without rewriting source. Require `value` in each
explicit frame. Diagnose duplicates and out-of-range offsets. Explicit endpoint
values override state-derived endpoints during playback. On completion, apply
the destination state's value; differing explicit endpoints therefore can snap
and should produce a warning. An easing on `100%` has no interval and warns.

Tween timing easing supplies each interval's default; a frame easing overrides
that interval. Keep WAAPI effect-level easing linear to avoid applying easing
twice, following the confirmed interval-default interpretation (L4). Springs reject
any intermediate frame or frame-level easing after transition merging, including
inherited combinations. Explicit spring endpoints without easing are allowed.

## CSS property execution policy (L8 — confirmed)

Accept arbitrary CSS property names and raw values from the MVP onward, including
custom properties, shorthands, and combinations of `transform` with individual
transform properties. Do not maintain a property allowlist, validate CSS values,
check animatability, or probe support before passing tracks to WAAPI. Unknown
property names and invalid CSS values are not Liva semantic errors. Do not add a
special rejection rule for `!important`; pass the raw value through and accept the
browser's result.

Browser-dependent behavior, ignored declarations, discrete changes, and no visible
animation are acceptable. Liva does not guarantee that every accepted property
animates, and does not implement fallback interpolation or automatic custom-property
registration. The toggle's three properties are demonstration coverage, not a
restriction on accepted input.

Liva syntax and its own semantics still require validation: state references,
MVP state completeness, timing function signatures, duplicate arguments, frame
offsets, and spring/keyframe compatibility. Required WAAPI property-name mapping
is serialization, not CSS validation. Runtime exception handling is specified
separately in the architecture document.

## Confirmed language decisions

| ID  | Decision                                                                                                                                                                                                                                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1  | Require resolved timing for each animated track, supplied by a transition-wide default or property override. There is no implicit language-wide timing. Complete state property declarations are required only in the MVP.                                                                                                            |
| L2  | Resolve timing in this order: directional property, general property, directional transition-wide, general transition-wide.                                                                                                                                                                                                           |
| L3  | Animate unequal trimmed raw state values or any explicit keyframe collection, even when endpoints match. Unchanged properties without keyframes settle immediately.                                                                                                                                                                   |
| L4  | Timing easing supplies each interval's default. Explicit endpoints may differ from states, with a warning and final settlement to the destination state.                                                                                                                                                                              |
| L5  | Use the timing signatures, numeric ranges, and defaults above. Spring duration/bounce mapping and solver calibration are runtime design work, not additional language defaults.                                                                                                                                                       |
| L6  | Reject duplicate definitions, states, targets within a state/transition, properties within a target, transitions for the same direction (including duplicate general transitions), and frame offsets within a property. Names reused across states/transitions are references to the same logical targets/properties, not duplicates. |
| L7  | Use the identifier, comment, string/escape, and balanced-group rules above. Apply grouping to raw property and argument values. Arguments are comma-separated with one optional trailing comma; reject leading commas and empty arguments.                                                                                            |
| L8  | Accept arbitrary CSS properties and values without CSS validation or support probes; delegate execution to WAAPI and allow no visible animation.                                                                                                                                                                                      |
| L9  | A request for the active logical state is a no-op; apply the initial state immediately. On interruption, use the previously requested state for direction lookup and the displayed value for the start.                                                                                                                               |
| L10 | Allow one inline block per SFC and multiple named definitions within it. Bind one DOM element per target per instance.                                                                                                                                                                                                                |

The future DOM fallback sampling/restoration policy and runtime spring calibration
remain outside these confirmed MVP language rules. No pending language proposal
blocks the syntax or semantic milestones; their implementation validation gates
still apply.
