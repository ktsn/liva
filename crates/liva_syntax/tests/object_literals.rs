use liva_syntax::{
    ast::expression::ExprView,
    ast::{AstNode, HasItems},
    parse, parse_expression,
};

#[test]
fn object_syntax_is_lossless_and_has_absolute_property_ranges() {
    let source = "motion demo {\r\nlet config = { /* 😀 */ property: \"value\",\r\n nested: { number: 1 + 2 }, empty: {}, }\r\nlet selected = config.property\r\nlayer base {}\r\n}";
    let parsed = parse(source);
    assert!(parsed.diagnostics.is_empty(), "{:?}", parsed.diagnostics);
    assert_eq!(parsed.root.text(), source);
    let motion = parsed.root.motions().next().unwrap();
    assert_eq!(motion.bindings().count(), 2);
    let object = motion.bindings().next().unwrap().initializer().unwrap();
    assert!(matches!(object.view(), ExprView::Object));
    assert_eq!(object.properties().count(), 3);
    for property in object.properties() {
        let name = property.name().unwrap();
        assert_eq!(&source[name.range().start..name.range().end], name.text());
        let value = property.value().unwrap();
        assert_eq!(
            &source[value.range().start..value.range().end],
            value.text()
        );
    }
}

#[test]
fn malformed_objects_report_errors_and_preserve_tokens() {
    for source in [
        "{",
        "{ a:",
        "{ a: }",
        "{ a 1 }",
        "{ a: 1 b: 2 }",
        "{,}",
        "{ a: 1,, }",
        "{ a: ( }",
        "{ 'a': 1 }",
    ] {
        let parsed = parse_expression(source);
        assert!(!parsed.diagnostics.is_empty(), "{source}");
        assert_eq!(parsed.root.text(), source);
    }
    let source =
        "motion demo { let bad = { a: }; let good = { b: 2 }; layer base {} }\nmotion other {}";
    let parsed = parse(source);
    assert_eq!(parsed.root.text(), source);
    assert_eq!(parsed.root.motions().count(), 2);
    assert_eq!(parsed.root.motions().next().unwrap().bindings().count(), 2);
}

#[test]
fn objects_nest_in_calls_decorators_and_css_interpolations() {
    for source in [
        "motion demo { let x = custom(option: { a: 1 }); layer base {} }",
        "motion demo { @custom(option: { a: 1 }) layer base {} }",
        "motion demo { layer base { content: ${custom(option: { a: 1 })} } }",
        "motion demo { layer base { content: 'value ${custom(option: { a: 1 })}!' } }",
    ] {
        let parsed = parse(source);
        assert!(
            parsed.diagnostics.is_empty(),
            "{source}: {:?}",
            parsed.diagnostics
        );
        assert_eq!(parsed.root.text(), source);
    }
}

#[test]
fn unclosed_objects_recover_before_later_declarations() {
    let source =
        "motion demo {\nlet bad = { a: 1\nlet good = { b: 2 }\nlayer base {}\n}\nmotion other {}";
    let parsed = parse(source);
    assert!(!parsed.diagnostics.is_empty());
    assert_eq!(parsed.root.text(), source);
    assert_eq!(parsed.root.motions().count(), 2);
    assert_eq!(parsed.root.motions().next().unwrap().bindings().count(), 2);
}
