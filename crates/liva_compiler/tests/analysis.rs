use liva_compiler::analysis::hovers;

#[test]
fn resolves_forward_bindings_members_and_motion_local_types() {
    let source = r#"
motion first(value: number) {
  let doubled = later * 2
  let later = value
  let movement = drag(target: body)
  layer idle { body { opacity: ${doubled} } }
  layer active when movement.active { body { opacity: ${movement.offset.x} } }
}
motion second(value: string) {
  layer idle { body { content: ${value} } }
}
"#;
    let labels: Vec<_> = hovers(source)
        .into_iter()
        .map(|hover| hover.label)
        .collect();

    for expected in [
        "value: number",
        "value: string",
        "doubled: number",
        "later: number",
        "body: target",
        "movement.active: boolean",
        "movement.offset.x: number",
    ] {
        assert!(
            labels.iter().any(|label| label == expected),
            "{expected}: {labels:?}"
        );
    }

    assert!(
        labels
            .iter()
            .any(|label| label.starts_with("drag(target: target): { active: boolean"))
    );
}

#[test]
fn excludes_comments_strings_and_opaque_css_but_survives_errors() {
    let source = r#"
motion test(value: number) {
  // value
  let invalid = value + true
  let cycle = cycle
  let quoted = "value"
  layer idle {
    body { value: value; opacity: ${value} }
  }
}
"#;
    let found = hovers(source);
    let value_offsets: Vec<_> = found
        .iter()
        .filter(|hover| hover.label == "value: number")
        .map(|hover| hover.range.start)
        .collect();

    assert_eq!(
        value_offsets,
        vec![
            source.find("value: number").unwrap(),
            source.find("value +").unwrap(),
            source.find("${value}").unwrap() + 2
        ]
    );
    assert!(!found.iter().any(|hover| hover.label.starts_with("cycle:")));
    assert!(found.iter().any(|hover| hover.label == "quoted: string"));
}

#[test]
fn hyphenated_names_have_whole_identifier_hover_ranges() {
    let source = r#"motion demo(max-value: number) {
  let adjusted-value = max-value - 1
  let pointer-state = drag(target: main-body)
  layer idle { main-body { opacity: ${adjusted-value} } }
  layer active when pointer-state.active { main-body { opacity: ${max-value} } }
}"#;
    let found = hovers(source);
    for name in ["max-value", "adjusted-value", "main-body"] {
        let expected: Vec<_> = source
            .match_indices(name)
            .map(|(offset, _)| offset)
            .collect();
        let actual: Vec<_> = found
            .iter()
            .filter(|hover| hover.label.starts_with(&format!("{name}:")))
            .map(|hover| {
                assert_eq!(&source[hover.range.start..hover.range.end], name);
                hover.range.start
            })
            .collect();
        assert_eq!(actual, expected, "{name}");
    }
}

#[test]
fn lifecycle_templates_expose_typed_hovers_in_both_property_forms() {
    let source = "// 日本語\r\nmotion panel(distance: number) { layer idle { body { translate: 0px 0 } } @tween(duration: 1) enter { body { translate: ${distance}px 0 } } @tween(duration: 1) leave { body { translate { 100%: ${distance}px 0 } } } }";
    let found = hovers(source);
    let expected: Vec<_> = source
        .match_indices("${distance}")
        .map(|(start, _)| start + 2)
        .collect();

    for start in expected {
        assert!(
            found
                .iter()
                .any(|hover| hover.range.start == start && hover.label == "distance: number")
        );
    }
}

#[test]
fn layer_guards_and_decorators_expose_expression_types_at_source_offsets() {
    let source = r#"motion card(active: boolean, duration: number) {
      let curve = easeOut
      layer base { @tween(duration: duration, easing: curve) body { opacity: 1 } }
      layer hover when active { body { opacity: .5 } }
      layer workflow {
        layer idle initial {}
        state busy {}
        transition idle -> busy when active
      }
    }"#;
    let found = hovers(source);

    for (text, label) in [
        ("duration,", "duration: number"),
        ("curve)", "curve: easing"),
        ("active {", "active: boolean"),
        ("active\n", "active: boolean"),
    ] {
        let offset = source.find(text).unwrap();

        assert!(
            found
                .iter()
                .any(|hover| hover.range.start == offset && hover.label == label),
            "{text}: {found:?}"
        );
    }

    assert!(found.iter().any(|hover| hover.label.starts_with("tween(")
        && hover.range.start == source.find("tween(").unwrap()));
}
