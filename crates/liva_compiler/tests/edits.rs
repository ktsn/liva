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
            .replacen("value: 1.3 1", "value: 1.5 1", 1)
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
                timing: "tween(duration: 800ms)".into(),
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
    assert!(
        result
            .source
            .contains("timing: spring(\n          stiffness: 300")
    );
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
    let source = "motion a { state off { t { x: 0 } } state on when true { t { x: 1 } } transition { timing: tween(duration: 1ms)\nt { x { 50% { value: 1; easing: ease-in\n} } } } }";
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
    let source = "// header\r\nmotion a { state off { t { x: 0 } } state on when true { t { x: 1 } } transition { timing: tween(duration: 1ms)\r\nt { x {} } } }\r\n";
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
                timing: "tween(duration: 2ms)".into(),
            },
        ],
    )
    .unwrap();
    assert_eq!(
        result.source.matches('\n').count(),
        result.source.matches("\r\n").count()
    );
    assert!(result.source.starts_with("// header\r\nmotion a { state off { t { x: 0 } } state on when true { t { x: 1 } } transition { timing: tween(duration: 1ms)\r\nt { x {"));
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
    assert!(copied.source.contains("value: 1.3 1"));

    let restored = apply_edits(
        &copied.source,
        &[edit(Some("tween(duration: 200ms)".into()), None)],
    )
    .unwrap();
    let direction = restored.compilation.definitions[0]
        .directional_transitions
        .iter()
        .find(|d| d.from == "off")
        .unwrap();
    let track = &direction.transition.targets[0].properties[0];
    assert!(track.keyframes.is_none());
    assert!(track.timing.is_some());

    let removed = apply_edits(&restored.source, &[edit(None, None)]).unwrap();
    assert!(!removed.source.contains("200ms)"));
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
        vec![frame("1 } 60% { value: 2")],
        vec![frame("1"), frame("2")],
    ] {
        assert!(apply_edits(source, &[edit(frames)]).is_err());
    }

    let commented = source.replace("value: 1.3 1", "value: /* keep */ 1.3 1");
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
            timing: Some("tween(\n duration: 500ms,\n easing: linear\n)".into()),
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
