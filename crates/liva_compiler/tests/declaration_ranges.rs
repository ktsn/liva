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
            "motion a(x«») { layer idle {} }",
            "semantic.type",
            "Expected primitive",
        ),
        (
            "motion a(x:«») { layer idle {} }",
            "semantic.type",
            "Expected primitive",
        ),
        (
            "motion a(«»: number) { layer idle {} }",
            "semantic.parameter",
            "Invalid parameter",
        ),
        (
            "motion a(«true»: number) { layer idle {} }",
            "semantic.parameter",
            "Invalid parameter",
        ),
        (
            "motion a { let «true» = 1; layer idle {} }",
            "semantic.binding",
            "Invalid let",
        ),
        (
            "motion a { layer idle { «true» { x: 0 } } }",
            "semantic.variable",
            "Target variables",
        ),
        (
            "motion ‹a› { layer idle {} } motion «a» { layer idle {} }",
            "semantic.duplicate",
            "Duplicate declaration",
        ),
        (
            "motion a(‹x›: number, «x»: number) { layer idle {} }",
            "semantic.duplicate",
            "Duplicate variable",
        ),
        (
            "motion a { let ‹x› = 1; let «x» = 2; layer idle {} }",
            "semantic.duplicate",
            "Duplicate variable",
        ),
        (
            "motion a { layer ‹idle› {} layer «idle» when true {} }",
            "semantic.duplicate",
            "Duplicate declaration",
        ),
        (
            "motion a { layer idle { ‹t› { x: 0 } «t» { x: 0 } } }",
            "semantic.duplicate",
            "Duplicate declaration",
        ),
        (
            "motion a { layer idle { t { ‹x›: 0; «x»: 1 } } }",
            "semantic.duplicate",
            "Duplicate declaration",
        ),
        (
            "motion a { layer idle {} ‹enter› {} «enter» {} }",
            "semantic.duplicate",
            "Duplicate declaration",
        ),
        (
            "motion a { layer idle {} ‹leave› {} «leave» {} }",
            "semantic.duplicate",
            "Duplicate declaration",
        ),
        (
            "motion a { layer idle { t { x: 0 } } @tween() enter { ‹t› {} «t» {} } }",
            "semantic.duplicate",
            "Duplicate declaration",
        ),
        (
            "motion a { layer idle { t { x: 0 } } @tween() enter { t { ‹x› ~> {} «x» ~> {} } } }",
            "semantic.duplicate",
            "Duplicate declaration",
        ),
        (
            "motion a(‹x›: number) { let «x» = 1; layer idle {} }",
            "semantic.duplicate",
            "Duplicate variable",
        ),
        (
            "motion a(‹t›: number) { layer idle { «t» { x: 0 } } }",
            "semantic.duplicate",
            "Duplicate variable",
        ),
        (
            "motion a { let ‹t› = 1; layer idle { «t» { x: 0 } } }",
            "semantic.duplicate",
            "Duplicate variable",
        ),
        (
            "motion a(«self»: number) { layer idle {} }",
            "semantic.variable",
            "reserved built-in target",
        ),
        (
            "motion a { let «self» = 1; layer idle {} }",
            "semantic.variable",
            "reserved built-in target",
        ),
        (
            "motion a { layer idle { ‹self› { opacity: 1 } «self» { scale: 1 } } }",
            "semantic.duplicate",
            "Duplicate declaration",
        ),
    ] {
        assert_diagnostic(source, code, message);
    }
}

