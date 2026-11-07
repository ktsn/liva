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

#[test]
fn shared_headers_expose_lossless_decorators_and_guarded_transitions() {
    let source = "// 日本語\r\nmotion sample(active: boolean) {\r\nlayer base @tween(duration: 200) {\r\nstate idle initial @quick {}\r\nstate on @quick {}\r\ntransition idle -> on\r\n @spring(duration: 400)\r\n when active {}\r\ntransition on -> idle\r\n @quick\r\n when !active\r\n}\r\nenter @quick {}\r\nleave @quick {}\r\n}";
    let parsed = parse(source);

    assert!(parsed.diagnostics.is_empty(), "{:?}", parsed.diagnostics);
    assert_eq!(parsed.root.text(), source);

    let motion = parsed.root.motions().next().unwrap();
    let layer = motion.layers().next().unwrap();
    let decorator = layer.decorators().next().unwrap();
    let range = decorator.expression_range();

    assert_eq!(&source[range.start..range.end], decorator.expression_text());
    assert_eq!(decorator.expression_text().trim(), "tween(duration: 200)");
    assert!(layer.states().next().unwrap().is_initial());
    assert_eq!(layer.transitions().count(), 2);
    assert!(
        layer
            .transitions()
            .all(|transition| transition.condition().is_some())
    );
    assert_eq!(motion.enters().next().unwrap().decorators().count(), 1);
    assert_eq!(motion.leaves().next().unwrap().decorators().count(), 1);
}

#[test]
fn malformed_shared_decorators_keep_following_declarations_accessible() {
    let source =
        "motion sample { layer base @ { state idle initial {} state on {} } leave @quick {} }";
    let parsed = parse(source);
    let motion = parsed.root.motions().next().unwrap();
    let layer = motion.layers().next().unwrap();

    assert_eq!(parsed.root.text(), source);
    assert_eq!(
        layer.decorators().next().unwrap().expression_text().trim(),
        ""
    );
    assert_eq!(layer.states().count(), 2);
    assert_eq!(motion.leaves().count(), 1);
}
