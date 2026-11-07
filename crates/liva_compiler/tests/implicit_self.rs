mod support;

use liva_compiler::{
    compile,
    edits::{Edit, apply_edits},
};
use support::valid;

#[test]
fn every_animation_scope_lowers_direct_declarations_to_the_explicit_self_destination() {
    let declarations = "opacity: .5; @tween(duration: 120) scale ~> { 0%: .8; 100%: 1 }";
    let explicit = format!("self {{ {declarations} }}");

    for scope in [
        "@tween() layer base { BODY }",
        "@tween() layer base { BODY state off initial {} state on {} transition off -> on when true {} }",
        "@tween() layer base { state off initial { BODY } state on {} transition off -> on when true {} }",
        "layer base { opacity: 1; scale: 1; state off initial {} state on {} @tween() transition off -> on when true { BODY } }",
        "layer base {} @tween() enter { BODY }",
        "layer base {} @tween() leave { BODY }",
    ] {
        let implicit = valid(&format!(
            "motion example {{ {} }}",
            scope.replace("BODY", declarations)
        ));
        let named = valid(&format!(
            "motion example {{ {} }}",
            scope.replace("BODY", &explicit)
        ));

        assert_eq!(
            serde_json::to_value(&implicit.definitions).unwrap(),
            serde_json::to_value(&named.definitions).unwrap(),
            "{scope}"
        );
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
fn implicit_and_explicit_self_share_duplicate_property_validation() {
    for body in [
        "opacity: 1; self { opacity: .5 }",
        "self { opacity: 1 } opacity: .5",
        "opacity: 1; opacity ~> { 100%: 1 }",
        "self { opacity ~> { 100%: 1 } } opacity: .5",
    ] {
        let result = compile(
            &format!("motion example {{ @tween() layer base {{ {body} }} }}"),
            true,
        );
        let errors: Vec<_> = result
            .diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.code == "semantic.duplicate")
            .collect();

        assert!(result.definitions.is_empty(), "{body}");
        assert_eq!(errors.len(), 1, "{body}: {:?}", result.diagnostics);
        assert_eq!(errors[0].related.len(), 1);
    }
}

#[test]
fn disjoint_self_blocks_keep_each_blocks_property_timing() {
    let result = valid(
        "motion example { @tween(duration: 100) layer base { opacity: .5; @tween(duration: 200) self { scale: 1 } } }",
    );
    let target = &result.definitions[0].layers[0].targets[0];

    assert_eq!(target.properties.len(), 2);
    assert!(target.timing_expression.is_none());
    assert!(target.properties[0].timing_expression.is_none());
    assert!(target.properties[1].timing_expression.is_some());
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
fn root_fragment_timing_matches_property_timing_in_styles_and_transitions() {
    let mixed = "opacity: .5; @tween(duration: 200)\nself { scale: 1; rotate: 20deg @tween(duration: 300) }";
    let flattened =
        "opacity: .5; scale: 1 @tween(duration: 200); rotate: 20deg @tween(duration: 300)";

    for scope in [
        "@tween(duration: 100)\nlayer base { BODY }",
        "layer base {} @tween(duration: 100)\nenter { BODY }",
        "layer base {} @tween(duration: 100)\nleave { BODY }",
    ] {
        let mixed = valid(&format!(
            "motion example {{ {} }}",
            scope.replace("BODY", mixed)
        ));
        let flattened = valid(&format!(
            "motion example {{ {} }}",
            scope.replace("BODY", flattened)
        ));

        assert_eq!(mixed.definitions, flattened.definitions, "{scope}");
    }
}

#[test]
fn explicit_target_duplicates_remain_errors_after_root_fragment_merging() {
    for scope in ["layer base { BODY }", "layer base {} enter { BODY }"] {
        for declarations in [
            "self { opacity: 1 } self { scale: 1 }",
            "box { opacity: 1 } box { scale: 1 }",
        ] {
            let result = compile(
                &format!(
                    "motion example {{ {} }}",
                    scope.replace("BODY", declarations)
                ),
                true,
            );

            assert!(result.definitions.is_empty());
            assert!(
                result.diagnostics.iter().any(|diagnostic| {
                    diagnostic.code == "semantic.duplicate"
                        && diagnostic.message.starts_with("Duplicate declaration:")
                }),
                "{:?}",
                result.diagnostics
            );
        }
    }
}
