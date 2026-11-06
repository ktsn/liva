use liva_compiler::edits::{Edit, apply_edits};

fn set(path: &str, value: &str) -> Edit {
    Edit::Set {
        path: path.into(),
        value: value.into(),
    }
}

#[test]
fn targeted_edits_preserve_unicode_comments_and_crlf() {
    let source = format!(
        "// 日本語😀\r\n{}",
        include_str!("../../../fixtures/toggle.liv").replace('\n', "\r\n")
    );
    let result = apply_edits(
        &source,
        &[
            set("toggle/transition/general/timing/duration", "500ms"),
            set(
                "toggle/transition/general/target/thumb/property/scale/frame/0.4/value",
                "1.5 1",
            ),
        ],
    )
    .unwrap();
    assert_eq!(
        result.source,
        source
            .replacen("duration: 350ms", "duration: 500ms", 1)
            .replacen("40%: 1.3 1", "40%: 1.5 1", 1)
    );
    assert_eq!(
        source.matches('\n').count(),
        result.source.matches('\n').count()
    );
}

#[test]
fn comments_and_field_injection_fail_safely() {
    let source = include_str!("../../../fixtures/toggle.liv");
    let commented = source.replacen("350ms", "/* preserve */ 350ms", 1);
    assert!(
        apply_edits(
            &commented,
            &[set("toggle/transition/general/timing/duration", "500ms")]
        )
        .unwrap_err()
        .contains("comments")
    );
    assert!(
        apply_edits(
            source,
            &[set(
                "toggle/transition/general/timing/duration",
                "500ms, easing: linear"
            )]
        )
        .is_err()
    );
    assert!(
        apply_edits(
            source,
            &[set(
                "toggle/transition/general/target/thumb/property/scale/frame/0.4/value",
                "1.5\neasing: steps(2)"
            )]
        )
        .is_err()
    );
}

#[test]
fn adds_directional_override_and_adds_removes_frames() {
    let source = include_str!("../../../fixtures/toggle.liv");
    let result = apply_edits(
        source,
        &[
            Edit::Override {
                definition: "toggle".into(),
                from: "off".into(),
                to: "on".into(),
                target: "track".into(),
                property: "background-color".into(),
                timing: "@tween: 800ms".into(),
            },
            Edit::AddFrame {
                path: "toggle/transition/general/target/thumb/property/scale".into(),
                offset: 0.6,
                value: "1.2".into(),
                easing: None,
            },
            Edit::RemoveFrame {
                path: "toggle/transition/general/target/thumb/property/scale/frame/0.7".into(),
            },
        ],
    )
    .unwrap();
    assert!(result.source.contains("transition off -> on"));
    assert!(result.source.contains("60%"));
    assert!(!result.source.contains("70%"));
    assert!(result.source.contains("@spring: 300 20"));
    assert!(
        apply_edits(
            source,
            &[Edit::AddFrame {
                path: "toggle/transition/general/target/thumb/property/scale".into(),
                offset: 0.4,
                value: "2".into(),
                easing: None
            }]
        )
        .is_err()
    );
}

#[test]
fn frame_offsets_move_by_semantic_identity_and_reject_collisions() {
    let source = include_str!("../../../fixtures/toggle.liv");
    let result = apply_edits(
        source,
        &[set(
            "toggle/transition/general/target/thumb/property/scale/frame/0.4/offset",
            "55%",
        )],
    )
    .unwrap();
    assert_eq!(result.source, source.replacen("40%", "55%", 1));
    assert!(
        apply_edits(
            source,
            &[set(
                "toggle/transition/general/target/thumb/property/scale/frame/0.4/offset",
                "70.0%"
            )]
        )
        .is_err()
    );
}

#[test]
fn new_comments_cannot_consume_neighbors() {
    let source = "motion a { state off { t { x: 0 } } state on when true { t { x: 1 } } transition { @tween-duration: 1ms\nt { x { 50%: 1 @ ease-in\n } } } }";
    assert!(
        apply_edits(
            source,
            &[set(
                "a/transition/general/target/t/property/x/frame/0.5/value",
                "2 //"
            )]
        )
        .is_err()
    );
    assert!(
        apply_edits(
            source,
            &[set("a/transition/general/timing/duration", "2ms /*")]
        )
        .is_err()
    );
}

