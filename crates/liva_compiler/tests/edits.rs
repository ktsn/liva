use liva_compiler::edits::{Edit, apply_edits};

const SOURCE: &str = include_str!("../../../fixtures/toggle.liv");
const TRACK: &str = "toggle/layer/toggle/transition/0/target/thumb/property/scale";

fn set(path: &str, value: &str) -> Edit {
    Edit::Set {
        path: path.into(),
        value: value.into(),
    }
}

fn timing(path: &str, value: &str) -> Edit {
    Edit::Timing {
        path: path.into(),
        value: Some(value.into()),
    }
}

fn frame(offset: f64, value: &str, easing: Option<&str>) -> Edit {
    Edit::AddFrame {
        path: TRACK.into(),
        offset,
        value: value.into(),
        easing: easing.map(str::to_owned),
    }
}

#[test]
fn targeted_edits_preserve_unicode_comments_and_crlf() {
    let source = format!("// 日本語😀\r\n{}", SOURCE.replace('\n', "\r\n"));
    let result = apply_edits(
        &source,
        &[
            set(
                "toggle/layer/toggle/timing",
                "tween(duration: 500, easing: easeOut)",
            ),
            set(&format!("{TRACK}/frame/0.4/value"), "1.5 1"),
        ],
    )
    .unwrap();

    assert_eq!(
        result.source,
        source
            .replacen("duration: 350,", "duration: 500,", 1)
            .replacen("40%: 1.3 1", "40%: 1.5 1", 1)
    );
    assert_eq!(
        source.matches('\n').count(),
        result.source.matches('\n').count()
    );
}

#[test]
fn replacing_a_commented_expression_is_rejected() {
    let source = SOURCE.replacen("duration: 350", "duration: /* preserve */ 350", 1);
    let result = apply_edits(
        &source,
        &[set("toggle/layer/toggle/timing", "tween(duration: 500)")],
    );

    assert!(result.unwrap_err().contains("comments"));
}

#[test]
fn field_edits_reject_injected_declarations_and_comments() {
    for value in ["1.5\neasing: steps(2)", "2 //", "2 /*", "1; 60%: 2"] {
        let result = apply_edits(SOURCE, &[set(&format!("{TRACK}/frame/0.4/value"), value)]);

        assert!(result.is_err(), "{value}");
    }
}

#[test]
fn adds_and_removes_frames_without_changing_other_transition_tracks() {
    let result = apply_edits(
        SOURCE,
        &[
            frame(0.6, "1.2", Some("easeIn")),
            Edit::RemoveFrame {
                path: format!("{TRACK}/frame/0.7"),
            },
        ],
    )
    .unwrap();
    let transition = &result.compilation.definitions[0].layers[0].transitions[0].transition;
    let frames = transition.targets[0].properties[0]
        .keyframes
        .as_ref()
        .unwrap();

    assert_eq!(
        frames.iter().map(|frame| frame.offset).collect::<Vec<_>>(),
        [0.4, 0.6]
    );
    assert_eq!(result.source.matches("70%:").count(), 1);
    assert!(result.source.contains("60%: 1.2 @easeIn"));
}

#[test]
fn added_frames_reject_offset_collisions() {
    let result = apply_edits(SOURCE, &[frame(0.4, "2", None)]);

    assert!(result.is_err());
}

#[test]
fn frame_offsets_move_by_semantic_identity() {
    let result = apply_edits(SOURCE, &[set(&format!("{TRACK}/frame/0.4/offset"), "55%")]).unwrap();

    assert_eq!(result.source, SOURCE.replacen("40%", "55%", 1));
}

#[test]
fn moving_a_frame_rejects_offset_collisions() {
    let result = apply_edits(
        SOURCE,
        &[set(&format!("{TRACK}/frame/0.4/offset"), "70.0%")],
    );

    assert!(result.is_err());
}

#[test]
fn compact_frame_insertions_preserve_crlf() {
    let source = "// header\r\nmotion a { layer base { t { x: 0 } state off initial {} state on {} @tween(duration: 1) transition off -> on when true {\r\nt { x ~> {} } } } }\r\n";
    let result = apply_edits(
        source,
        &[Edit::AddFrame {
            path: "a/layer/base/transition/0/target/t/property/x".into(),
            offset: 0.5,
            value: "2".into(),
            easing: None,
        }],
    )
    .unwrap();

    assert_eq!(
        result.source.matches('\n').count(),
        result.source.matches("\r\n").count()
    );
    assert!(
        result
            .source
            .starts_with(source.split("x ~> {}").next().unwrap())
    );
}

