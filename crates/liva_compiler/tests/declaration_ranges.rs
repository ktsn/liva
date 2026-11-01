use liva_compiler::compile;
use liva_syntax::Range;

fn marked_source(marked: &str) -> (String, Range, Vec<Range>) {
    let mut source = String::new();
    let mut primary_start = None;
    let mut primary = None;
    let mut related_start = None;
    let mut related = Vec::new();

    for ch in marked.chars() {
        match ch {
            '«' => primary_start = Some(source.len()),
            '»' => {
                primary = Some(Range {
                    start: primary_start.take().unwrap(),
                    end: source.len(),
                })
            }
            '‹' => related_start = Some(source.len()),
            '›' => related.push(Range {
                start: related_start.take().unwrap(),
                end: source.len(),
            }),
            _ => source.push(ch),
        }
    }

    (source, primary.unwrap(), related)
}

fn assert_diagnostic(marked: &str, code: &str, message: &str) {
    for marked in [
        marked.to_string(),
        format!("// 日本😀\r\n{}", marked.replace('\n', "\r\n")),
    ] {
        let (source, range, related) = marked_source(&marked);

        for development in [false, true] {
            let result = compile(&source, development);
            let diagnostics: Vec<_> = result
                .diagnostics
                .iter()
                .filter(|d| d.code == code && d.message.contains(message))
                .collect();

            assert_eq!(diagnostics.len(), 1, "{marked}: {:#?}", result.diagnostics);
            assert_eq!(
                diagnostics[0].severity,
                if code == "semantic.endpoint" {
                    "warning"
                } else {
                    "error"
                }
            );
            assert_eq!(diagnostics[0].range, range, "{marked}");
            assert_eq!(diagnostics[0].related, related, "{marked}");

            for d in &result.diagnostics {
                for range in std::iter::once(&d.range).chain(&d.related) {
                    assert!(
                        range.start <= range.end && range.end <= source.len(),
                        "{marked}: {d:?}"
                    );
                    assert!(
                        source.is_char_boundary(range.start) && source.is_char_boundary(range.end)
                    );
                }
            }
        }
    }
}

#[test]
fn identifiers_and_duplicate_declarations_use_names_and_related_names() {
    for (source, code, message) in [
        (
            "motion a(x«») { state idle {} }",
            "semantic.type",
            "Expected primitive",
        ),
        (
            "motion a(x:«») { state idle {} }",
            "semantic.type",
            "Expected primitive",
        ),
        (
            "motion a(«»: number) { state idle {} }",
            "semantic.parameter",
            "Invalid parameter",
        ),
        (
            "motion a(«true»: number) { state idle {} }",
            "semantic.parameter",
            "Invalid parameter",
        ),
        (
            "motion a { let «true» = 1; state idle {} }",
            "semantic.binding",
            "Invalid let",
        ),
        (
            "motion a { state idle { «true» { x: 0 } } }",
            "semantic.variable",
            "Target variables",
        ),
        (
            "motion ‹a› { state idle {} } motion «a» { state idle {} }",
            "semantic.duplicate",
            "Duplicate declaration",
        ),
        (
            "motion a(‹x›: number, «x»: number) { state idle {} }",
            "semantic.duplicate",
            "Duplicate declaration",
        ),
        (
            "motion a { let ‹x› = 1; let «x» = 2; state idle {} }",
            "semantic.duplicate",
            "Duplicate declaration",
        ),
        (
            "motion a { state ‹idle› {} state «idle» when true {} }",
            "semantic.duplicate",
            "Duplicate declaration",
        ),
        (
            "motion a { state idle { ‹t› { x: 0 } «t» { x: 0 } } }",
            "semantic.duplicate",
            "Duplicate declaration",
        ),
        (
            "motion a { state idle { t { ‹x›: 0; «x»: 1 } } }",
            "semantic.duplicate",
            "Duplicate declaration",
        ),
        (
            "motion a { state idle {} ‹transition› {} «transition» {} }",
            "semantic.duplicate",
            "Duplicate declaration",
        ),
        (
            "motion a { state idle {} ‹transition idle -> idle› {} «transition idle -> idle» {} }",
            "semantic.duplicate",
            "Duplicate declaration",
        ),
        (
            "motion a { state idle { t { x: 0 } } transition { ‹t› {} «t» {} } }",
            "semantic.duplicate",
            "Duplicate declaration",
        ),
        (
            "motion a { state idle { t { x: 0 } } transition { t { ‹x› {} «x» {} } } }",
            "semantic.duplicate",
            "Duplicate declaration",
        ),
        (
            "motion a(‹x›: number) { let «x» = 1; state idle {} }",
            "semantic.duplicate",
            "Duplicate variable",
        ),
        (
            "motion a(‹t›: number) { state idle { «t» { x: 0 } } }",
            "semantic.duplicate",
            "Duplicate variable",
        ),
        (
            "motion a { let «t» = 1; state idle { ‹t› { x: 0 } } }",
            "semantic.duplicate",
            "Duplicate variable",
        ),
    ] {
        assert_diagnostic(source, code, message);
    }
}

