use liva_compiler::{compile, ir::Timing};

fn fixture(timing: &str, extra: &str) -> String {
    format!(
        "motion a {{ state off {{ t {{ translate: 0px; scale: 1 }} }} state on when true {{ t {{ translate: 24px; scale: 1 }} }} transition {{ timing: {timing}\n {extra} }} }}"
    )
}

fn errors(source: &str) -> Vec<String> {
    compile(source, true)
        .diagnostics
        .into_iter()
        .filter(|d| d.severity == "error")
        .map(|d| d.code)
        .collect()
}

#[test]
fn golden_is_deterministic_and_has_no_development_data() {
    let result = compile(include_str!("../../../fixtures/toggle.liv"), false);
    assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
    let actual = serde_json::to_string_pretty(&result).unwrap();
    assert_eq!(
        actual.trim(),
        include_str!("../../../fixtures/toggle.json").trim()
    );
    assert!(!actual.contains("mappings"));
    assert!(!actual.contains("range"));
}

#[test]
fn timing_signatures_and_argument_order() {
    let a = compile(
        &fixture("spring(mass: 2, damping: 20, stiffness: 300)", ""),
        false,
    );
    let b = compile(
        &fixture("spring(stiffness: 300, damping: 20, mass: 2,)", ""),
        false,
    );
    assert!(a.diagnostics.is_empty());
    assert_eq!(a.definitions, b.definitions);

    for timing in [
        "tween(duration: 0ms)",
        "tween(duration: 0.25s, easing: linear(0, 0.2 50%, 1))",
        "spring(duration: 1s)",
        "spring(damping: 10, stiffness: 100)",
    ] {
        assert!(errors(&fixture(timing, "")).is_empty(), "{timing}");
    }

    for timing in [
        "tween()",
        "unknown(duration: 1ms)",
        "tween(duration: 1ms, duration: 2ms)",
        "tween(duration: 1ms, delay: 1ms)",
        "tween(duration: -1ms)",
        "tween(duration: NaNms)",
        "tween(duration: infms)",
        "tween(duration: 1)",
        "tween(duration: 1ms easing: linear)",
        "tween(duration: 1ms; easing: linear)",
        "tween(easing: linear duration: 1ms)",
        "spring()",
        "spring(duration: 0ms)",
        "spring(duration: 1ms, bounce: 1)",
        "spring(bounce: .5)",
        "spring(stiffness: 2, damping: 0)",
        "spring(stiffness: 2, damping: 2, mass: -1)",
        "spring(duration: 1ms, stiffness: 1)",
        "tween(duration: 1ms) trailing",
    ] {
        assert!(!errors(&fixture(timing, "")).is_empty(), "{timing}");
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
        "motion a { state on {} transition { t { color { timing: tween(duration: 1ms) } } } }",
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
fn frame_rules_and_effective_inheritance() {
    for extra in [
        "t { scale { 40% { value: 2 } 40.0% { value: 3 } } }",
        "t { scale { 101% { value: 2 } } }",
        "t { scale { 20% { easing: linear } } }",
        "t { scale { 20% { value: 2; unknown: x } } }",
    ] {
        assert!(!errors(&fixture("tween(duration: 1ms)", extra)).is_empty());
    }

    let spring_frames = fixture("spring(duration: 1s)", "t { scale { 40% { value: 2 } } }");
    assert!(errors(&spring_frames).contains(&"semantic.spring-frames".into()));
    let inherited = fixture("tween(duration: 1s)", "t { scale { 40% { value: 2 } } }");
    let inherited = format!(
        "{} transition off -> on {{ timing: spring(duration: 1s) }} }}",
        inherited.trim_end().strip_suffix('}').unwrap()
    );
    assert!(errors(&inherited).contains(&"semantic.spring-frames".into()));

    let result = compile(
        &fixture(
            "tween(duration: 1s)",
            "t { scale { 70% { value: 2 } 40% { value: 3 } } }",
        ),
        false,
    );
    assert!(result.diagnostics.is_empty());
    let frames = result.definitions[0]
        .general_transition
        .as_ref()
        .unwrap()
        .targets[0]
        .properties[0]
        .keyframes
        .as_ref()
        .unwrap();
    assert_eq!(
        frames.iter().map(|f| f.offset).collect::<Vec<_>>(),
        [0.4, 0.7]
    );

    let result = compile(
        &fixture(
            "spring(duration: 1s)",
            "t { translate { 100% { value: 30px } } }",
        ),
        false,
    );
    assert_eq!(result.definitions.len(), 1);
    assert!(result.diagnostics.iter().any(|d| d.severity == "warning"));
}

#[test]
fn raw_css_and_byte_mappings() {
    let source = "// 😀\r\nmotion a { state on { t { --offset: var(--x, '日本語'); color: /* note */ imaginary !important; timing: var(--x, 1) } } transition { timing: tween(duration: 1s) } }";
    let result = compile(source, true);
    assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
    assert_eq!(
        result.definitions[0].states[0].targets[0].properties[1].value,
        "imaginary !important"
    );
    let range = &result.mappings.unwrap()["a/transition/general/timing/duration"].range;
    assert_eq!(&source[range.start..range.end], " 1s");
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
fn same_state_noops_do_not_require_motion_timing() {
    let source = "motion a { state off { t { scale: 1 } } state on when true { t { scale: 1 } } transition { t { scale { 40% { value: 2 } } } } transition off -> on { timing: tween(duration: 1s) } transition on -> off { timing: tween(duration: 1s) } }";
    assert!(errors(source).is_empty());
}

#[test]
fn mapping_paths_do_not_collide_with_user_names() {
    let source = "motion a { state general { timing { timing: 0 } } state timing when true { timing { timing: 1 } } transition { timing: tween(duration: 1s) } transition general -> timing { timing { timing { timing: tween(duration: 2s) } } } }";
    let result = compile(source, true);
    assert!(result.diagnostics.is_empty());
    let mappings = result.mappings.unwrap();
    assert_eq!(mappings["a/transition/general/timing"].kind, "value");
    assert_eq!(
        mappings["a/transition/directional/general/timing"].kind,
        "block"
    );
    assert_eq!(mappings["a/transition/directional/general/timing/target/timing/property/timing/timing/duration"].kind, "value");
}

#[test]
fn easing_retains_nested_and_quoted_punctuation() {
    let source = fixture("tween(duration: 1ms, easing: var(--curve, \"x:y;z\"))", "");
    let result = compile(&source, false);
    assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
    let timing = result.definitions[0]
        .general_transition
        .as_ref()
        .unwrap()
        .timing
        .as_ref()
        .unwrap();
    assert!(matches!(timing, Timing::Tween { easing, .. } if easing == "var(--curve, \"x:y;z\")"));
    assert!(!errors(&fixture("tween(duration: 1ms, easing: linear;)", "")).is_empty());
}