#[test]
fn compact_insertions_preserve_crlf() {
    let source = "// header\r\nmotion a { state off { t { x: 0 } } state on when true { t { x: 1 } } transition { @tween-duration: 1ms\r\nt { x {} } } }\r\n";
    let result = apply_edits(
        source,
        &[
            Edit::AddFrame {
                path: "a/transition/general/target/t/property/x".into(),
                offset: 0.5,
                value: "2".into(),
                easing: None,
            },
            Edit::Override {
                definition: "a".into(),
                from: "off".into(),
                to: "on".into(),
                target: "t".into(),
                property: "x".into(),
                timing: "@tween: 2ms".into(),
            },
        ],
    )
    .unwrap();
    assert_eq!(
        result.source.matches('\n').count(),
        result.source.matches("\r\n").count()
    );
    assert!(result.source.starts_with("// header\r\nmotion a { state off { t { x: 0 } } state on when true { t { x: 1 } } transition { @tween-duration: 1ms\r\nt { x {"));
}

#[test]
fn track_edits_copy_frames_and_restore_inheritance_independently() {
    use liva_compiler::edits::FrameEdit;
    let source = include_str!("../../../fixtures/toggle.liv");
    let path = "toggle/transition/directional/off/on/target/thumb/property/scale";
    let edit = |timing, frames| Edit::Track {
        path: path.into(),
        timing,
        frames,
    };
    let copied = apply_edits(
        source,
        &[edit(
            None,
            Some(vec![
                FrameEdit {
                    offset: 0.4,
                    value: "1.4".into(),
                    easing: Some("ease-in".into()),
                },
                FrameEdit {
                    offset: 0.7,
                    value: "0.95 1".into(),
                    easing: None,
                },
            ]),
        )],
    )
    .unwrap();

    assert!(copied.source.contains("transition off -> on"));
    assert!(copied.source.contains("40%: 1.4"));
    assert!(copied.source.contains("40%: 1.3 1"));

    let restored =
        apply_edits(&copied.source, &[edit(Some("@tween: 200ms".into()), None)]).unwrap();
    let direction = restored.compilation.definitions[0]
        .directional_transitions
        .iter()
        .find(|d| d.from == "off")
        .unwrap();
    let track = &direction.transition.targets[0].properties[0];
    assert!(track.keyframes.is_none());
    assert!(track.timing.is_some());

    let removed = apply_edits(&restored.source, &[edit(None, None)]).unwrap();
    assert!(!removed.source.contains("@tween: 200ms"));
}

#[test]
fn track_edits_reject_injection_collisions_and_comment_loss() {
    use liva_compiler::edits::FrameEdit;
    let source = include_str!("../../../fixtures/toggle.liv");
    let path = "toggle/transition/general/target/thumb/property/scale";
    let edit = |frames| Edit::Track {
        path: path.into(),
        timing: None,
        frames: Some(frames),
    };
    let frame = |value: &str| FrameEdit {
        offset: 0.4,
        value: value.into(),
        easing: None,
    };

    for frames in [
        vec![frame("1\neasing: ease")],
        vec![frame("1; 60%: 2")],
        vec![frame("1"), frame("2")],
    ] {
        assert!(apply_edits(source, &[edit(frames)]).is_err());
    }

    let commented = source.replace("40%: 1.3 1", "40%: /* keep */ 1.3 1");
    assert!(
        apply_edits(&commented, &[edit(vec![frame("1")])])
            .unwrap_err()
            .contains("comments")
    );
}

