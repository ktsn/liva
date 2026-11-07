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
    let source = "// 日本語\r\nmotion panel(distance: number) { layer idle { body { translate: 0px 0 } } @tween(duration: 1) enter { body { translate: ${distance}px 0 } } @tween(duration: 1) leave { body { translate ~> { 100%: ${distance}px 0 } } } }";
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

#[test]
fn interaction_function_and_members_expose_inferred_types() {
    let source = "motion a { let ui = interaction(target: body)\n layer hover when ui.hover && ui.active && ui.focus && ui.focusVisible && ui.focusWithin { body { opacity: 1 } } }";
    let labels: Vec<_> = hovers(source)
        .into_iter()
        .map(|hover| hover.label)
        .collect();

    for member in ["hover", "active", "focus", "focusVisible", "focusWithin"] {
        assert!(
            labels
                .iter()
                .any(|label| label == &format!("ui.{member}: boolean")),
            "{member}: {labels:?}"
        );
    }

    assert!(
        labels
            .iter()
            .any(|label| label.starts_with("interaction(target: target): { hover: boolean"))
    );
}

#[test]
fn completes_registered_interaction_function_and_inferred_record_members() {
    use liva_compiler::analysis::completions;

    let source = "motion button { let ui = interaction(target: body)\n layer base { body { opacity: 1 } }\n layer hover when ui.fo {} }";
    let point = source.find("ui.fo").unwrap() + "ui.fo".len();
    let found = completions(source, point);

    assert_eq!(
        found
            .iter()
            .map(|item| item.label.as_str())
            .collect::<Vec<_>>(),
        vec!["focus", "focusVisible", "focusWithin"]
    );
    assert!(found.iter().all(|item| item.detail == "boolean"));

    let source = "motion button { let ui = inter }";
    let found = completions(source, source.find("inter").unwrap() + 5);

    assert_eq!(found.len(), 1);
    assert_eq!(found[0].label, "interaction");
    assert!(found[0].detail.contains("target: target"));
}

#[test]
fn builtin_completions_respect_local_shadows_without_duplicate_candidates() {
    use liva_compiler::analysis::completions;

    for (declarations, prefix, detail) in [
        ("", "easeO", "easing"),
        ("let easeOut = 2;", "easeO", "number"),
        ("let tween = 2;", "twee", "number"),
    ] {
        let source =
            format!("motion example {{ {declarations} layer base {{ opacity: ${{{prefix}}} }} }}");
        let found = completions(
            &source,
            source.find(&format!("${{{prefix}")).unwrap() + 2 + prefix.len(),
        );

        assert_eq!(found.len(), 1, "{source}: {found:?}");
        assert_eq!(found[0].detail, detail);
    }
}

#[test]
fn call_hovers_show_the_shadowing_value_instead_of_a_builtin_signature() {
    let source = "motion example { let tween = 2; @tween()\nlayer base {} }";
    let offset = source.find("@tween").unwrap() + 1;
    let found = hovers(source);

    assert!(
        found
            .iter()
            .any(|hover| hover.range.start == offset && hover.label == "tween: number")
    );
    assert!(!found.iter().any(|hover| hover.label.starts_with("tween(")));
}

#[test]
fn incomplete_local_declarations_hide_builtin_completions() {
    use liva_compiler::analysis::completions;

    let source = "motion example { let tween = ; layer base { opacity: ${twee} } }";
    let offset = source.find("${twee}").unwrap() + "${twee".len();
    let found = completions(source, offset);

    assert!(found.is_empty(), "{found:?}");
}
