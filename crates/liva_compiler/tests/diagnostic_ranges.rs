use liva_compiler::compile;
use liva_syntax::Range;

fn assert_error(marked: &str, message: &str) {
    let start = marked.find('«').unwrap();
    let end = marked.find('»').unwrap() - '«'.len_utf8();
    let source = marked.replace(['«', '»'], "");
    let result = compile(&source, false);
    let errors: Vec<_> = result
        .diagnostics
        .iter()
        .filter(|d| d.code.starts_with("semantic.") && d.message.contains(message))
        .collect();

    assert_eq!(errors.len(), 1, "{source}: {:?}", result.diagnostics);
    assert_eq!(
        errors[0].range,
        Range { start, end },
        "{source}: {}",
        errors[0].message
    );
}

#[test]
fn expression_nodes_report_the_offending_token_or_operand() {
    for (expression, message) in [
        ("drag(target: «1»)", "Invalid argument type"),
        ("drag(target: «true»)", "Invalid argument type"),
        ("drag(target: «'日本😀'»)", "Invalid argument type"),
        ("«absent»", "Unknown variable:"),
        ("«absent».offset.x", "Unknown variable:"),
        ("movement.«missing».x", "Unknown variable member"),
        ("movement.offset.x.«missing»", "Unknown variable member"),
        ("«unknown»(target: body)", "Unknown function"),
        ("«drag()»", "Missing argument"),
        ("drag(«element»: body)", "Unknown argument"),
        ("drag(target: body, «target»: body)", "Duplicate argument"),
        (
            "drag(target: «drag(target: body)»)",
            "Invalid argument type",
        ),
        ("drag(target: «absent»)", "Unknown variable:"),
        ("drag(target: «!true»)", "Invalid argument type"),
        ("drag(target: «1 + 2»)", "Invalid argument type"),
        ("drag(target: «movement.offset»)", "Invalid argument type"),
        ("drag(target: «(movement.active)»)", "Invalid argument type"),
        ("!(1 + «true»)", "Incompatible expression operands"),
        ("drag(target: «unknown»())", "Unknown function"),
        ("(«absent»)", "Unknown variable:"),
        ("!«1»", "Invalid unary operand type"),
        ("-«true»", "Invalid unary operand type"),
        ("+«'text'»", "Invalid unary operand type"),
        ("1 + «true»", "Incompatible expression operands"),
        ("«false» - 1", "Incompatible expression operands"),
        ("1 * «false»", "Incompatible expression operands"),
        ("1 / «false»", "Incompatible expression operands"),
        ("1 % «false»", "Incompatible expression operands"),
        ("true && «1»", "Incompatible expression operands"),
        ("«1» || false", "Incompatible expression operands"),
        ("1 == «false»", "Incompatible expression operands"),
        ("1 != «false»", "Incompatible expression operands"),
        ("1 < «false»", "Incompatible expression operands"),
        ("1 <= «false»", "Incompatible expression operands"),
        ("1 > «false»", "Incompatible expression operands"),
        ("1 >= «false»", "Incompatible expression operands"),
        ("«body» == body", "Incompatible expression operands"),
        ("1 + «(true)»", "Incompatible expression operands"),
        ("(1 + «true»)", "Incompatible expression operands"),
        ("1 + (2 * «false»)", "Incompatible expression operands"),
        ("drag(target: /* 日本😀 */ «true»)", "Invalid argument type"),
        (
            "(1 /* same: true */ +\r\n «true»)",
            "Incompatible expression operands",
        ),
    ] {
        assert_error(
            &format!(
                "motion a {{ let movement = drag(target: body); let result = {expression}; layer idle {{ body {{ opacity: 1 }} }} }}"
            ),
            message,
        );
    }
}

#[test]
fn conditions_templates_and_type_annotations_use_expression_ranges() {
    for (source, message) in [
        ("motion a(value: «unknown») {}", "Expected primitive type"),
        (
            "motion a(value: /* 日本😀 */ «unknown» /* tail */) {}",
            "Expected primitive type",
        ),
        (
            "motion a { layer idle when «'😀'» {} }",
            "Layer condition must be Boolean",
        ),
        (
            "motion a { layer idle when «body» { body { opacity: 1 } } }",
            "Layer condition must be Boolean",
        ),
        (
            "motion a { let movement = drag(target: body); layer idle when «movement» { body { opacity: 1 } } }",
            "Layer condition must be Boolean",
        ),
        (
            "motion a { layer idle { body { opacity: ${«drag(target: body)»} } } }",
            "CSS templates require scalar",
        ),
        (
            "motion a { let movement = drag(target: body); layer idle { body { opacity: ${«movement.offset»} } } }",
            "CSS templates require scalar",
        ),
        (
            "motion a { layer idle when «1 + 2» { body { opacity: 1 } } }",
            "Layer condition must be Boolean",
        ),
        (
            "motion a { layer idle when true && «1» { body { opacity: 1 } } }",
            "Incompatible expression operands",
        ),
        (
            "motion a { layer idle when /* 😀 */ «(1)» { body { opacity: 1 } } }",
            "Layer condition must be Boolean",
        ),
        (
            "motion a { layer idle { body { opacity: ${«body»} } } }",
            "CSS templates require scalar",
        ),
        (
            "motion a { layer idle { body { opacity: ${1} ${1 + «true»} } } }",
            "Incompatible expression operands",
        ),
        (
            "motion a { layer idle { body { opacity: ${'😀'} /* 日本 */ ${«absent»} } } }",
            "Unknown variable:",
        ),
    ] {
        assert_error(source, message);
    }
}

