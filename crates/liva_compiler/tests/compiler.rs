use liva_compiler::{compile, ir::Timing};

fn errors(source: &str) -> Vec<String> {
    compile(source, true)
        .diagnostics
        .into_iter()
        .filter(|d| d.severity == "error")
        .map(|d| d.code)
        .collect()
}

#[test]
fn fixture_json_matches_the_public_compilation_schema() {
    for (source, expected) in [
        (
            include_str!("../../../fixtures/toggle.liv"),
            include_str!("../../../fixtures/toggle.json"),
        ),
        (
            include_str!("../../../fixtures/reactive-toggle.liv"),
            include_str!("../../../fixtures/reactive-toggle.json"),
        ),
        (
            include_str!("../../../fixtures/card.liv"),
            include_str!("../../../fixtures/card.json"),
        ),
        (
            include_str!("../../../fixtures/derived.liv"),
            include_str!("../../../fixtures/derived.json"),
        ),
        (
            include_str!("../../../fixtures/presence.liv"),
            include_str!("../../../fixtures/presence.json"),
        ),
    ] {
        let result = compile(source, false);
        assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
        let actual = serde_json::to_value(result).unwrap();
        assert_eq!(
            actual,
            serde_json::from_str::<serde_json::Value>(expected).unwrap()
        );
    }
}

#[test]
fn references_duplicates_completeness_and_recovery() {
    for source in [
        "motion a {}",
        "motion a { state on {} state on {} }",
        "motion a { state on { t { color: red; color: blue } } }",
        "motion a { state on { t {} t {} } }",
        "motion a { state on {} transition off -> on {} }",
        "motion a { state on when true { t { color: red } } state off { t {} } }",
        "motion a { state on {} transition {} transition {} }",
        "motion a { state on {} } motion a { state on {} }",
        "motion a { state on when true { t { color: red } } state off { t { color: blue } } }",
        "motion a { state on {} transition { t { color { @tween: 1ms } } } }",
    ] {
        assert!(!errors(source).is_empty(), "{source}");
    }

    let result = compile(
        "motion bad { state on { t { x: fn( } } } motion good { state on {} }",
        true,
    );
    assert_eq!(
        result
            .definitions
            .iter()
            .map(|d| d.name.as_str())
            .collect::<Vec<_>>(),
        ["good"]
    );
    let duplicate = compile("motion a { state on {} state on {} }", false);
    assert!(
        duplicate
            .diagnostics
            .iter()
            .any(|d| d.code == "semantic.duplicate" && d.related.len() == 1)
    );
}

#[test]
fn raw_css_and_byte_mappings() {
    let source = "// 😀\r\nmotion a { state on { t { --offset: var(--x, '日本語'); color: /* note */ imaginary !important; timing: var(--x, 1) } } transition { @tween-duration: 1s } }";
    let result = compile(source, true);
    assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
    assert_eq!(
        result.definitions[0].states[0].targets[0].properties[1].value,
        "imaginary !important"
    );
    let range = &result.mappings.unwrap()["a/transition/general/timing/duration"].range;
    assert_eq!(&source[range.start..range.end], " 1s ");
    assert!(matches!(
        result.definitions[0]
            .general_transition
            .as_ref()
            .unwrap()
            .timing,
        Some(Timing::Tween {
            duration_ms: 1000.0,
            ..
        })
    ));
}

#[test]
fn mapping_paths_do_not_collide_with_user_names() {
    let source = "motion a { state general { timing { timing: 0 } } state timing when true { timing { timing: 1 } } transition { @tween-duration: 1s } transition general -> timing { timing { timing { @tween-duration: 2s } } } }";
    let result = compile(source, true);
    assert!(result.diagnostics.is_empty());
    let mappings = result.mappings.unwrap();
    assert_eq!(
        mappings["a/transition/general/timing/duration"].kind,
        "value"
    );
    assert_eq!(
        mappings["a/transition/directional/general/timing"].kind,
        "block"
    );
    assert_eq!(mappings["a/transition/directional/general/timing/target/timing/property/timing/timing/duration"].kind, "value");
}

#[test]
fn definition_names_are_unique_independently_of_parameters() {
    let result = compile(
        "motion a(value: number) { state idle {} } motion a(flag: boolean) { state idle {} }",
        false,
    );

    assert!(result.definitions.is_empty());
    assert!(
        result
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "semantic.duplicate")
    );
}

#[test]
fn definitions_require_exactly_one_fallback_state() {
    for source in [
        "motion a { state first {} state second {} }",
        "motion a { state first when true {} }",
    ] {
        let result = compile(source, false);
        assert!(result.definitions.is_empty());
        assert!(
            result
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "semantic.fallback"),
            "{:?}",
            result.diagnostics
        );
    }
}
