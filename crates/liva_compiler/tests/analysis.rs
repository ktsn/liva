use liva_compiler::analysis::hovers;

#[test]
fn resolves_forward_bindings_members_and_motion_local_types() {
    let source = r#"
motion first(value: number) {
  let doubled = later * 2
  let later = value
  let movement = drag(target: body)
  state idle { body { opacity: ${doubled} } }
  state active when movement.active { body { opacity: ${movement.offset.x} } }
  transition { @tween: 100ms }
}
motion second(value: string) {
  state idle { body { content: ${value} } }
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
  state idle {
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
  state idle { main-body { opacity: ${adjusted-value} } }
  state active when pointer-state.active { main-body { opacity: ${max-value} } }
  transition { @tween: 100ms }
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
