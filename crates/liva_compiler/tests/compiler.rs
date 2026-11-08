use liva_compiler::compile;

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
            include_str!("../../../fixtures/self-target.liv"),
            include_str!("../../../fixtures/self-target.json"),
        ),
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
            include_str!("../../../fixtures/lifecycle.liv"),
            include_str!("../../../fixtures/lifecycle.json"),
        ),
        (
            include_str!("../../../fixtures/interaction.liv"),
            include_str!("../../../fixtures/interaction.json"),
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
fn references_duplicates_and_recovery() {
    for source in [
        "motion a {}",
        "motion a { layer on {} layer on {} }",
        "motion a { layer on { t { color: red; color: blue } } }",
        "motion a { layer on { t {} t {} } }",
        "motion a { layer on { state idle initial {} transition missing -> idle when true {} } }",
        "motion a { layer on {} } motion a { layer on {} }",
    ] {
        assert!(!errors(source).is_empty(), "{source}");
    }

    let result = compile(
        "motion bad { layer on { t { x: fn( } } } motion good { layer on {} }",
        true,
    );

    assert_eq!(
        result
            .definitions
            .iter()
            .map(|definition| definition.name.as_str())
            .collect::<Vec<_>>(),
        ["good"]
    );

    let duplicate = compile("motion a { layer on {} layer on {} }", false);

    assert!(
        duplicate
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "semantic.duplicate"
                && diagnostic.related.len() == 1)
    );
}

#[test]
fn raw_css_and_byte_mappings() {
    let source = "// 😀\r\nmotion a { @tween(duration: 1000) layer on { t { --offset: var(--x, '日本語'); color: /* note */ imaginary !important; timing: var(--x, 1) } } }";
    let result = compile(source, true);

    assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
    assert_eq!(
        result.definitions[0].layers[0].targets[0].properties[1].value,
        "imaginary !important"
    );

    let range = &result.mappings.unwrap()["a/layer/on/timing"].range;

    assert_eq!(&source[range.start..range.end], "tween(duration: 1000)");
}

#[test]
fn mapping_paths_do_not_collide_with_user_names() {
    let source = "motion a { @tween(duration: 1000) layer timing { timing { timing: 0 } state general initial {} state timing { timing { timing: 1 } } @tween(duration: 2000) transition general -> timing when true { timing { @tween(duration: 3000) timing ~> {} } } } }";
    let result = compile(source, true);

    assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);

    let mappings = result.mappings.unwrap();

    for path in [
        "a/layer/timing/timing",
        "a/layer/timing/transition/0/timing",
        "a/layer/timing/transition/0/target/timing/property/timing/timing",
    ] {
        assert_eq!(mappings[path].kind, "value");
    }
}

#[test]
fn definition_names_are_unique_independently_of_parameters() {
    let result = compile(
        "motion a(value: number) { layer idle {} } motion a(flag: boolean) { layer idle {} }",
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
fn motion_states_and_non_lifecycle_transitions_have_actionable_diagnostics() {
    for (declaration, code, replacement) in [
        ("state first {}", "semantic.state-scope", "layer"),
        ("state first when true {}", "semantic.state-scope", "layer"),
        (
            "transition {}",
            "semantic.transition-scope",
            "stateful layer",
        ),
        (
            "transition first -> second {}",
            "semantic.transition-scope",
            "stateful layer",
        ),
    ] {
        let source = format!("motion a {{ layer base {{}} {declaration} }}");
        let result = compile(&source, true);

        assert!(result.definitions.is_empty());
        assert!(
            result
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == code
                    && diagnostic.message.contains(replacement)),
            "{:?}",
            result.diagnostics
        );
        assert!(
            !result
                .mappings
                .unwrap()
                .keys()
                .any(|path| path.starts_with("a/state/") || path.starts_with("a/transition/"))
        );
    }
}