#[test]
fn misplaced_declarations_have_local_ranges() {
    for (source, code, message) in [
        (
            "«unknown»: 1; motion a { layer base {} }",
            "semantic.declaration",
            "Unknown declaration",
        ),
        (
            "motion a { «unknown»: 1; layer base {} }",
            "semantic.declaration",
            "Unknown declaration",
        ),
        (
            "motion a { layer base { t { x:«» } } }",
            "semantic.value",
            "Value must not be empty",
        ),
        (
            "motion a { layer base { t { x:«»/* 😀 */ } } }",
            "semantic.value",
            "Value must not be empty",
        ),
        (
            "motion a { layer base { «let x = 1»; } }",
            "semantic.structure",
            "Let declarations",
        ),
        (
            "motion a { layer base {} enter { «let x = 1»; } }",
            "semantic.structure",
            "Let declarations",
        ),
        (
            "motion a { layer base {} «unknown block» {} }",
            "semantic.structure",
            "Expected layer",
        ),
        (
            "motion a { layer base {} «transition broken» {} }",
            "semantic.structure",
            "Expected layer",
        ),
        (
            "motion a { layer base { t { x: 0 } } @tween() enter { t { x ~> { «unexpected» {} } } } }",
            "semantic.structure",
            "Property tracks",
        ),
    ] {
        assert_diagnostic(source, code, message);
    }
}

#[test]
fn unexpected_animation_declarations_point_to_the_field_name() {
    for field in ["duration", "easing", "stiffness"] {
        let body = format!("enter {{ t {{ x ~> {{ «{field}»: 1; 0%: 0 }} }} }}");

        assert_diagnostic(
            &format!("motion a {{ layer base {{ t {{ x: 1 }} }} {body} }}"),
            "semantic.declaration",
            "Unexpected declaration",
        );
    }
}

#[test]
fn typed_timing_errors_point_to_the_invalid_argument() {
    for (expression, message) in [
        ("tween(duration: «true»)", "Invalid argument type"),
        ("spring(«speed»: 1)", "Unknown argument"),
        ("tween(easing: «1»)", "Invalid argument type"),
    ] {
        assert_diagnostic(
            &format!("motion a {{ layer base {{ t {{ x: 1 @{expression} }} }} }}"),
            "semantic.expression",
            message,
        );
    }
}

#[test]
fn keyframe_errors_point_to_offsets_and_missing_values() {
    for (frames, code, message) in [
        ("«101%»: 1", "semantic.offset", "offset"),
        ("«-1%»: 1", "semantic.offset", "offset"),
        (
            "‹40%›: 1; «40.0%»: 2",
            "semantic.duplicate",
            "Duplicate declaration",
        ),
        ("40%:«»", "semantic.frame", "Frame requires"),
    ] {
        assert_diagnostic(
            &format!(
                "motion a {{ layer base {{ t {{ x: 1 }} }} @tween() enter {{ t {{ x ~> {{ {frames}\n }} }} }} }}"
            ),
            code,
            message,
        );
    }
}

#[test]
fn layer_requirements_and_removed_declarations_have_actionable_ranges() {
    for (source, code, message) in [
        ("«motion a» {}", "semantic.layers", "at least one layer"),
        (
            "motion a { layer base {} state «idle» {} }",
            "semantic.state-scope",
            "states inside a stateful layer",
        ),
        (
            "motion a { layer base {} «transition» {} }",
            "semantic.transition-scope",
            "guarded transitions",
        ),
        (
            "motion a { layer base {} «transition idle -> active» {} }",
            "semantic.transition-scope",
            "guarded transitions",
        ),
    ] {
        assert_diagnostic(source, code, message);
    }
}

#[test]
fn incomplete_declarations_keep_all_diagnostic_ranges_within_source() {
    for source in [
        include_str!("../../../fixtures/toggle.liv"),
        include_str!("../../../fixtures/derived.liv"),
        "// 😀\r\nmotion a(value: number) { let value = 1; state idle { t { x: 0 } } state active when true { t { x: 1 } } transition idle -> absent { @spring: 1s /* 日本 */ 1; t { x ~> { 40%: ${value}; 100%: 2 @ linear } } } }",
        "motion a { state idle { t { x: 0 } } transition { @tween-duration: /* missing */; @spring: 1s 1; t { x ~> { 101%: 1; 0%: @ linear } } } }",
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
