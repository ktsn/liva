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
    let source = "a { state off { t { x: 0 } } state on { t { x: 1 } } transition { timing: tween(duration: 1ms)\nt { x { 50% { value: 1; easing: ease-in\n} } } } }";
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
    let source = "// header\r\na { state off { t { x: 0 } } state on { t { x: 1 } } transition { timing: tween(duration: 1ms)\r\nt { x {} } } }\r\n";
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
    assert!(result.source.starts_with("// header\r\na { state off { t { x: 0 } } state on { t { x: 1 } } transition { timing: tween(duration: 1ms)\r\nt { x {"));
}
