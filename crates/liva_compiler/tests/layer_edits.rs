use liva_compiler::edits::{Edit, apply_edits};

const SOURCE: &str = "// 日本語😀\r\nmotion sample(amount: number) {\r\n let quick = tween(duration: 200)\r\n @quick layer base {\r\n body {\r\n // keep this comment\r\n opacity: ${amount};\r\n scale: 1 @spring(duration: 400, bounce: 0.25)\r\n }\r\n }\r\n}";
const OPACITY: &str = "sample/layer/base/target/body/property/opacity";

#[test]
fn value_and_timing_edits_preserve_expressions_comments_and_shared_defaults() {
    let result = apply_edits(
        SOURCE,
        &[
            Edit::Timing {
                path: OPACITY.into(),
                value: Some("tween(duration: 300, easing: steps(count: 4))".into()),
            },
            Edit::Set {
                path: format!("{OPACITY}/value"),
                value: "${amount * 0.5}".into(),
            },
        ],
    )
    .unwrap();

    assert!(
        result
            .source
            .contains("opacity: ${amount * 0.5} @tween(duration: 300, easing: steps(count: 4))")
    );
    assert!(result.source.contains("// keep this comment\r\n"));
    assert!(result.source.contains("@quick layer base"));
    assert!(
        result
            .source
            .contains("scale: 1 @spring(duration: 400, bounce: 0.25)")
    );
}

#[test]
fn removing_a_local_override_restores_inheritance_without_rewriting_values() {
    let changed = apply_edits(
        SOURCE,
        &[Edit::Timing {
            path: OPACITY.into(),
            value: Some("spring(duration: 300)".into()),
        }],
    )
    .unwrap();
    let restored = apply_edits(
        &changed.source,
        &[Edit::Timing {
            path: OPACITY.into(),
            value: None,
        }],
    )
    .unwrap();
    let property = &restored.compilation.definitions[0].layers[0].targets[0].properties[0];

    assert!(property.timing_expression.is_none());
    assert!(property.template.is_some());
    assert!(restored.source.contains("@quick layer base"));
    assert!(!restored.source.contains("spring(duration: 300)"));
}

#[test]
fn adding_a_style_keyframe_preserves_the_original_expression_at_one_hundred_percent() {
    let result = apply_edits(
        SOURCE,
        &[Edit::AddFrame {
            path: OPACITY.into(),
            offset: 0.5,
            value: "${amount * 0.5}".into(),
            easing: Some("stepEnd".into()),
        }],
    )
    .unwrap();
    let property = &result.compilation.definitions[0].layers[0].targets[0].properties[0];
    let frames = property.keyframes.as_ref().unwrap();

    assert_eq!(frames[0].offset, 0.5);
    assert!(frames[0].easing_expression.is_some());
    assert_eq!(frames[1].value, "${amount}");
    assert!(result.source.contains("// keep this comment\r\n"));
}

#[test]
fn existing_bodyless_transition_receives_only_the_requested_property_override() {
    let source = "motion sample { layer machine { state idle initial { body { opacity: 1; scale: 1 } } @tween(duration: 100) transition idle -> idle when false } }";
    let path = "sample/layer/machine/transition/0/target/body/property/opacity";
    let result = apply_edits(
        source,
        &[Edit::Timing {
            path: path.into(),
            value: Some("spring(duration: 400, bounce: 0.25)".into()),
        }],
    )
    .unwrap();
    let transition = &result.compilation.definitions[0].layers[0].transitions[0].transition;

    assert_eq!(transition.targets[0].properties.len(), 1);
    assert_eq!(transition.targets[0].properties[0].name, "opacity");
    assert!(result.source.contains("when false"));
    assert!(result.source.contains("@tween(duration: 100)"));
    assert!(
        result
            .source
            .contains("state idle initial { body { opacity: 1; scale: 1 } }")
    );
}

#[test]
fn moving_a_frame_preserves_timing_and_easing() {
    let source = "motion sample { @tween() layer base { body { opacity { 50%: 0.5 @stepStart; 100%: 1 } } } }";
    let moved = apply_edits(
        source,
        &[Edit::Set {
            path: format!("{OPACITY}/frame/0.5/offset"),
            value: "60%".into(),
        }],
    )
    .unwrap();

    assert!(moved.source.contains("60%: 0.5 @stepStart"));
    assert!(moved.source.contains("@tween() layer base"));
}

