mod support;

use liva_compiler::{
    compile,
    edits::{Edit, apply_edits},
};
use support::valid;

const ANIMATION_SCOPES: &[&str] = &[
    "@tween()\nlayer base { BODY }",
    "@tween()\nlayer base { BODY state off initial {} state on {} transition off -> on when true {} }",
    "@tween()\nlayer base { state off initial { BODY } state on {} transition off -> on when true {} }",
    "layer base { opacity: 1; scale: 1; state off initial {} state on {} @tween()\ntransition off -> on when true { BODY } }",
    "layer base {} @tween()\nenter { BODY }",
    "layer base {} @tween()\nleave { BODY }",
];

#[test]
fn every_animation_scope_lowers_direct_declarations_to_the_implicit_root() {
    for scope in ANIMATION_SCOPES {
        let result = valid(&format!(
            "motion example {{ {} }}",
            scope.replace("BODY", "opacity: .5; scale ~> { 100%: 1 }")
        ));
        let mappings = result.mappings.unwrap();
        let root = mappings.iter().find(|(path, mapping)| {
            path.strip_suffix("/target/self").is_some_and(|parent| {
                mapping.range == mappings[parent].range
                    && mappings.contains_key(&format!("{path}/property/opacity"))
                    && !mappings.contains_key(&format!("{path}/timing"))
            })
        });

        assert!(root.is_some(), "{scope}");
    }
}

#[test]
fn explicit_self_blocks_are_rejected_in_every_animation_scope() {
    for scope in ANIMATION_SCOPES {
        let result = compile(
            &format!(
                "motion example {{ {} }}",
                scope.replace("BODY", "self { opacity: .5 }")
            ),
            true,
        );
        let error = result
            .diagnostics
            .iter()
            .find(|diagnostic| diagnostic.message.contains("implicit target"));

        assert!(result.definitions.is_empty(), "{scope}");
        let error = error.unwrap();
        assert_eq!(error.code, "semantic.variable");
        assert_eq!(error.range.end - error.range.start, "self".len());
    }
}

#[test]
fn self_is_available_to_target_functions_and_cannot_be_shadowed() {
    valid(
        "motion example { let movement = drag(target: self); layer base { translate: ${movement.offset.x}px 0 } }",
    );

    for source in [
        "motion example(self: boolean) { layer base {} }",
        "motion example { let self = 1; layer base {} }",
    ] {
        let result = compile(source, true);

        assert!(result.definitions.is_empty());
        assert!(
            result
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.message.contains("self"))
        );
    }
}

#[test]
fn target_names_css_properties_and_custom_tracks_are_distinguished_by_delimiters() {
    let result = valid(
        "motion example { @tween() layer base { opacity: .5; opacity { opacity: 1 } @tween() --future-property ~> { 0%: 0; 100%: 1 } } }",
    );
    let layer = &result.definitions[0].layers[0];

    assert_eq!(
        layer
            .targets
            .iter()
            .map(|target| target.name.as_str())
            .collect::<Vec<_>>(),
        ["self", "opacity"]
    );
    assert_eq!(layer.targets[0].properties[1].name, "--future-property");
    assert_eq!(layer.targets[1].properties[0].name, "opacity");
}

#[test]
fn duplicate_implicit_root_properties_are_rejected_in_every_animation_scope() {
    for scope in ANIMATION_SCOPES {
        for body in [
            "opacity: 1; opacity: .5",
            "opacity: 1; opacity ~> { 100%: 1 }",
        ] {
            let result = compile(
                &format!("motion example {{ {} }}", scope.replace("BODY", body)),
                true,
            );
            let errors: Vec<_> = result
                .diagnostics
                .iter()
                .filter(|diagnostic| diagnostic.code == "semantic.duplicate")
                .collect();

            assert!(result.definitions.is_empty(), "{scope}: {body}");
            assert_eq!(errors.len(), 1, "{:?}", result.diagnostics);
            assert_eq!(errors[0].related.len(), 1);
        }
    }
}

#[test]
fn editor_track_edits_preserve_implicit_self_and_surrounding_source() {
    let source = "// 日本語 😀\r\nmotion example { @tween() layer base { opacity: 1 /* untouched */ } @tween() enter { scale: .8 } }\r\n";
    let result = apply_edits(
        source,
        &[Edit::AddFrame {
            path: "example/enter/target/self/property/scale".into(),
            offset: 0.5,
            value: "1.1".into(),
            easing: Some("easeOut".into()),
        }],
    )
    .unwrap();

    assert!(result.source.contains("scale ~> {"));
    assert!(!result.source.contains("self {"));
    assert!(result.source.contains("opacity: 1 /* untouched */"));
    assert!(result.source.ends_with("\r\n"));

    let range = &result.compilation.mappings.unwrap()["example/enter/target/self/property/scale/frame/0.5/value"].range;

    assert_eq!(result.source[range.start..range.end].trim(), "1.1");
}

#[test]
fn implicit_root_properties_keep_their_own_timing_in_styles_and_transitions() {
    for scope in [
        "@tween(duration: 100)\nlayer base { BODY }",
        "layer base {} @tween(duration: 100)\nenter { BODY }",
        "layer base {} @tween(duration: 100)\nleave { BODY }",
    ] {
        let result = valid(&format!(
            "motion example {{ {} }}",
            scope.replace("BODY", "opacity: .5; scale: 1 @tween(duration: 200)")
        ));
        let definition = &result.definitions[0];
        let (timing, properties): (_, Vec<_>) =
            if let Some(transition) = definition.enter.as_ref().or(definition.leave.as_ref()) {
                let target = &transition.targets[0];
                (
                    &target.timing_expression,
                    target
                        .properties
                        .iter()
                        .map(|property| &property.timing_expression)
                        .collect(),
                )
            } else {
                let target = &definition.layers[0].targets[0];
                (
                    &target.timing_expression,
                    target
                        .properties
                        .iter()
                        .map(|property| &property.timing_expression)
                        .collect(),
                )
            };

        assert!(timing.is_none());
        assert!(properties[0].is_none());
        assert!(properties[1].is_some());
    }
}

#[test]
fn explicit_named_target_duplicates_remain_errors() {
    for scope in ["layer base { BODY }", "layer base {} enter { BODY }"] {
        let result = compile(
            &format!(
                "motion example {{ {} }}",
                scope.replace("BODY", "box { opacity: 1 } box { scale: 1 }")
            ),
            true,
        );

        assert!(result.definitions.is_empty());
        assert!(
            result
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "semantic.duplicate"
                    && diagnostic.related.len() == 1)
        );
    }
}