#[test]
fn track_edits_accept_opaque_grouped_values_and_preserve_surrounding_crlf() {
    use liva_compiler::edits::FrameEdit;
    let source = include_str!("../../../fixtures/toggle.liv").replace('\n', "\r\n");
    let path = "toggle/transition/general/target/thumb/property/scale";
    let result = apply_edits(
        &source,
        &[Edit::Track {
            path: path.into(),
            timing: Some("@tween: 500ms linear(\n 0,\n 1\n)".into()),
            frames: Some(vec![
                FrameEdit {
                    offset: 0.5,
                    value: "var(--scale,\n 1.5)".into(),
                    easing: Some("linear".into()),
                },
                FrameEdit {
                    offset: 0.7,
                    value: "\"a;b{}\"".into(),
                    easing: None,
                },
            ]),
        }],
    )
    .unwrap();

    assert_eq!(
        result.source.matches('\n').count(),
        result.source.matches("\r\n").count()
    );
    let original_range = &liva_compiler::compile(&source, true).mappings.unwrap()[path].range;
    let new_range = &result.compilation.mappings.as_ref().unwrap()[path].range;
    assert_eq!(
        &source[..original_range.start],
        &result.source[..new_range.start]
    );
    assert_eq!(
        &source[original_range.end..],
        &result.source[new_range.end..]
    );
}

#[test]
fn track_formatting_does_not_indent_inside_opaque_values() {
    use liva_compiler::edits::FrameEdit;
    let source = include_str!("../../../fixtures/toggle.liv");
    let value = "\"a\\\nb\"";
    for path in [
        "toggle/transition/general/target/thumb/property/scale",
        "toggle/transition/directional/off/on/target/thumb/property/scale",
    ] {
        let result = apply_edits(
            source,
            &[Edit::Track {
                path: path.into(),
                timing: None,
                frames: Some(vec![FrameEdit {
                    offset: 0.5,
                    value: value.into(),
                    easing: None,
                }]),
            }],
        )
        .unwrap();
        let mapping =
            &result.compilation.mappings.as_ref().unwrap()[&format!("{path}/frame/0.5/value")];
        assert_eq!(
            liva_syntax::semantic_text(&result.source[mapping.range.start..mapping.range.end]),
            value
        );
    }
}

#[test]
fn track_edits_preserve_surrounding_source() {
    use liva_compiler::edits::{Edit, FrameEdit, apply_edits};
    let source = include_str!("../../../fixtures/reactive-toggle.liv").replace('\n', "\r\n");
    let path = "toggle/transition/general/target/thumb/property/scale";
    let result = apply_edits(
        &source,
        &[Edit::Track {
            path: path.into(),
            timing: Some("@tween: 200ms ease-in".into()),
            frames: Some(vec![FrameEdit {
                offset: 0.5,
                value: "1.2 1".into(),
                easing: Some("steps(2, end)".into()),
            }]),
        }],
    )
    .unwrap();
    let old = liva_compiler::compile(&source, true).mappings.unwrap()[path]
        .range
        .clone();
    let new = result.compilation.mappings.unwrap()[path].range.clone();

    assert_eq!(&source[..old.start], &result.source[..new.start]);
    assert_eq!(&source[old.end..], &result.source[new.end..]);
    assert!(result.source.contains("50%: 1.2 1 @ steps(2, end)"));
}

#[test]
fn inline_frame_field_edits_preserve_comments_or_reject() {
    use liva_compiler::edits::{Edit, apply_edits};
    let source = include_str!("../../../fixtures/reactive-toggle.liv");
    let path = "toggle/transition/general/target/thumb/property/scale/frame/0.4/value";
    let edit = Edit::Set {
        path: path.into(),
        value: "1.5 1".into(),
    };
    let result = apply_edits(source, &[edit]).unwrap();
    assert_eq!(result.source, source.replacen("1.3 1", "1.5 1", 1));

    let source = source.replace("40%: 1.3 1", "40%: /* 😀 preserve */ 1.3 1");
    let edit = Edit::Set {
        path: path.into(),
        value: "1.5 1".into(),
    };
    assert!(
        apply_edits(&source, &[edit])
            .unwrap_err()
            .contains("comments")
    );
}