#[test]
fn frame_insertion_preserves_opaque_grouped_values_and_surrounding_source() {
    for value in ["var(--scale,\n 1.5)", "\"a;b{}\"", "\"a\\\nb\""] {
        let source = SOURCE.replace('\n', "\r\n");
        let value = value.replace('\n', "\r\n");
        let result = apply_edits(&source, &[frame(0.5, &value, Some("linear"))]).unwrap();
        let old = &liva_compiler::compile(&source, true).mappings.unwrap()[TRACK].range;
        let mappings = result.compilation.mappings.unwrap();
        let new = &mappings[TRACK].range;
        let value_range = &mappings[&format!("{TRACK}/frame/0.5/value")].range;

        assert_eq!(&source[..old.start], &result.source[..new.start]);
        assert_eq!(&source[old.end..], &result.source[new.end..]);
        assert_eq!(
            liva_syntax::semantic_text(&result.source[value_range.start..value_range.end]),
            liva_syntax::semantic_text(&value)
        );
        assert_eq!(
            result.source.matches('\n').count(),
            result.source.matches("\r\n").count()
        );
    }
}

#[test]
fn commented_frame_values_are_not_replaced() {
    let source = SOURCE.replace("40%: 1.3 1", "40%: /* 😀 preserve */ 1.3 1");
    let result = apply_edits(
        &source,
        &[set(&format!("{TRACK}/frame/0.4/value"), "1.5 1")],
    );

    assert!(result.unwrap_err().contains("comments"));
}

#[test]
fn timing_edits_reject_removed_syntax_and_injection() {
    for value in [
        "@tween: 1ms",
        "tween(duration: 1); @spring: 300 20",
        "tween() } } }",
    ] {
        let result = apply_edits(SOURCE, &[timing(TRACK, value)]);

        assert!(result.is_err(), "{value}");
    }
}

#[test]
fn timing_edits_preserve_existing_frames_and_comments() {
    let source = SOURCE.replacen("40%: 1.3 1", "40%: 1.3 1 /* keep */", 1);
    let result = apply_edits(
        &source,
        &[timing(TRACK, "tween(duration: 3000, easing: easeIn)")],
    )
    .unwrap();

    assert!(result.source.contains("40%: 1.3 1 /* keep */"));
    assert!(
        result
            .source
            .contains("@tween(duration: 3000, easing: easeIn)\n      scale")
    );
}

#[test]
fn missing_frame_easing_is_inserted_as_a_typed_decorator() {
    let source = SOURCE.replacen(" @easeIn", "", 1);
    let result = apply_edits(
        &source,
        &[Edit::Easing {
            path: format!("{TRACK}/frame/0.4"),
            value: Some("easeIn".into()),
        }],
    )
    .unwrap();

    assert_eq!(result.source, SOURCE);
}

#[test]
fn removed_edit_operations_are_rejected_at_the_request_boundary() {
    for operation in ["track", "override"] {
        let request = serde_json::json!({"op": operation, "path": TRACK});

        assert!(serde_json::from_value::<Edit>(request).is_err());
    }
}

#[test]
fn removed_paths_do_not_create_motion_level_declarations() {
    for path in [
        "toggle/transition/general/target/thumb/property/scale",
        "toggle/transition/directional/off/on/target/thumb/property/scale",
        "toggle/state/off/target/thumb/property/scale",
    ] {
        let result = apply_edits(SOURCE, &[timing(path, "tween(duration: 100)")]);

        assert!(result.is_err(), "{path}");
    }
}

#[test]
fn controller_attachments_preserve_source_expressions_and_reject_timeline_conversion() {
    let source = "motion resize(value: number) { let size = link(input: value); layer base { width := size; height: 50px } }";
    let path = "resize/layer/base/target/self/property/width";

    for edit in [
        timing(path, "tween(duration: 100)"),
        Edit::AddFrame {
            path: path.into(),
            offset: 0.5,
            value: "100px".into(),
            easing: None,
        },
    ] {
        let result = apply_edits(source, &[edit]);

        assert!(result.unwrap_err().contains("source-owned"));
    }

    let result = apply_edits(
        source,
        &[set(
            "resize/layer/base/target/self/property/height/value",
            "75px",
        )],
    )
    .unwrap();

    assert_eq!(result.source, source.replace("50px", "75px"));
}

#[test]
fn source_edits_preserve_literal_annotations_and_recompiled_mappings() {
    let original = include_str!("../../../fixtures/constrained.liv");
    let source = format!("// 日本語😀\r\n{}", original.replace('\n', "\r\n"));
    let path = "constrained/layer/base/target/thumb/property/opacity/value";

    let result = apply_edits(&source, &[set(path, ".5")]).unwrap();
    let before = liva_compiler::compile(&source, true);

    assert_eq!(
        result.source,
        source.replacen("opacity: .25", "opacity: .5", 1)
    );
    assert_eq!(
        result.compilation.definitions[0].parameters,
        before.definitions[0].parameters
    );

    let range = &result.compilation.mappings.as_ref().unwrap()[path].range;

    assert_eq!(&result.source[range.start..range.end], " .5");
}
