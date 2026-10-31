mod support;
use liva_compiler::{compile, ir::Timing};
use support::valid;

fn fixture(timing: &str, extra: &str) -> String {
    format!(
        "motion a {{ state off {{ t {{ translate: 0px; scale: 1 }} }} state on when true {{ t {{ translate: 24px; scale: 1 }} }} transition {{ {timing}\n {extra} }} }}"
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

fn animation(timing: &str) -> String {
    format!(
        "motion a(checked: boolean) {{ state off {{ t {{ opacity: 0 }} }} state on when checked {{ t {{ opacity: 1 }} }} transition {{ {timing}\n }} }}"
    )
}

#[test]
fn timing_longhands_are_order_independent() {
    let a = valid(&fixture(
        "@spring-mass: 2; @spring-damping: 20; @spring-stiffness: 300",
        "",
    ));
    let b = valid(&fixture(
        "@spring-stiffness: 300; @spring-damping: 20; @spring-mass: 2",
        "",
    ));

    assert_eq!(a.definitions, b.definitions);
    assert_eq!(
        a.definitions[0].general_transition.as_ref().unwrap().timing,
        Some(Timing::SpringPhysics {
            stiffness: 300.0,
            damping: 20.0,
            mass: 2.0,
        })
    );
}

#[test]
fn timing_declarations_validate_units_parameters_and_required_fields() {
    for timing in [
        "@tween: 0ms",
        "@tween: 0.25s linear(0, 0.2 50%, 1)",
        "@spring: 1s",
        "@spring: 100 10",
    ] {
        valid(&fixture(timing, ""));
    }

    for timing in [
        "@tween-easing: linear",
        "@unknown: 1ms",
        "@tween: 1ms; @tween-delay: 1ms",
        "@tween: NaNms",
        "@tween: infms",
        "@spring-bounce: .5",
        "@spring: 2 0",
        "@spring: 2 2 -1",
        "@spring: 1ms 0.2 1",
    ] {
        let source = fixture(timing, "");
        let result = compile(&source, false);

        assert!(
            result.diagnostics.iter().any(|d| d.severity == "error"),
            "{timing}"
        );
        assert!(result.definitions.is_empty(), "{timing}");
    }
}

#[test]
fn frame_rules_and_effective_inheritance() {
    for (extra, code) in [
        ("t { scale { 40%: 2; 40.0%: 3 } }", "semantic.duplicate"),
        ("t { scale { 101%: 2 } }", "semantic.offset"),
        ("t { scale { 20%: @ linear } }", "semantic.frame"),
        ("t { scale { 20%: 2 @ } }", "semantic.frame"),
    ] {
        assert!(
            errors(&fixture("@tween: 1ms", extra))
                .iter()
                .any(|error| error == code),
            "{extra}: expected {code}"
        );
    }

    let spring_frames = fixture("@spring: 1s", "t { scale { 40%: 2 } }");
    assert!(errors(&spring_frames).contains(&"semantic.spring-frames".into()));

    let inherited = fixture("@tween: 1s", "t { scale { 40%: 2 } }");
    let inherited = format!(
        "{} transition off -> on {{ @spring: 1s }} }}",
        inherited.trim_end().strip_suffix('}').unwrap()
    );
    assert!(errors(&inherited).contains(&"semantic.spring-frames".into()));

    let result = compile(
        &fixture("@tween: 1s", "t { scale { 70%: 2; 40%: 3 } }"),
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
        &fixture("@spring: 1s", "t { translate { 100%: 30px } }"),
        false,
    );
    assert_eq!(result.definitions.len(), 1);
    assert!(
        result
            .diagnostics
            .iter()
            .any(|d| d.severity == "warning" && d.code == "semantic.endpoint")
    );
}

#[test]
fn same_state_noops_do_not_require_motion_timing() {
    let source = "motion a { state off { t { scale: 1 } } state on when true { t { scale: 1 } } transition { t { scale { 40%: 2 } } } transition off -> on { @tween: 1s } transition on -> off { @tween: 1s } }";
    assert!(errors(source).is_empty());
}

#[test]
fn easing_retains_nested_and_quoted_punctuation() {
    let source = fixture("@tween: 1ms var(--curve, \"x:y;z\")", "");
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
}

#[test]
fn declaration_order_normalizes_complete_timing_families() {
    for (input, expected) in [
        (
            "@tween: 350ms ease-out; @tween-duration: 200ms",
            Timing::Tween {
                duration_ms: 200.0,
                easing: "ease-out".into(),
            },
        ),
        (
            "@tween-easing: ease-in; @tween: 0.5s",
            Timing::Tween {
                duration_ms: 500.0,
                easing: "linear".into(),
            },
        ),
        (
            "@spring: 300 20 2; @spring: 350ms 0.2",
            Timing::SpringDuration {
                duration_ms: 350.0,
                bounce: 0.2,
            },
        ),
        (
            "@spring-duration: 100ms; @spring: 300 20",
            Timing::SpringPhysics {
                stiffness: 300.0,
                damping: 20.0,
                mass: 1.0,
            },
        ),
        (
            "@spring: 350ms 0.2; @tween-duration: 200ms; @tween-easing: steps(4, end)",
            Timing::Tween {
                duration_ms: 200.0,
                easing: "steps(4, end)".into(),
            },
        ),
    ] {
        let result = valid(&animation(input));
        assert_eq!(
            result.definitions[0]
                .general_transition
                .as_ref()
                .unwrap()
                .timing
                .as_ref(),
            Some(&expected),
            "{input}"
        );
    }

    for input in [
        "@spring-duration: 100ms; @spring-stiffness: 200",
        "@spring: 300 20 1; @spring-bounce: 0.2",
        "@spring: 0ms",
        "@spring: 100ms 1",
        "@tween: -1ms",
        "@tween: 10",
    ] {
        let result = compile(&animation(input), false);
        assert!(result.definitions.is_empty(), "{input}");
    }
}

#[test]
fn inline_frames_preserve_css_easing_and_reject_springs() {
    let source = animation(
        "@tween: 100ms linear(0, 0.3 50%, 1); t { opacity { 70%: 0.8 @ steps(2, end); 40%: 0.2 @ cubic-bezier(0.2, 0.8, 0.2, 1) } }",
    );
    let result = valid(&source);
    let frames = result.definitions[0]
        .general_transition
        .as_ref()
        .unwrap()
        .targets[0]
        .properties[0]
        .keyframes
        .as_ref()
        .unwrap();
    assert_eq!(frames[0].offset, 0.4);
    assert_eq!(frames[1].easing.as_deref(), Some("steps(2, end)"));
    assert!(
        compile(
            &source.replace("@tween: 100ms linear(0, 0.3 50%, 1)", "@spring: 300 20 1"),
            false
        )
        .definitions
        .is_empty()
    );
}