#[test]
fn timing_edits_reject_extra_declarations() {
    let source = include_str!("../../../fixtures/toggle.liv");

    for timing in ["@tween: 1ms; @spring: 300 20", "@tween: 1ms } } }"] {
        for edit in [
            Edit::Track {
                path: "toggle/transition/general/target/thumb/property/scale".into(),
                timing: Some(timing.into()),
                frames: None,
            },
            Edit::Override {
                definition: "toggle".into(),
                from: "off".into(),
                to: "on".into(),
                target: "thumb".into(),
                property: "scale".into(),
                timing: timing.into(),
            },
        ] {
            assert!(apply_edits(source, &[edit]).is_err(), "{timing}");
        }
    }
}

#[test]
fn directional_override_preserves_existing_frames_and_comments() {
    let source = "motion a { state off { t { x: 0 } } state on when true { t { x: 1 } } transition { @tween: 1s } transition off -> on { t { x { @tween: 2s; 40%: 2 /* keep */ } } } }";
    let result = apply_edits(
        source,
        &[Edit::Override {
            definition: "a".into(),
            from: "off".into(),
            to: "on".into(),
            target: "t".into(),
            property: "x".into(),
            timing: "@tween: 3s ease-in".into(),
        }],
    )
    .unwrap();

    assert!(result.source.contains("40%: 2 /* keep */"));
    let track = &result.compilation.definitions[0].directional_transitions[0]
        .transition
        .targets[0]
        .properties[0];
    assert_eq!(track.keyframes.as_ref().unwrap()[0].value, "2");
    assert_eq!(
        track.timing,
        Some(liva_compiler::ir::Timing::Tween {
            duration_ms: 3000.0,
            easing: "ease-in".into(),
        })
    );
}

#[test]
fn missing_frame_easing_is_inserted_inline() {
    let source = "motion a { state idle { t { x: 0 } } transition { @tween: 1s; t { x { 40%: 2; 70%: 3 } } } }";
    let result = apply_edits(
        source,
        &[set(
            "a/transition/general/target/t/property/x/frame/0.4/easing",
            "ease-in",
        )],
    )
    .unwrap();

    assert_eq!(result.source, source.replace("40%: 2", "40%: 2 @ ease-in"));
}

#[test]
fn lifecycle_tracks_support_creation_shorthand_templates_and_removal() {
    use liva_compiler::edits::FrameEdit;

    let source = "motion panel(distance: number, open: boolean) {\n  state idle { body { opacity: 1 } }\n  state active when open { body { opacity: 0.8 } }\n  transition { @tween: 100ms }\n  enter { @tween: 200ms; body { opacity: 0 } }\n}\n";
    let track = |path: &str, value: &str| Edit::Track {
        path: path.into(),
        timing: Some("@tween: 400ms ease-out".into()),
        frames: Some(vec![FrameEdit {
            offset: 0.0,
            value: value.into(),
            easing: None,
        }]),
    };

    let edited = apply_edits(
        source,
        &[
            track("panel/enter/target/body/property/opacity", "0.2"),
            track(
                "panel/enter/target/body/property/translate",
                "${distance}px 0",
            ),
            track("panel/leave/target/body/property/opacity", "0.4"),
        ],
    )
    .unwrap();

    assert!(edited.source.contains("leave {"));
    assert!(edited.source.contains("${distance}px 0"));
    assert_eq!(edited.source.matches("opacity {").count(), 2);

    let reset = apply_edits(
        &edited.source,
        &[Edit::Track {
            path: "panel/enter/target/body/property/translate".into(),
            timing: None,
            frames: None,
        }],
    )
    .unwrap();

    assert!(!reset.source.contains("${distance}px 0"));
    assert!(reset.source.contains("0%: 0.4"));
    assert!(
        apply_edits(
            source,
            &[track(
                "panel/enter/missing/target/body/property/opacity",
                "0"
            )]
        )
        .is_err()
    );
    assert!(
        apply_edits(
            &source.replace("opacity: 0", "opacity: /* keep */ 0"),
            &[track("panel/enter/target/body/property/opacity", "0.2")]
        )
        .unwrap_err()
        .contains("comments")
    );
}
