mod support;

use liva_compiler::{
    compile,
    edits::{Edit, apply_edits},
    ir::{Declaration, LayoutAxes},
};
use support::valid;

fn axes(source: &str) -> LayoutAxes {
    let result = valid(&format!(
        "motion item {{ layer base {{ $layout: {source} }} }}"
    ));
    let Declaration::Layout(declaration) =
        &result.definitions[0].layers[0].targets[0].properties[0]
    else {
        panic!("Expected a dedicated layout declaration")
    };

    declaration.axes
}

#[test]
fn normalizes_aliases_and_every_individual_axis_combination() {
    assert_eq!(axes("position size"), axes("x y width height"));
    assert_eq!(axes("size position"), axes("height width y x"));
    assert_eq!(axes("position height"), axes("x y height"));

    for mask in 0..16 {
        let names = ["x", "y", "width", "height"];
        let words: Vec<_> = names
            .iter()
            .enumerate()
            .filter_map(|(index, name)| ((mask & (1 << index)) != 0).then_some(*name))
            .collect();
        let value = if words.is_empty() {
            "none".into()
        } else {
            words.join(" ")
        };

        assert_eq!(
            axes(&value),
            LayoutAxes {
                x: mask & 1 != 0,
                y: mask & 2 != 0,
                width: mask & 4 != 0,
                height: mask & 8 != 0
            }
        );
    }
}

#[test]
fn preserves_root_self_named_state_declarations_and_css_order() {
    let source = include_str!("../../../fixtures/layout-config.liv");
    let result = valid(source);
    let definition = &result.definitions[0];
    let targets = &definition.layers[0].targets;

    assert!(matches!(targets[0].properties[0], Declaration::Layout(_)));
    assert_eq!(targets[0].properties[1].name(), "opacity");
    assert_eq!(targets[1].name, "content");
    assert!(matches!(
        definition.layers[1].targets[0].properties[0],
        Declaration::Layout(_)
    ));
    assert!(matches!(
        definition.layers[2].states[1].targets[0].properties[0],
        Declaration::Layout(_)
    ));
}

#[test]
fn diagnoses_unsupported_selection_forms_and_recovers_following_css() {
    for declaration in [
        "$layout:",
        "$layout: position x",
        "$layout: size height",
        "$layout: x x",
        "$layout: none x",
        "$layout: none none",
        "$layout: auto",
        "$layout: X",
        "$layout: \"position\"",
        "$layout: ${true}",
        "$layout := true",
        "$layout ~> { 50%: position; 100%: size }",
    ] {
        let result = compile(
            &format!("motion item {{ layer base {{ {declaration}; opacity: 1 }} }}"),
            true,
        );

        assert!(
            result
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "semantic.layout"),
            "{declaration}: {:?}",
            result.diagnostics
        );
        assert!(
            result
                .mappings
                .as_ref()
                .unwrap()
                .contains_key("item/layer/base/target/self/property/opacity")
        );
    }
}

#[test]
fn rejects_layout_selection_in_transitions_but_accepts_timing_only_overrides() {
    for body in [
        "$layout: position",
        "$layout ~> { 50%: size }",
        "$layout ~> { 100%: none }",
    ] {
        let result = compile(
            &format!(
                "motion item {{ layer phase {{ $layout: position; state off initial {{}} state on {{}} transition off -> on when true {{ {body} }} }} }}"
            ),
            false,
        );

        assert!(
            result
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "semantic.layout"),
            "{body}"
        );
    }

    valid(
        "motion item { layer phase { $layout: position; state off initial {} state on {} transition off -> on when true { @instant $layout ~> {} } } }",
    );
}

#[test]
fn rejects_duplicate_layout_across_root_forms_and_checks_timing_expressions() {
    let duplicate = compile(
        "motion item { layer base { $layout: x; self { $layout: y } } }",
        false,
    );
    let invalid_timing = compile("motion item { layer base { $layout: x @true } }", false);

    assert!(
        duplicate
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "semantic.duplicate")
    );
    assert!(
        invalid_timing
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "semantic.expression")
    );
}

#[test]
fn keeps_ordinary_css_custom_properties_and_interpolation_unchanged() {
    let result = valid(
        "motion item(value: number) { layer base { $layout: y; --future: ${value}; future-property: var(--future) } }",
    );
    let declarations = &result.definitions[0].layers[0].targets[0].properties;

    assert_eq!(declarations[1].name(), "--future");
    assert_eq!(declarations[2].name(), "future-property");
    assert!(declarations[1].css().is_some());
    assert!(declarations[2].css().is_some());
}

#[test]
fn exposes_read_only_utf8_source_ranges_without_postfix_timing_in_axes_range() {
    let source =
        "// 日本😀\r\nmotion item { layer base { $layout: y height @instant; opacity: 1 } }";
    let result = valid(source);
    let mappings = result.mappings.unwrap();
    let value = &mappings["item/layer/base/target/self/property/$layout/value"];
    let timing = &mappings["item/layer/base/target/self/property/$layout/timing"];

    assert_eq!(value.kind, "layout-value");
    assert_eq!(
        source[value.range.start..value.range.end].trim(),
        "y height"
    );
    assert_eq!(timing.kind, "layout-value");
    assert_eq!(&source[timing.range.start..timing.range.end], "instant");
}

#[test]
fn protects_layout_from_every_editor_edit_operation_and_preserves_source_on_css_edits() {
    let source =
        "motion item { layer base { $layout: y height @spring(stiffness: 300); opacity: .5 } }";
    let path = "item/layer/base/target/self/property/$layout";
    let edits = [
        Edit::Set {
            path: format!("{path}/value"),
            value: "none".into(),
        },
        Edit::Timing {
            path: path.into(),
            value: Some("instant".into()),
        },
        Edit::Easing {
            path: format!("{path}/frame/1"),
            value: Some("linear".into()),
        },
        Edit::AddFrame {
            path: path.into(),
            offset: 0.5,
            value: "position".into(),
            easing: None,
        },
        Edit::RemoveFrame {
            path: format!("{path}/frame/1"),
        },
    ];

    for edit in edits {
        assert!(
            apply_edits(source, &[edit])
                .unwrap_err()
                .contains("inspection-only")
        );
    }

    let updated = apply_edits(
        source,
        &[Edit::Set {
            path: "item/layer/base/target/self/property/opacity/value".into(),
            value: ".8".into(),
        }],
    )
    .unwrap();

    assert!(
        updated
            .source
            .contains("$layout: y height @spring(stiffness: 300)")
    );
    assert!(updated.source.contains("opacity: .8"));
}

#[test]
fn lifecycle_blocks_reject_layout_selection_and_timing_tracks() {
    for phase in ["enter", "leave"] {
        for body in ["$layout: position", "@instant $layout ~> {}"] {
            let source = format!(
                "motion item {{ layer base {{ $layout: position }} {phase} {{ {body} }} }}"
            );
            let result = compile(&source, false);

            assert!(
                result
                    .diagnostics
                    .iter()
                    .any(|diagnostic| diagnostic.code == "semantic.layout"),
                "{source}: {:?}",
                result.diagnostics
            );
        }
    }
}
