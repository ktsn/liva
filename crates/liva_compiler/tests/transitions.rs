mod support;
use liva_compiler::compile;
use support::valid;

fn fixture(timing: &str, extra: &str) -> String {
    format!(
        "motion a(active: boolean) {{ layer main {{ state off initial {{ t {{ translate: 0px; scale: 1 }} }} state on {{ t {{ translate: 24px; scale: 1 }} }} {timing} transition off -> on when active {{ {extra} }} }} }}"
    )
}

#[test]
fn property_style_timing_is_rejected_at_every_scope() {
    for declaration in [
        "@tween: 200ms ease-in",
        "@spring: 300 20",
        "@tween-duration: 200ms",
        "@tween-easing: ease-in",
        "@spring-duration: 200ms",
        "@spring-bounce: 0.2",
        "@spring-stiffness: 300",
        "@spring-damping: 20",
        "@spring-mass: 1",
    ] {
        let sources = [
            format!("motion a {{ {declaration}; layer base {{ t {{ opacity: 1 }} }} }}"),
            format!("motion a {{ layer base {{ {declaration}; t {{ opacity: 1 }} }} }}"),
            format!("motion a {{ layer base {{ t {{ {declaration}; opacity: 1 }} }} }}"),
            format!("motion a {{ layer base {{ t {{ opacity {{ {declaration}; 100%: 1 }} }} }} }}"),
            fixture("", &format!("{declaration};")),
            fixture("", &format!("t {{ {declaration}; }}")),
            fixture("", &format!("t {{ scale {{ {declaration}; 50%: 2 }} }}")),
            format!(
                "motion a {{ layer base {{ t {{ opacity: 1 }} }} enter {{ {declaration}; }} }}"
            ),
        ];

        for source in sources {
            let result = compile(&source, true);

            assert!(result.definitions.is_empty(), "{source}");
            assert!(
                result
                    .diagnostics
                    .iter()
                    .any(|diagnostic| { diagnostic.code == "semantic.declaration" }),
                "{source}: {:?}",
                result.diagnostics
            );
        }
    }
}

#[test]
fn transition_frames_reject_duplicate_and_out_of_range_offsets() {
    for (frames, code) in [
        ("40%: 2; 40.0%: 3", "semantic.duplicate"),
        ("101%: 2", "semantic.offset"),
    ] {
        let source = fixture(
            "@tween(duration: 100)",
            &format!("t {{ scale {{ {frames} }} }}"),
        );
        let result = compile(&source, false);

        assert!(result.definitions.is_empty());
        assert!(
            result
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == code)
        );
    }
}

#[test]
fn typed_spring_transition_keeps_sorted_intermediate_frames() {
    let result = valid(&fixture(
        "@spring(duration: 1000, bounce: 0.2)",
        "t { scale { 70%: 2; 40%: 3 } }",
    ));
    let frames = result.definitions[0].layers[0].transitions[0]
        .transition
        .targets[0]
        .properties[0]
        .keyframes
        .as_ref()
        .unwrap();

    assert_eq!(
        frames.iter().map(|frame| frame.offset).collect::<Vec<_>>(),
        [0.4, 0.7]
    );
}

#[test]
fn raw_easing_suffixes_are_rejected_in_every_track_kind() {
    for easing in [
        "@ ease-in",
        "@ cubic-bezier(0.2, 0, 0.8, 1)",
        "@ease-in",
        "@cubic-bezier(0.2, 0, 0.8, 1)",
    ] {
        let sources = [
            fixture(
                "@tween(duration: 100)",
                &format!("t {{ scale {{ 50%: 2 {easing} }} }}"),
            ),
            format!(
                "motion a {{ layer base {{ t {{ @tween(duration: 100) opacity {{ 50%: 0.5 {easing}; 100%: 1 }} }} }} }}"
            ),
            format!(
                "motion a {{ layer base {{ t {{ opacity: 1 }} }} @tween(duration: 100) enter {{ t {{ opacity {{ 50%: 0.5 {easing} }} }} }} }}"
            ),
            format!(
                "motion a {{ layer base {{ t {{ opacity: 1 }} }} @tween(duration: 100) leave {{ t {{ opacity {{ 50%: 0.5 {easing} }} }} }} }}"
            ),
        ];

        for source in sources {
            let result = compile(&source, false);

            assert!(result.definitions.is_empty(), "{source}");
            assert!(
                result
                    .diagnostics
                    .iter()
                    .any(|diagnostic| diagnostic.severity == "error"),
                "{source}"
            );
        }
    }
}

#[test]
fn typed_easing_is_preserved_as_an_expression() {
    let result = valid(&fixture(
        "@tween(duration: 100)",
        "t { scale { 70%: 2 @steps(count: 2, position: 'end'); 40%: 3 @easeIn } }",
    ));
    let frames = result.definitions[0].layers[0].transitions[0]
        .transition
        .targets[0]
        .properties[0]
        .keyframes
        .as_ref()
        .unwrap();

    assert_eq!(frames[0].offset, 0.4);
    assert_eq!(
        serde_json::to_value(&frames[0].easing_expression).unwrap(),
        serde_json::json!({"kind": "reference", "path": ["easeIn"]})
    );
    assert!(frames[1].easing_expression.is_some());
    assert!(frames.iter().all(|frame| frame.easing.is_none()));
}

#[test]
fn quoted_and_nested_at_characters_remain_css_values() {
    for value in [
        "'contact@example.com'",
        "url('https://example.com/@icon.svg')",
        "var(--value, '@ ease-in')",
        "'${\"@\"}'",
    ] {
        let result = valid(&fixture(
            "@tween(duration: 100)",
            &format!("t {{ scale {{ 50%: {value} }} }}"),
        ));
        let frames = result.definitions[0].layers[0].transitions[0]
            .transition
            .targets[0]
            .properties[0]
            .keyframes
            .as_ref()
            .unwrap();

        assert_eq!(frames[0].value, value);
        assert!(frames[0].easing_expression.is_none());
    }
}
