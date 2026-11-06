use liva_syntax::{
    Kind,
    ast::{AstNode, HasHeader, HasItems, HasValue},
    parse,
};

#[test]
fn all_decorator_positions_are_lossless_and_separate_from_css() {
    let source = "motion button { state idle { body @quick { opacity: 1 @tween(duration: 150); translate @quick { 0%: 0 20px @easeOut; 100%: 0 0 } } } }";
    let parsed = parse(source);

    assert!(parsed.diagnostics.is_empty(), "{:?}", parsed.diagnostics);
    assert_eq!(parsed.root.text(), source);
    assert_eq!(
        parsed
            .root
            .syntax()
            .descendants()
            .filter(|node| node.kind() == Kind::Decorator)
            .count(),
        4
    );

    let target = parsed
        .root
        .motions()
        .next()
        .unwrap()
        .states()
        .next()
        .unwrap()
        .targets()
        .next()
        .unwrap();

    assert_eq!(target.header().as_deref(), Some("body"));
    assert_eq!(
        target.properties().next().unwrap().value_text().as_deref(),
        Some("1")
    );
}
