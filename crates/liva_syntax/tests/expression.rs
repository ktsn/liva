use liva_syntax::ast::{AstNode, HasItems, HasValue};
use liva_syntax::{
    ast::expression::{Expr, ExprView},
    parse,
};

#[test]
fn expressions_are_views_of_the_document_tree_with_absolute_ranges() {
    let source = "motion demo { let value = -(1 /* 😀 */ + 2); state idle {} state active when value > 0 { body { opacity: ${value * 2} } } }";
    let parsed = parse(source);

    assert!(parsed.diagnostics.is_empty(), "{:?}", parsed.diagnostics);
    assert_eq!(parsed.root.text(), source);

    let motion = parsed.root.motions().next().unwrap();
    let active = motion.states().nth(1).unwrap();
    let property = active
        .targets()
        .next()
        .unwrap()
        .properties()
        .next()
        .unwrap();
    let expressions = [
        motion.bindings().next().unwrap().initializer().unwrap(),
        active.condition().unwrap().expression().unwrap(),
        property
            .value_node()
            .unwrap()
            .interpolations()
            .next()
            .unwrap()
            .expression()
            .unwrap(),
    ];

    assert_eq!(
        expressions.iter().map(Expr::text).collect::<Vec<_>>(),
        ["-(1 /* 😀 */ + 2)", "value > 0", "value * 2"]
    );
    assert!(matches!(expressions[0].view(), ExprView::Unary));
    let group = expressions[0].operands().next().unwrap();
    assert!(matches!(group.view(), ExprView::Parenthesized));
    assert_eq!(
        group.operands().next().unwrap().operator().as_deref(),
        Some("+")
    );

    for expression in parsed.root.syntax().descendants().filter_map(Expr::cast) {
        let range = expression.range();
        assert_eq!(&source[range.start..range.end], expression.text());
        assert_eq!(
            expression.syntax().ancestors().last().unwrap(),
            parsed.root.syntax().clone()
        );
    }
}

#[test]
fn call_names_arguments_and_members_keep_individual_ranges() {
    let source =
        "motion demo { let value = custom(\r\n target: /* 😀 */ movement.offset.x,\r\n); }";
    let parsed = parse(source);
    let call = parsed
        .root
        .syntax()
        .descendants()
        .filter_map(Expr::cast)
        .find(|expr| matches!(expr.view(), ExprView::Call))
        .unwrap();
    assert!(parsed.diagnostics.is_empty(), "{:?}", parsed.diagnostics);
    assert_eq!(call.arguments().count(), 1);

    let function = call.function().unwrap();
    let argument = call.arguments().next().unwrap();
    let argument_name = argument.name().unwrap();
    let reference = argument.value().unwrap();
    let names: Vec<_> = reference.names().collect();

    assert_eq!(function.text(), "custom");
    assert_eq!(argument_name.text(), "target");
    assert_eq!(
        names.iter().map(|name| name.text()).collect::<Vec<_>>(),
        ["movement", "offset", "x"]
    );

    for name in [function, argument_name].into_iter().chain(names) {
        let range = name.range();
        assert_eq!(&source[range.start..range.end], name.text());
    }
}

#[test]
fn subtraction_requires_whitespace_but_unary_minus_and_modulo_still_work() {
    for expression in [
        "10 - 2",
        "(10\t-\t2)",
        "-1",
        "-value",
        "--1",
        "--value",
        "1%2",
    ] {
        assert!(
            liva_syntax::parse_expression(expression)
                .diagnostics
                .is_empty(),
            "{expression}"
        );
    }
    for expression in ["10-2", "10 -2", "10- 2", "max -min", "max- min"] {
        assert!(
            !liva_syntax::parse_expression(expression)
                .diagnostics
                .is_empty(),
            "{expression}"
        );
    }
}

#[test]
fn named_calls_accept_nested_expressions_and_reject_invalid_argument_syntax() {
    let parsed = liva_syntax::parse_expression("custom(value: 1 + 2, nested: other(flag: true),)");
    assert!(parsed.diagnostics.is_empty(), "{:?}", parsed.diagnostics);
    let call = parsed.root.expression().unwrap();
    let arguments: Vec<_> = call.arguments().collect();
    assert_eq!(call.function().unwrap().text(), "custom");
    assert_eq!(arguments.len(), 2);
    assert!(matches!(
        arguments[0].value().unwrap().view(),
        ExprView::Binary
    ));
    assert!(matches!(
        arguments[1].value().unwrap().view(),
        ExprView::Call
    ));

    for source in [
        "custom(1)",
        "custom(value:)",
        "custom(value: 1,,)",
        "custom(value: 1) suffix",
    ] {
        assert!(
            !liva_syntax::parse_expression(source).diagnostics.is_empty(),
            "{source}"
        );
    }
}

#[test]
fn generated_string_spellings_round_trip_the_complete_decoder_character_domain() {
    let controls: String = (0_u8..32).map(char::from).collect();

    for value in [
        "",
        "a'\"\\b",
        "\n\r\t",
        "日本語😀",
        "${literal}",
        &controls,
        "\u{7f}\u{2028}",
    ] {
        let spelling = liva_syntax::quote_string(value);

        let parsed = liva_syntax::parse_expression(&spelling);
        let expression = parsed.root.expression().unwrap();

        assert!(
            parsed.diagnostics.is_empty(),
            "{spelling:?}: {:?}",
            parsed.diagnostics
        );
        assert!(expression.is_closed_string());
        assert_eq!(expression.string_value().unwrap(), value);
    }
}

#[test]
fn lexical_string_closure_is_independent_of_escape_validity() {
    for (spelling, closed) in [
        (r#""\q""#, true),
        (r#"'a\'"#, false),
        ("'unfinished", false),
        ("42", false),
    ] {
        let parsed = liva_syntax::parse_expression(spelling);

        assert_eq!(
            parsed.root.expression().unwrap().is_closed_string(),
            closed,
            "{spelling}"
        );
    }
}