#[test]
fn declarations_and_structure_errors_point_to_the_misplaced_item() {
    for (source, code, message) in [
        (
            "«unknown»: 1; motion a { state idle {} }",
            "semantic.declaration",
            "Unknown declaration",
        ),
        (
            "motion a { «unknown»: 1; state idle {} }",
            "semantic.declaration",
            "Unknown declaration",
        ),
        (
            "motion a { state idle { «unknown»: 1 } }",
            "semantic.declaration",
            "Unknown declaration",
        ),
        (
            "motion a { state idle {} transition { t { «unknown»: 1 } } }",
            "semantic.declaration",
            "Unknown declaration",
        ),
        (
            "motion a { state idle {} transition { «@unknown»: 1 } }",
            "semantic.declaration",
            "Unknown animation",
        ),
        (
            "motion a { state idle {} transition { «@tween-delay»: 1ms } }",
            "semantic.declaration",
            "Unknown animation",
        ),
        (
            "motion a { state idle { t { x:«» } } }",
            "semantic.value",
            "Value must not be empty",
        ),
        (
            "motion a { state idle { t { x:«»/* 😀 */ } } }",
            "semantic.value",
            "Value must not be empty",
        ),
        (
            "motion a { state idle { «let x = 1»; } }",
            "semantic.structure",
            "Let declarations",
        ),
        (
            "motion a { state idle {} transition { «let x = 1»; } }",
            "semantic.structure",
            "Let declarations",
        ),
        (
            "motion a { state idle {} transition { «40%»: 1 } }",
            "semantic.structure",
            "Keyframes belong",
        ),
        (
            "motion a { state idle { t { «nested» { x: 0 } } } }",
            "semantic.structure",
            "State targets",
        ),
        (
            "motion a { state idle {} «unknown block» {} }",
            "semantic.structure",
            "Expected state",
        ),
        (
            "motion a { state idle {} «transition broken» {} }",
            "semantic.structure",
            "Expected state",
        ),
        (
            "motion a { state idle { t { x: 0 } } transition { t { x { «unexpected» {} } } } }",
            "semantic.structure",
            "Property tracks",
        ),
    ] {
        assert_diagnostic(source, code, message);
    }
}

#[test]
fn timing_errors_point_to_values_fields_or_missing_field_owners() {
    for (timing, code, message) in [
        ("@tween: «-1ms»", "semantic.number", "duration"),
        ("@tween: «10»", "semantic.number", "duration"),
        (
            "@tween-duration: /* 😀 */ «NaNms» /* tail */",
            "semantic.number",
            "duration",
        ),
        ("@spring: «0ms»", "semantic.number", "duration"),
        ("@spring: 1s «1»", "semantic.bounce", "Bounce"),
        ("@spring: 1s «-0.1»", "semantic.number", "bounce"),
        ("@spring: «0» 20", "semantic.number", "stiffness"),
        ("@spring: 300 /* 😀 */ «0» 1", "semantic.number", "damping"),
        ("@spring: 300 20 «-1»", "semantic.number", "mass"),
        (
            "@spring: 300 20 1 «2 3»",
            "semantic.timing",
            "Invalid spring",
        ),
        ("@spring:«»", "semantic.timing", "Invalid spring"),
        ("«@spring»: 300", "semantic.number", "damping"),
        ("«@tween-easing»: linear", "semantic.number", "duration"),
        (
            "@tween-duration: 1s; @tween-easing:«»",
            "semantic.easing",
            "Easing",
        ),
        (
            "@spring-duration: 1s; «@spring-stiffness»: 300",
            "semantic.argument",
            "stiffness",
        ),
        (
            "@spring: 300 20; @spring-damping: «0»",
            "semantic.number",
            "damping",
        ),
        (
            "@tween: 1s; @spring: 1s /* 😀 */ «1» /* tail */",
            "semantic.bounce",
            "Bounce",
        ),
    ] {
        for body in [
            format!("transition {{ {timing}\n }}"),
            format!("transition {{ t {{ x {{ {timing}\n }} }} }}"),
        ] {
            assert_diagnostic(
                &format!("motion a {{ state idle {{ t {{ x: 0 }} }} {body} }}"),
                code,
                message,
            );
        }
    }
}

#[test]
fn keyframes_point_to_offsets_values_and_interpolations() {
    for (frames, code, message) in [
        ("«101%»: 1", "semantic.offset", "offset"),
        ("«-1%»: 1", "semantic.offset", "offset"),
        (
            "‹40%›: 1; «40.0%»: 2",
            "semantic.duplicate",
            "Duplicate declaration",
        ),
        ("40%:«»", "semantic.frame", "Frame requires"),
        ("40%:«»@ linear", "semantic.frame", "Frame requires"),
        ("40%: 2 @«»", "semantic.frame", "Frame requires"),
        (
            "40%: «${1}»",
            "semantic.frame-template",
            "Runtime interpolation",
        ),
        (
            "40%: /* 日本😀 */ var(--x, «${1}»)",
            "semantic.frame-template",
            "Runtime interpolation",
        ),
        (
            "40%: \"prefix «${1}» suffix\"",
            "semantic.frame-template",
            "Runtime interpolation",
        ),
    ] {
        assert_diagnostic(
            &format!(
                "motion a {{ state idle {{ t {{ x: 0 }} }} transition {{ @tween: 1s; t {{ x {{ {frames}\n }} }} }} }}"
            ),
            code,
            message,
        );
    }
}

