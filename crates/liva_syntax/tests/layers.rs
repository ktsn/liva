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

#[test]
fn nested_states_preserve_initial_marker_and_target_ranges() {
    let source = "motion submit { layer submission { button { opacity: 1 } state idle initial { spinner { opacity: 0 } } state loading { spinner { opacity: 1 } } } }";
    let parsed = parse(source);

    assert!(parsed.diagnostics.is_empty(), "{:?}", parsed.diagnostics);
    assert_eq!(parsed.root.text(), source);

    let layer = parsed
        .root
        .motions()
        .next()
        .unwrap()
        .layers()
        .next()
        .unwrap();
    let states = layer.states().collect::<Vec<_>>();

    assert_eq!(layer.targets().count(), 1);
    assert!(states[0].is_initial());
    assert!(!states[1].is_initial());

    let target = states[0].targets().next().unwrap();
    let range = target.range();

    assert_eq!(&source[range.start..range.end], "spinner { opacity: 0 }");
}

#[test]
fn guarded_transition_statements_preserve_lossless_conditions() {
    let source = "motion button { layer status { state idle initial {} state active {} transition idle -> active when ready;\n transition active -> idle when !ready\n } }";
    let parsed = parse(source);

    assert!(parsed.diagnostics.is_empty(), "{:?}", parsed.diagnostics);
    assert_eq!(parsed.root.text(), source);

    let layer = parsed
        .root
        .motions()
        .next()
        .unwrap()
        .layers()
        .next()
        .unwrap();
    let transitions = layer.transitions().collect::<Vec<_>>();

    assert_eq!(transitions.len(), 2);
    assert!(
        transitions
            .iter()
            .all(|transition| transition.condition().unwrap().expression().is_some())
    );
}

#[test]
fn implicit_tracks_retain_source_and_distinguish_property_named_targets() {
    use liva_syntax::ast::{AnimationProperty, HasHeader, PropertyBlock, animation_properties};

    let source = "// 😀\r\nmotion sample { @tween() layer base { opacity: 1; @tween() --future /* track */ ~> { 0%: 0 @easeOut; 100%: 1 } opacity { scale: 1 } self { translate: 0 0 } } }";
    let parsed = parse(source);

    assert!(parsed.diagnostics.is_empty(), "{:?}", parsed.diagnostics);
    assert_eq!(parsed.root.text(), source);

    let motion = parsed.root.motions().next().unwrap();
    let layer = motion.layers().next().unwrap();
    let direct: Vec<_> = animation_properties(&layer).collect();

    assert_eq!(direct.len(), 2);
    assert!(
        matches!(&direct[1], AnimationProperty::Keyframes(track) if track.header().as_deref() == Some("--future"))
    );
    assert_eq!(
        layer
            .targets()
            .map(|target| target.header().unwrap())
            .collect::<Vec<_>>(),
        ["opacity", "self"]
    );
    assert_eq!(layer.children::<PropertyBlock>().count(), 1);
}

#[test]
fn explicit_self_decorators_and_properties_keep_typed_accessors_and_ranges() {
    use liva_syntax::ast::{HasHeader, HasItems};

    let source =
        "// 日本😀\r\nmotion sample { layer base { opacity: 1; @spring() self { scale: 1 } } }";
    let parsed = parse(source);
    let motion = parsed.root.motions().next().unwrap();
    let layer = motion.layers().next().unwrap();
    let target = layer.targets().next().unwrap();

    assert!(parsed.diagnostics.is_empty());
    assert_eq!(parsed.root.text(), source);
    assert_eq!(target.header().as_deref(), Some("self"));
    assert_eq!(
        target.properties().next().unwrap().header().as_deref(),
        Some("scale")
    );
    assert_eq!(
        &source[target.range().start..target.range().end],
        "@spring() self { scale: 1 }"
    );
}
