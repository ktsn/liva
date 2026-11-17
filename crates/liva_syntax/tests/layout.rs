use liva_syntax::{
    ast::{AstNode, HasHeader, HasItems, HasValue, LayoutDeclaration},
    parse,
};

#[test]
fn typed_layout_views_preserve_lossless_source_order_ranges_and_timing() {
    let source = "// 日本😀\r\nmotion item { layer base { $layout: position /* gap */ size @instant; opacity: 1; content { $layout: y height } } }";
    let parsed = parse(source);

    assert!(parsed.diagnostics.is_empty(), "{:?}", parsed.diagnostics);
    assert_eq!(parsed.root.text(), source);

    let layouts: Vec<_> = parsed
        .root
        .syntax()
        .descendants()
        .filter_map(LayoutDeclaration::cast)
        .collect();

    assert_eq!(layouts.len(), 2);
    assert_eq!(layouts[0].header().as_deref(), Some("$layout"));
    assert_eq!(layouts[0].selection().as_deref(), Some("position   size"));
    assert_eq!(layouts[1].selection().as_deref(), Some("y height"));
    assert_eq!(
        layouts[0].decorators().next().unwrap().expression_text(),
        "instant"
    );
    assert!(!layouts[0].is_attachment());

    for layout in layouts {
        let range = layout.range();

        assert_eq!(&source[range.start..range.end], layout.text());
        assert!(layout.value_node().is_some());
    }
}

#[test]
fn malformed_layout_values_retain_typed_views_and_following_declarations() {
    for value in ["", "${true}", "${missing", "none x", ":= controller"] {
        let separator = if value.starts_with(":=") { "" } else { ":" };
        let source =
            format!("motion item {{ layer base {{ $layout{separator}{value}\n opacity: 1 }} }}");
        let parsed = parse(&source);
        let layer = parsed
            .root
            .motions()
            .next()
            .unwrap()
            .layers()
            .next()
            .unwrap();
        let declarations: Vec<_> = layer.properties().collect();
        let layout = LayoutDeclaration::cast(declarations[0].syntax().clone()).unwrap();

        assert_eq!(parsed.root.text(), source);
        assert_eq!(layout.is_attachment(), value.starts_with(":="));
        assert_eq!(declarations[1].header().as_deref(), Some("opacity"));
    }
}
