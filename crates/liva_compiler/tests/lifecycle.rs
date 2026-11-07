#[path = "support/declarations.rs"]
mod declarations;
mod support;

use declarations::{assert_error, assert_recovers, motion};
use liva_compiler::{
    compile,
    ir::{Definition, Transition},
};
use support::valid;

fn animation<'a>(definition: &'a Definition, phase: &str) -> &'a Transition {
    match phase {
        "enter" => definition.enter.as_ref().unwrap(),
        "leave" => definition.leave.as_ref().unwrap(),
        _ => panic!("Unknown phase: {phase}"),
    }
}

#[test]
fn lifecycle_blocks_normalize_timing_frames_and_property_overrides() {
    for phase in ["enter", "leave"] {
        let source = motion(&format!(
            "@tween(duration: 250, easing: easeOut) {phase} {{
              body {{
                opacity {{ 100%: 0; 40%: 0.5 @easeIn; 0%: 1 }}
                @spring(stiffness: 300, damping: 20) translate {{ 100%: 300px 0 }}
              }}
              badge {{ @spring(duration: 350, bounce: 0.2) opacity {{ 0%: 0 }} }}
            }}"
        ));
        let result = valid(&source);
        let animation = animation(&result.definitions[0], phase);

        assert!(animation.timing_expression.is_some());
        assert_eq!(
            animation
                .targets
                .iter()
                .map(|target| target.name.as_str())
                .collect::<Vec<_>>(),
            ["body", "badge"]
        );
        let opacity = animation.property("body", "opacity").unwrap();
        let frames = opacity.keyframes.as_ref().unwrap();
        assert!(opacity.timing.is_none());
        assert_eq!(
            frames.iter().map(|frame| frame.offset).collect::<Vec<_>>(),
            [0.0, 0.4, 1.0]
        );
        assert!(frames[1].easing_expression.is_some());
        assert!(
            animation
                .property("body", "translate")
                .unwrap()
                .timing_expression
                .is_some()
        );
        assert!(
            animation
                .property("badge", "opacity")
                .unwrap()
                .timing_expression
                .is_some()
        );
        assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
    }
}

#[test]
fn lifecycle_definitions_keep_missing_endpoints_unresolved() {
    for phase in ["enter", "leave"] {
        for (frames, offsets) in [
            ("", vec![]),
            ("0%: 0", vec![0.0]),
            ("100%: 0", vec![1.0]),
            ("0%: 0; 100%: 1", vec![0.0, 1.0]),
        ] {
            let result = valid(&motion(&format!(
                "{phase} {{ body {{ @tween(duration: 0) opacity {{ {frames} }} }} }}"
            )));
            let property = animation(&result.definitions[0], phase)
                .property("body", "opacity")
                .unwrap();

            assert_eq!(
                property
                    .keyframes
                    .as_ref()
                    .map(|frames| frames.iter().map(|frame| frame.offset).collect::<Vec<_>>())
                    .unwrap_or_default(),
                offsets
            );
            assert_eq!(property.keyframes.is_none(), frames.is_empty());
        }
    }
}

#[test]
fn lifecycle_phases_have_independent_timing() {
    let result = valid(&motion(
        "@tween(duration: 30) enter { body { opacity: 0 } }
@tween(duration: 40) leave { body { opacity: 0 } }",
    ));
    let definition = &result.definitions[0];

    assert_ne!(
        animation(definition, "enter").timing_expression,
        animation(definition, "leave").timing_expression
    );

    for phase in ["enter", "leave"] {
        assert_error(
            &format!("{phase} {{ body {{ «opacity» {{ 0%: 0 }} }} }}"),
            "semantic.timing-missing",
        );
    }
}

#[test]
fn lifecycle_errors_report_exact_source_ranges_for_both_phases() {
    for phase in ["enter", "leave"] {
        for (body, code) in [
            ("«missing» { opacity: 0 }", "semantic.reference"),
            ("body {} «body» {}", "semantic.duplicate"),
            ("body { opacity {} «opacity» {} }", "semantic.duplicate"),
            (
                "body { opacity { 40%: 0; «40.0%»: 1 } }",
                "semantic.duplicate",
            ),
            ("body { opacity { «101%»: 0 } }", "semantic.offset"),
            ("body { opacity { «-1%»: 0 } }", "semantic.offset"),
        ] {
            assert_error(&format!("@tween(duration: 1) {phase} {{ {body} }}"), code);
        }

        let duplicate = assert_error(
            &format!("{phase} {{}} «{phase}» {{}}"),
            "semantic.duplicate",
        );
        let source = motion(&format!("{phase} {{}} {phase} {{}}"));

        assert_eq!(duplicate.related.len(), 1);
        assert_eq!(
            &source[duplicate.related[0].start..duplicate.related[0].end],
            phase
        );
    }
}

#[test]
fn property_tween_can_override_global_spring_for_intermediate_frames() {
    for phase in ["enter", "leave"] {
        let result = valid(&motion(&format!(
            "@spring(stiffness: 300, damping: 20) {phase} {{ body {{ @tween(duration: 100) opacity {{ 50%: 0.5 @easeIn }} }} }}"
        )));
        assert!(result.diagnostics.is_empty());
    }
}