#[test]
fn moving_a_frame_rejects_an_offset_collision() {
    let source = "motion sample { @tween() layer base { body { opacity { 50%: 0.5; 100%: 1 } } } }";

    assert!(
        apply_edits(
            source,
            &[Edit::Set {
                path: format!("{OPACITY}/frame/0.5/offset"),
                value: "100%".into()
            }]
        )
        .is_err()
    );
}

#[test]
fn removing_a_style_destination_is_rejected() {
    let source = "motion sample { @tween() layer base { body { opacity { 50%: 0.5; 100%: 1 } } } }";

    assert!(
        apply_edits(
            source,
            &[Edit::RemoveFrame {
                path: format!("{OPACITY}/frame/1")
            }]
        )
        .is_err()
    );
}

#[test]
fn source_edits_do_not_synthesize_transitions_or_convert_state_properties() {
    let source =
        "motion sample { @tween() layer machine { state idle initial { body { opacity: 1 } } } }";

    for path in [
        "sample/layer/machine/transition/0/target/body/property/opacity",
        "sample/layer/machine/state/idle/target/body/property/opacity",
    ] {
        assert!(
            apply_edits(
                source,
                &[Edit::AddFrame {
                    path: path.into(),
                    offset: 0.5,
                    value: "0.5".into(),
                    easing: None
                }]
            )
            .is_err()
        );
    }
}

#[test]
fn ordinary_track_conversion_retains_cross_layer_timing_inheritance() {
    let source = "motion sample { @tween(duration: 200) layer base { body { opacity: 0 } } layer top { body { opacity: 1 } } }";
    let result = apply_edits(
        source,
        &[Edit::AddFrame {
            path: "sample/layer/top/target/body/property/opacity".into(),
            offset: 0.5,
            value: "0.8".into(),
            easing: None,
        }],
    )
    .unwrap();
    let property = &result.compilation.definitions[0].layers[1].targets[0].properties[0];

    assert!(property.timing_expression.is_none());
    assert_eq!(property.keyframes.as_ref().unwrap().len(), 2);
    assert!(result.source.contains("@tween(duration: 200) layer base"));
}

#[test]
fn moving_a_transition_shorthand_preserves_its_timing_and_value_expression() {
    let source = "motion sample(amount: number) { layer machine { state idle initial { body { opacity: 1 } } transition idle -> idle when false { body { opacity: ${amount} @tween(duration: 200) } } } }";
    let result = apply_edits(
        source,
        &[Edit::Set {
            path: "sample/layer/machine/transition/0/target/body/property/opacity/frame/1/offset"
                .into(),
            value: "80%".into(),
        }],
    )
    .unwrap();

    assert!(
        result
            .source
            .contains("@tween(duration: 200) opacity { 80%: ${amount} }")
    );
}

#[test]
fn easing_a_transition_shorthand_creates_a_segment_without_replacing_timing() {
    let source = "motion sample { layer machine { state idle initial { body { opacity: 1 } } transition idle -> idle when false { body { opacity: 0.8 @tween(duration: 200) } } } }";
    let result = apply_edits(
        source,
        &[Edit::Easing {
            path: "sample/layer/machine/transition/0/target/body/property/opacity/frame/1".into(),
            value: Some("stepStart".into()),
        }],
    )
    .unwrap();
    let property = &result.compilation.definitions[0].layers[0].transitions[0]
        .transition
        .targets[0]
        .properties[0];

    assert!(property.timing_expression.is_some());
    assert!(
        property.keyframes.as_ref().unwrap()[0]
            .easing_expression
            .is_some()
    );
}

#[test]
fn typed_lifecycle_timing_creates_a_motion_level_track_for_a_layer_property() {
    let source = "motion sample { layer base { body { opacity: 1 } } }";
    let result = apply_edits(
        source,
        &[Edit::Timing {
            path: "sample/enter/target/body/property/opacity".into(),
            value: Some("tween(duration: 200)".into()),
        }],
    )
    .unwrap();

    assert!(result.compilation.definitions[0].enter.is_some());
    assert!(result.source.contains("layer base { body { opacity: 1 } }"));
    assert!(result.source.contains("@tween(duration: 200) opacity"));
}