#[test]
fn definition_and_transition_requirements_point_to_headers_or_references() {
    for (source, code, message) in [
        ("«motion a» {}", "semantic.states", "at least one state"),
        (
            "«motion a» { state idle when true {} }",
            "semantic.fallback",
            "fallback",
        ),
        (
            "motion a { ‹state first› {} «state second» {} }",
            "semantic.fallback",
            "fallback",
        ),
        (
            "motion a { state idle {} transition idle -> /* 😀 */ «absent» {} }",
            "semantic.reference",
            "absent",
        ),
        (
            "motion a { state idle {} transition «absent» -> idle {} }",
            "semantic.reference",
            "absent",
        ),
        (
            "motion a { «state idle» {} state active when true { t { x: 0 } } }",
            "semantic.completeness",
            "in state idle",
        ),
        (
            "motion a { state idle { «t» { x: 0 } } state active when true { t { x: 0; y: 1 } } }",
            "semantic.completeness",
            "in state idle",
        ),
        (
            "motion a { state idle { t { x: 0 } } «state active when true» { t { x: 1 } } }",
            "semantic.timing-missing",
            "idle -> active",
        ),
        (
            "motion a { state idle { t { x: 0 } } state active when true { t { x: 1 } } «transition» {} }",
            "semantic.timing-missing",
            "idle -> active",
        ),
        (
            "motion a { state idle { t { x: 0 } } state active when true { t { x: 1 } } transition { t { «x» {} } } }",
            "semantic.timing-missing",
            "idle -> active",
        ),
        (
            "motion a { state idle { t { x: 0 } } state active when true { t { x: 1 } } «transition idle -> active» {} }",
            "semantic.timing-missing",
            "idle -> active",
        ),
    ] {
        assert_diagnostic(source, code, message);
    }
}

#[test]
fn spring_frame_conflicts_keep_origins_through_inheritance() {
    for transitions in [
        "transition { ‹@spring›: 300 20; t { x { «40%»: 2 } } }",
        "transition { @tween: 1s; t { x { «40%»: 2 } } } transition idle -> active { ‹@spring›: 300 20 }",
        "transition { @tween: 1s } transition idle -> active { t { x { ‹@spring›: 300 20; «40%»: 2 } } }",
        "transition { @tween: 1s; t { x { ‹@spring›: 300 20; «40%»: 2 } } } transition idle -> active { @tween: 2s }",
        "transition { ‹@spring›: 300 20; t { x { 0%: 0 @ «ease-in» } } }",
    ] {
        assert_diagnostic(
            &format!(
                "motion a {{ state idle {{ t {{ x: 0 }} }} state active when true {{ t {{ x: 1 }} }} {transitions} }}"
            ),
            "semantic.spring-frames",
            "idle -> active",
        );
    }
}

#[test]
fn endpoint_warnings_point_to_values_or_unused_easing() {
    for source in [
        "motion a { state idle { t { x: ‹0› } } state active when true { t { x: 1 } } transition idle -> active { @tween: 1s; t { x { 0%: /* 😀 */ «2» /* tail */ } } } }",
        "motion a { state idle { t { x: 0 } } state active when true { t { x: ‹1› } } transition idle -> active { @tween: 1s; t { x { 100%: «2» } } } }",
        "motion a { state idle { t { x: 0 } } state active when true { t { x: 1 } } transition idle -> active { @tween: 1s; t { x { 100%: 1 @ /* 😀 */ «ease-out» /* tail */ } } } }",
    ] {
        assert_diagnostic(source, "semantic.endpoint", "explicit endpoint");
    }
}

#[test]
fn incomplete_declarations_keep_all_diagnostic_ranges_within_source() {
    for source in [
        include_str!("../../../fixtures/toggle.liv"),
        include_str!("../../../fixtures/derived.liv"),
        "// 😀\r\nmotion a(value: number) { let value = 1; state idle { t { x: 0 } } state active when true { t { x: 1 } } transition idle -> absent { @spring: 1s /* 日本 */ 1; t { x { 40%: ${value}; 100%: 2 @ linear } } } }",
        "motion a { state idle { t { x: 0 } } transition { @tween-duration: /* missing */; @spring: 1s 1; t { x { 101%: 1; 0%: @ linear } } } }",
    ] {
        for end in (0..=source.len()).filter(|end| source.is_char_boundary(*end)) {
            let source = &source[..end];
            let result = compile(source, true);

            for diagnostic in result.diagnostics {
                for range in std::iter::once(&diagnostic.range).chain(&diagnostic.related) {
                    assert!(
                        range.start <= range.end && range.end <= source.len(),
                        "{source}: {diagnostic:?}"
                    );
                    assert!(
                        source.is_char_boundary(range.start) && source.is_char_boundary(range.end),
                        "{source}: {diagnostic:?}"
                    );
                }
            }
        }
    }
}
