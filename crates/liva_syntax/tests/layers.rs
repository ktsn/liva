use liva_syntax::{ast::AstNode, parse};

#[test]
fn layers_retain_lossless_syntax_and_condition_ranges() {
    let source = "motion button(hovered: boolean) {\n  layer /* base */ base { body { color: red } }\n  layer hover when hovered { body { scale: ${1 + 0.05} } }\n}";
    let parsed = parse(source);

    assert!(parsed.diagnostics.is_empty(), "{:?}", parsed.diagnostics);
    assert_eq!(parsed.root.text(), source);

    let motion = parsed.root.motions().next().unwrap();
    let layers = motion.layers().collect::<Vec<_>>();

    assert_eq!(layers.len(), 2);
    assert_eq!(layers[0].name().as_deref(), Some("base"));
    assert!(layers[0].condition().is_none());

    let condition = layers[1].condition().unwrap();
    let range = condition.range();

    assert_eq!(source[range.start..range.end].trim(), "hovered");
    assert!(condition.expression().is_some());
}
