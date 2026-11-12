use liva_compiler::analysis::{Completion, completions, hovers};

fn analyze(marked: &str) -> (String, Vec<Completion>) {
    let offset = marked.find('¦').unwrap();
    let source = marked.replace('¦', "");

    let found = completions(&source, offset);

    (source, found)
}

fn literal_items(items: &[Completion]) -> Vec<&Completion> {
    items
        .iter()
        .filter(|item| item.text_edit.is_some())
        .collect()
}

fn apply(source: &str, item: &Completion) -> String {
    let edit = item.text_edit.as_ref().unwrap();
    let mut result = source.to_owned();

    result.replace_range(edit.range.start..edit.range.end, &edit.new_text);

    result
}

fn assert_edits_compile(source: &str, items: &[&Completion]) {
    for item in items {
        let edited = apply(source, item);

        let compiled = liva_compiler::compile(&edited, false);

        assert!(
            !compiled.definitions.is_empty(),
            "{edited}: {:?}",
            compiled.diagnostics
        );
        assert!(
            compiled.diagnostics.is_empty(),
            "{edited}: {:?}",
            compiled.diagnostics
        );
    }
}

#[test]
fn empty_values_offer_metadata_literals_alongside_names() {
    let (source, found) = analyze(
        "motion a { let permitted = 'end'; let curve = steps(count: 4, position: ¦); layer base {} }",
    );
    let literals = literal_items(&found);

    assert_eq!(
        literals
            .iter()
            .map(|item| item.label.as_str())
            .collect::<Vec<_>>(),
        [
            r#""end""#,
            r#""jump-both""#,
            r#""jump-end""#,
            r#""jump-none""#,
            r#""jump-start""#,
            r#""start""#
        ]
    );
    assert!(found.iter().any(|item| item.label == "permitted"
        && item.detail == r#""end""#
        && item.text_edit.is_none()));
    assert!(
        found
            .iter()
            .any(|item| item.label == "steps" && item.text_edit.is_none())
    );

    assert_edits_compile(&source, &literals);
}