#[test]
fn binding_dependencies_report_the_original_error_without_duplicates() {
    for source in [
        "motion a { let first = second; let second = 1 + «true»; }",
        "motion a { let first = 1 + «true»; let second = first; }",
        "motion a { let first = second; let second = third; let third = 1 + «true»; }",
    ] {
        assert_error(source, "Incompatible expression operands");
    }

    assert_error(
        "motion a { let value = 1 + «value»; }",
        "Cyclic let binding dependency",
    );
}

#[test]
fn non_finite_number_reports_the_literal() {
    let number = "9".repeat(400);
    assert_error(
        &format!("motion a {{ let value = «{number}»; }}"),
        "Non-finite expression number",
    );
}

#[test]
fn nested_expression_errors_keep_their_range_in_conditions_and_interpolations() {
    for (expression, message) in [
        ("«absent»", "Unknown variable:"),
        ("movement.«missing»", "Unknown variable member"),
        ("!«1»", "Invalid unary operand type"),
        ("1 + «true»", "Incompatible expression operands"),
        ("(1 + «true»)", "Incompatible expression operands"),
        ("«unknown»()", "Unknown function"),
        ("«drag()»", "Missing argument"),
    ] {
        for body in [
            format!(
                "layer idle {{ body {{ opacity: 1 }} }} layer active when {expression} {{ body {{ opacity: 1 }} }}"
            ),
            format!("layer idle {{ body {{ opacity: ${{{expression}}} }} }}"),
        ] {
            assert_error(
                &format!("motion a {{ let movement = drag(target: body); {body} }}"),
                message,
            );
        }
    }

    for (expression, message) in [
        ("drag(target: «true»)", "Invalid argument type"),
        ("drag(«element»: body)", "Unknown argument"),
        ("drag(target: body, «target»: body)", "Duplicate argument"),
        ("drag(target: «absent»)", "Unknown variable:"),
    ] {
        assert_error(
            &format!("motion a {{ layer idle {{ body {{ opacity: ${{{expression}}} }} }} }}"),
            message,
        );
    }
}

#[test]
fn when_calls_and_incomplete_expressions_have_local_ranges() {
    for (source, message) in [
        (
            "motion a { layer idle {} layer active when «unknown»(value: true) {} }",
            "Unknown function",
        ),
        (
            "motion a { layer idle {} layer active when drag(target: «true») {} }",
            "Invalid argument type",
        ),
        (
            "motion a(checked: boolean) { layer idle {} layer active when checked «&&» {} }",
            "Expected expression",
        ),
        (
            "motion a { let value = unknown(«1»); layer idle {} }",
            "Expected named argument",
        ),
        (
            "motion a { layer idle {} layer active when unknown(«1») {} }",
            "Expected named argument",
        ),
        (
            "motion a { layer idle {} layer active when true «?» {} }",
            "Unsupported expression token",
        ),
    ] {
        assert_error(source, message);
    }
}

#[test]
fn invalid_conditions_do_not_create_whole_motion_fallback_errors() {
    for condition in [
        "missing",
        "1",
        "true &&",
        "unknown()",
        "unknown(value: true)",
        "drag(target: false)",
    ] {
        let source = format!("motion a {{ layer idle {{}} layer active when {condition} {{}} }}");
        let result = compile(&source, false);

        assert_eq!(
            result.diagnostics.len(),
            1,
            "{source}: {:?}",
            result.diagnostics
        );
        assert_eq!(result.diagnostics[0].code, "semantic.expression");
        let start = source.find(condition).unwrap();
        assert!(result.diagnostics[0].range.start >= start);
        assert!(result.diagnostics[0].range.end <= start + condition.len());
    }
}

#[test]
fn identifier_unit_escape_and_subtraction_errors_use_local_ranges() {
    for (expression, message) in [
        ("«not-defined»()", "Unknown function"),
        (r#"«"\41"»"#, "Unsupported string escape"),
        ("«20px»", "Unsupported expression token"),
        ("10 «-»2", "Subtraction requires whitespace"),
        ("10«-» 2", "Subtraction requires whitespace"),
    ] {
        for body in [
            format!("let value = {expression}; layer idle {{}}"),
            format!("layer idle {{ body {{ content: ${{{expression}}} }} }}"),
        ] {
            assert_error(&format!("motion a {{ /* 😀 */ {body} }}"), message);
        }
    }
}