#[test]
fn lifecycle_mappings_retain_utf8_byte_ranges_in_each_phase() {
    for phase in ["enter", "leave"] {
        let source = motion(&format!(
            "@tween(duration: 250, easing: easeOut) {phase} {{ body {{ opacity {{ 0%: 0 @easeIn }} }} }}"
        ));
        let result = valid(&source);
        let mappings = result.mappings.unwrap();

        for (suffix, expected) in [
            (
                "",
                format!(
                    "@tween(duration: 250, easing: easeOut) {phase} {{ body {{ opacity {{ 0%: 0 @easeIn }} }} }}"
                ),
            ),
            ("/target/body/property/opacity/frame/0/offset", "0%".into()),
            ("/target/body/property/opacity/frame/0/value", " 0 ".into()),
            (
                "/target/body/property/opacity/frame/0/easing",
                "easeIn ".into(),
            ),
        ] {
            let range = &mappings[&format!("a/{phase}{suffix}")].range;
            assert_eq!(&source[range.start..range.end], expected);
        }
    }
}

#[test]
fn empty_and_absent_lifecycle_blocks_remain_distinct_in_json() {
    for body in ["", "enter {} leave {}"] {
        let result = compile(&motion(body), false);
        assert!(result.diagnostics.is_empty());
        let json = serde_json::to_value(&result.definitions[0]).unwrap();

        for phase in ["enter", "leave"] {
            if body.is_empty() {
                assert!(json.get(phase).is_none());
            } else {
                assert_eq!(json[phase], serde_json::json!({"targets": []}));
            }
        }
        assert!(json.get("events").is_none());
    }
}

#[test]
fn malformed_lifecycle_blocks_do_not_suppress_later_valid_motions() {
    for phase in ["enter", "leave"] {
        for body in [
            "",
            "invalid {}",
            "idle -> active {}",
            "{ body { @tween(duration: 1) opacity { 101%: 0 } } }",
        ] {
            assert_recovers(&format!("{phase} {body}"));
        }
    }
}

#[test]
fn shorthand_normalizes_to_endpoint_frames_including_css_templates() {
    for (phase, offset) in [("enter", 0), ("leave", 100)] {
        for value in [
            "0",
            "${amount}",
            "calc(${amount}px + 2px)",
            "var(--fade, 0)",
        ] {
            let shorthand = valid(&motion(&format!(
                "@tween(duration: 20) {phase} {{ body {{ opacity: {value} }} }}"
            )));
            let explicit = valid(&motion(&format!(
                "@tween(duration: 20) {phase} {{ body {{ opacity {{ {offset}%: {value} }} }} }}"
            )));
            assert_eq!(shorthand.definitions, explicit.definitions);
        }
        let result = valid(&motion(&format!(
            "@tween(duration: 20) {phase} {{ body {{ opacity: 0; translate {{ 50%: 5px 0 @easeOut }} }} }}"
        )));
        assert_eq!(
            animation(&result.definitions[0], phase).targets[0]
                .properties
                .len(),
            2
        );
    }
}

#[test]
fn lifecycle_property_duplicates_are_reported_in_source_order() {
    for phase in ["enter", "leave"] {
        for declarations in [
            "opacity: 0; «opacity»: 1",
            "opacity: 0; «opacity» { 50%: 0.5 }",
            "opacity { 50%: 0.5 } «opacity»: 0",
        ] {
            let error = assert_error(
                &format!("@tween(duration: 1) {phase} {{ body {{ {declarations} }} }}"),
                "semantic.duplicate",
            );
            assert_eq!(error.related.len(), 1);
        }
        assert_error(
            &format!("@tween(duration: 1) {phase} {{ body {{ translate: ${{«missing»}}px 0 }} }}"),
            "semantic.expression",
        );
    }
}

#[test]
fn lifecycle_headers_reject_extra_selectors() {
    for phase in ["enter", "leave"] {
        let source = motion(&format!(
            "@tween(duration: 30) {phase} idle {{ body {{ opacity: 0 }} }}"
        ));
        let result = compile(&source, true);
        let diagnostic = result
            .diagnostics
            .iter()
            .find(|diagnostic| diagnostic.code == "semantic.structure")
            .unwrap();

        assert!(diagnostic.message.contains("enter { ... }"));
        assert!(result.definitions.is_empty());
    }
}

#[test]
fn lifecycle_shorthand_maps_values_to_their_original_source() {
    for (phase, offset) in [("enter", 0), ("leave", 1)] {
        let source = motion(&format!(
            "@tween(duration: 20) {phase} {{ body {{ translate: ${{amount}}px 0 }} }}"
        ));
        let result = valid(&source);
        let mappings = result.mappings.unwrap();
        let range = &mappings
            [&format!("a/{phase}/target/body/property/translate/frame/{offset}/value")]
            .range;
        assert_eq!(source[range.start..range.end].trim(), "${amount}px 0");
    }
}