#[test]
fn quoted_prefix_edits_replace_whole_closed_values_and_only_unclosed_prefixes() {
    for value in [r#""ju¦nk""#, "'ju¦nk'", r#"("ju¦nk")"#, r#""ju¦"#] {
        let (source, found) = analyze(&format!(
            "motion a {{ let curve = steps(count: 4, position: {value}); layer base {{}} }}"
        ));
        let literals = literal_items(&found);

        assert_eq!(literals.len(), 4, "{source}: {found:?}");
        assert!(
            literals
                .iter()
                .all(|item| item.label.starts_with(r#""jump-"#))
        );

        assert_edits_compile(&source, &literals);
    }
}

#[test]
fn a_bad_escape_after_the_cursor_does_not_leave_a_duplicate_closing_quote() {
    let (source, found) =
        analyze(r#"motion a { let curve = steps(count: 4, position: "st¦\q"); layer base {} }"#);
    let literals = literal_items(&found);

    assert_eq!(literals.len(), 1);
    assert_eq!(literals[0].label, r#""start""#);

    assert_edits_compile(&source, &literals);
}

#[test]
fn nested_decorator_arguments_use_their_original_source_ranges() {
    for body in [
        "@tween(easing: steps(count: 4, position: ¦)) layer base {}",
        "layer base { opacity: 1 @tween(easing: steps(count: 4, position: ¦)) }",
        "layer base { opacity ~> { 0%: 0 @steps(count: 4, position: 'st¦ale')\n100%: 1 } }",
    ] {
        let (source, found) = analyze(&format!("// 日本語😀\r\nmotion a {{ {body} }}"));
        let literals = literal_items(&found);

        assert!(!literals.is_empty(), "{source}: {found:?}");

        assert_edits_compile(&source, &literals);
    }
}

#[test]
fn other_arguments_and_local_shadows_filter_component_candidates() {
    for (declarations, call, expected) in [
        ("", "link(input: 1, component: ¦)", 2),
        ("", "link(component: '¦invalid', input: 1)", 2),
        (
            "let pointer = drag(target: self)",
            "link(input: pointer.offset, component: ¦)",
            0,
        ),
        ("", "link(input: true, component: ¦)", 0),
        ("", "link(input: 1, unknown: true, component: ¦)", 0),
        ("", "link(input: 1, component: 'x', component: ¦)", 0),
        ("let link = 1", "link(input: 1, component: ¦)", 0),
    ] {
        let (source, found) = analyze(&format!(
            "motion a {{ {declarations}; let movement = {call}; layer base {{ translate := movement }} }}"
        ));
        let literals = literal_items(&found);

        assert_eq!(literals.len(), expected, "{source}: {found:?}");

        if expected > 0 {
            assert_edits_compile(&source, &literals);
        }
    }
}

#[test]
fn comments_css_unrelated_strings_and_annotations_do_not_receive_argument_choices() {
    for body in [
        "let curve = steps(count: 4, position: /* ¦ */ 'end'); layer base {}",
        "let curve = steps(count: 4, position: // ¦\n'end'); layer base {}",
        "let label = 'steps(count: 4, position: ¦)'; layer base {}",
        "layer base { content: steps(count: 4, position: ¦) }",
        "// steps(count: 4, position: ¦)\nlayer base {}",
    ] {
        let (_, found) = analyze(&format!("motion a {{ {body} }}"));

        assert!(literal_items(&found).is_empty(), "{body}: {found:?}");
    }

    let (_, found) = analyze(r#"motion a(position: "start" | "¦end") { layer base {} }"#);

    assert!(literal_items(&found).is_empty());
}

#[test]
fn literal_and_union_hovers_share_notation_and_expose_fixed_metadata() {
    let source = r#"motion a(axis: 'x', position: 'start' | "end") {
        let alias = axis
        let curve = steps(count: 4, position: position)
        let movement = link(input: 1, component: alias)
        layer base { translate := movement }
    }"#;

    let found = hovers(source);

    for label in [
        r#"axis: "x""#,
        r#"alias: "x""#,
        r#"position: "end" | "start""#,
    ] {
        assert!(found.iter().any(|hover| hover.label == label), "{found:?}");
    }

    assert!(found.iter().any(|hover| hover.label.starts_with("steps(")
        && hover.label.contains(r#"position?: "end" | "jump-both""#)));
    assert!(
        found
            .iter()
            .any(|hover| hover.label.contains(r#"component: "x" | "y" (fixed)"#))
    );
}

#[test]
fn every_incomplete_prefix_returns_current_bounded_edits() {
    let source = "// 😀\r\nmotion a(axis: 'x' | 'y', position: 'start' | 'end') { let curve = steps(count: 4, position: 'jump-end'); layer base {} }";

    for end in (0..=source.len()).filter(|end| source.is_char_boundary(*end)) {
        let prefix = &source[..end];

        let found = completions(prefix, end);

        for item in found {
            if let Some(edit) = item.text_edit {
                assert!(edit.range.start <= edit.range.end);
                assert!(edit.range.end <= end);
                assert!(prefix.is_char_boundary(edit.range.start));
                assert!(prefix.is_char_boundary(edit.range.end));
            }
        }
    }

    assert!(completions(source, source.find('😀').unwrap() + 1).is_empty());
    assert!(completions(source, source.len() + 1).is_empty());
}

#[test]
fn automatic_trigger_boundaries_do_not_offer_expression_insertions_outside_expressions() {
    for marked in [
        "motion a { let curve = steps(count: 4, position: 'end'¦); layer base {} }",
        "motion a { let curve = steps(count: 4, position:¦ 'end'); layer base {} }",
        r#"motion a { let curve = steps(count: 4, position: "end"¦); layer base {} }"#,
        r#"motion a(axis:¦ "x" | "y") { layer base {} }"#,
        r#"motion a(axis: "x"¦) { layer base {} }"#,
        "motion a { layer base { color:¦ red } }",
        "motion a { // ¦
layer base {} }",
        "motion a { let label = 'unrelated¦'; layer base {} }",
    ] {
        let (_, found) = analyze(marked);

        assert!(found.is_empty(), "{marked}: {found:?}");
    }
}

#[test]
fn ordinary_empty_and_prefixed_expression_names_still_complete() {
    for marked in [
        "motion a { let value = ¦; layer base {} }",
        "motion a { let value = ea¦; layer base {} }",
        "motion a { layer active when ¦ {} }",
        "motion a { event changed when ¦\nlayer base {} }",
        "motion a { layer base { state active when ¦ {} } }",
        "motion a { layer base { state off initial {} state on {} transition off -> on when ¦ {} } }",
        "motion a { layer base { opacity: ${ea¦} } }",
        "motion a { layer base { opacity: ${¦} } }",
    ] {
        let (_, found) = analyze(marked);

        assert!(
            found.iter().any(|item| item.label == "easeOut"),
            "{marked}: {found:?}"
        );
        assert!(literal_items(&found).is_empty());
    }
}

#[test]
fn attachment_values_offer_controller_names_while_css_values_stay_opaque() {
    for (declaration, expected) in [
        ("translate := ¦", true),
        ("translate := move¦", true),
        ("translate := (¦)", true),
        ("translate: ¦", false),
        ("translate := /* ¦ */", false),
    ] {
        let (_, found) = analyze(&format!(
            "motion a {{ let movement = link(input: 1, component: 'x'); layer base {{ {declaration} }} }}"
        ));

        assert_eq!(
            found.iter().any(|item| item.label == "movement"),
            expected,
            "{declaration}: {found:?}"
        );
        assert!(literal_items(&found).is_empty());
    }
}

#[test]
fn later_string_values_do_not_suppress_earlier_name_or_member_completions() {
    for (marked, expected) in [
        (
            "motion a(position: string) { let matched = pos¦ == \"end\"; layer base {} }",
            "position",
        ),
        (
            "motion a(position: string) { let matched = (pos¦ == \"end\") && true; layer base {} }",
            "position",
        ),
        (
            "motion a { let ui = interaction(target: self); let matched = ui.fo¦ == (\"end\" == \"end\"); layer base {} }",
            "focusVisible",
        ),
    ] {
        let (_, found) = analyze(marked);

        assert!(
            found.iter().any(|item| item.label == expected),
            "{marked}: {found:?}"
        );
        assert!(literal_items(&found).is_empty());
    }
}

#[test]
fn ambiguous_unclosed_suffixes_and_unfinished_escapes_do_not_produce_edits() {
    for value in [r#""ju¦nk"#, "'ju¦nk", r#""ju¦\nk"#, r#""a\¦q"#, r#""a\¦"#] {
        let (_, found) = analyze(&format!(
            "motion a {{ let curve = steps(count: 4, position: {value}); layer base {{}} }}"
        ));

        assert!(found.is_empty(), "{value}: {found:?}");
    }
}
