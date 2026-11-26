mod support;
use liva_compiler::{
    compile,
    edits::{Edit, apply_edits},
};
use support::valid;

#[test]
fn groups_equal_independent_blocks_in_every_scope() {
    for body in [
        "layer base { BODY }",
        "layer base { BODY state idle initial {} }",
        "layer base { state idle initial { BODY } }",
        "layer base { self, icon { opacity: 1 } state idle initial {} state active {} transition idle -> active when true { BODY } }",
        "layer base { icon {} } enter { BODY }",
        "layer base { icon {} } leave { BODY }",
    ] {
        let group = "@spring() self, icon { opacity: .5 @tween(duration: 20) }";
        let separate = "@spring() self { opacity: .5 @tween(duration: 20) } @spring() icon { opacity: .5 @tween(duration: 20) }";
        let source = format!("motion sample {{ {} }}", body.replace("BODY", group));
        let expected = format!("motion sample {{ {} }}", body.replace("BODY", separate));
        assert_eq!(
            valid(&source).definitions,
            valid(&expected).definitions,
            "{source}"
        );
        let compiled = valid(&source);
        let mappings = compiled.mappings.unwrap();
        for (path, field) in &mappings {
            if path.ends_with("/target/self/property/opacity")
                && source[field.range.start..field.range.end].contains(".5")
            {
                let sibling = &mappings[&path.replace("/target/self/", "/target/icon/")];
                assert_eq!(field.range, sibling.range);
            }
        }
    }
}

#[test]
fn repeated_targets_keep_each_blocks_timing_and_property_override() {
    let source = "motion sample { @tween(duration: 10) layer base {
        opacity: 1
        @spring() self, icon { scale: 1.1; rotate: 10deg @tween(duration: 30) }
        @tween(duration: 20) self, icon { translate: 2px }
        icon { opacity: .8 }
    } }";
    let compiled = valid(source);
    for target in &compiled.definitions[0].layers[0].targets {
        assert!(target.timing_expression.is_none());
        for property in &target.properties {
            let property = property.css().unwrap();
            let serialized = serde_json::to_string(&property.timing_expression).unwrap();
            match property.name.as_str() {
                "opacity" => assert_eq!(serialized, "null"),
                "scale" => assert!(serialized.contains("spring")),
                "rotate" => assert!(serialized.contains("30")),
                "translate" => assert!(serialized.contains("20")),
                _ => unreachable!(),
            }
        }
    }
    let fields = compiled.mappings.unwrap();
    let field = &fields["sample/layer/base/target/self/property/scale/blockTiming"];
    assert_eq!(&source[field.range.start..field.range.end], "spring()");
}

#[test]
fn duplicates_and_unknown_lifecycle_targets_are_diagnosed() {
    for body in [
        "layer base { self, self { opacity: 1 } }",
        "layer base { self, icon { opacity: 1 } icon { opacity: 0 } }",
        "layer base { opacity: 1; self, icon { opacity: 0 } }",
        "layer base { state idle initial { self, icon { opacity: 1 } icon { opacity: 0 } } }",
        "layer base { icon { opacity: 1 } state idle initial {} state active {} transition idle -> active when true { self, icon { opacity: 1 } icon { opacity: 0 } } }",
        "layer base { icon {} } @tween() enter { self, icon { opacity: 1 } icon { opacity: 0 } }",
        "layer base { icon {} } @tween() leave { self, icon { opacity: 1 } icon { opacity: 0 } }",
    ] {
        let source = format!("// 日本😀\r\nmotion sample {{ {body} }}");
        let result = compile(&source, true);
        assert!(result.definitions.is_empty(), "{source}");
        assert!(
            result
                .diagnostics
                .iter()
                .any(|d| d.code == "semantic.duplicate" && d.related.len() == 1),
            "{:?}",
            result.diagnostics
        );
    }
    let source = "motion sample { layer base {} @tween() enter { self, unknown { opacity: 0 } } }";
    let result = compile(source, true);
    let unknown = result
        .diagnostics
        .iter()
        .find(|d| d.message.contains("Unknown lifecycle target: unknown"))
        .unwrap();
    assert_eq!(&source[unknown.range.start..unknown.range.end], "unknown");
    assert!(
        result
            .diagnostics
            .iter()
            .any(|d| d.message.contains("Unknown lifecycle target: unknown"))
    );
}

fn set(target: &str, value: &str) -> Edit {
    Edit::Set {
        path: format!("sample/layer/base/target/{target}/property/scale/value"),
        value: value.into(),
    }
}

#[test]
fn editing_one_member_preserves_siblings_and_repeated_source_edits() {
    for selected in ["self", "icon", "label"] {
        let source = "// 日本😀\r\nmotion sample {\r\n  layer base {\r\n    @spring(stiffness: 400)\r\n    self, /* keep */ icon, label {\r\n      // property comment\r\n      scale: 1.1\r\n      opacity ~> { 50%: .5; 100%: 1 }\r\n    }\r\n  }\r\n}";
        let result = apply_edits(source, &[set(selected, "1.2"), set(selected, "1.3")]).unwrap();
        assert!(result.source.starts_with("// 日本😀\r\n"));
        assert!(result.source.contains("/* keep */"));
        assert!(result.source.contains("// property comment\r\n"));
        let original = valid(source);
        for target in &result.compilation.definitions[0].layers[0].targets {
            let before = original.definitions[0].layers[0]
                .targets
                .iter()
                .find(|t| t.name == target.name)
                .unwrap();
            assert_eq!(target.timing_expression, before.timing_expression);
            assert_eq!(target.properties[1], before.properties[1]);
            if target.name != selected {
                assert_eq!(target, before);
            } else {
                assert!(
                    serde_json::to_string(&target.properties[0])
                        .unwrap()
                        .contains("1.3")
                );
            }
        }
    }
}

#[test]
fn identical_all_member_edits_keep_group_and_noop_does_not_split() {
    let source = "motion sample { layer base { @spring() self, icon { scale: 1.1 } } }";
    assert_eq!(
        apply_edits(source, &[set("icon", "1.1")]).unwrap().source,
        source
    );
    let result = apply_edits(source, &[set("self", "1.2"), set("icon", "1.2")]).unwrap();
    assert_eq!(result.source, source.replace("1.1", "1.2"));
}

#[test]
fn target_completion_and_hover_include_each_reference() {
    let source = "motion sample { layer base { self, icon { opacity: 1 } } }";
    let hovers = liva_compiler::analysis::hovers(source);
    for name in ["self", "icon"] {
        assert!(
            hovers
                .iter()
                .any(|h| &source[h.range.start..h.range.end] == name
                    && h.label == format!("{name}: target"))
        );
    }
    let offset = source.find(", icon").unwrap() + 2;
    let choices = liva_compiler::analysis::completions(source, offset);
    assert!(choices.iter().any(|c| c.label == "self"));
    assert!(choices.iter().any(|c| c.label == "icon"));
    assert!(choices.iter().all(|c| c.detail == "target"));
}

#[test]
fn group_member_timing_and_keyframe_edits_round_trip_every_scope() {
    for (body, path) in [
        ("layer base { BODY }", "sample/layer/base"),
        (
            "layer base { state idle initial { BODY } }",
            "sample/layer/base/state/idle",
        ),
        (
            "layer base { self, icon { opacity: 1 } state idle initial {} state active {} transition idle -> active when true { BODY } }",
            "sample/layer/base/transition/0",
        ),
        ("layer base { icon {} } enter { BODY }", "sample/enter"),
        ("layer base { icon {} } leave { BODY }", "sample/leave"),
    ] {
        let source = format!(
            "motion sample {{ {} }}",
            body.replace(
                "BODY",
                "@spring() self, icon { opacity ~> { 0%: 0; 100%: 1 } }"
            )
        );
        let track = format!("{path}/target/icon/property/opacity");
        let edits = [
            Edit::Timing {
                path: track.clone(),
                value: Some("tween(duration: 50)".into()),
            },
            Edit::AddFrame {
                path: track.clone(),
                offset: 0.5,
                value: ".7".into(),
                easing: Some("linear".into()),
            },
            Edit::Set {
                path: format!("{track}/frame/0.5/offset"),
                value: "60%".into(),
            },
            Edit::Easing {
                path: format!("{track}/frame/0.6"),
                value: Some("easeIn".into()),
            },
            Edit::RemoveFrame {
                path: format!("{track}/frame/0.6"),
            },
            Edit::Timing {
                path: track.clone(),
                value: None,
            },
        ];
        let result = apply_edits(&source, &edits).unwrap();
        assert_eq!(
            result.compilation.definitions,
            valid(&source).definitions,
            "{source}"
        );
        assert!(result.source.contains("self"));
        let fields = result.compilation.mappings.unwrap();
        assert_ne!(
            fields[&track].range,
            fields[&track.replace("/icon/", "/self/")].range
        );
    }
}

#[test]
fn all_member_edit_detection_preserves_transaction_order() {
    let source = "motion sample { layer base { self, icon { scale: 1 } } }";
    let result = apply_edits(
        source,
        &[set("self", "2"), set("icon", "3"), set("icon", "2")],
    )
    .unwrap();
    for target in &result.compilation.definitions[0].layers[0].targets {
        assert!(
            serde_json::to_string(&target.properties[0])
                .unwrap()
                .contains("\"2\"")
        );
    }
}

#[test]
fn repeated_block_defaults_equal_local_defaults_in_every_scope() {
    for scope in [
        "layer base { BODY }",
        "layer base { BODY state idle initial {} }",
        "layer base { state idle initial { BODY } }",
        "layer base { self, icon { opacity: 1; scale: 1 } state idle initial {} state active {} transition idle -> active when true { BODY } }",
        "layer base { icon {} } enter { BODY }",
        "layer base { icon {} } leave { BODY }",
    ] {
        let grouped =
            "@spring() self, icon { scale: 1.2 } @tween(duration: 200) self, icon { opacity: .8 }";
        let local = "self { scale: 1.2 @spring(); opacity: .8 @tween(duration: 200) } icon { scale: 1.2 @spring(); opacity: .8 @tween(duration: 200) }";
        assert_eq!(
            valid(&format!(
                "motion sample {{ {} }}",
                scope.replace("BODY", grouped)
            ))
            .definitions,
            valid(&format!(
                "motion sample {{ {} }}",
                scope.replace("BODY", local)
            ))
            .definitions,
            "{scope}"
        );
    }
}

#[test]
fn adding_a_frame_to_one_shorthand_does_not_convert_siblings() {
    let source = "motion sample { layer base { @tween() self, icon { scale: 1 } } }";
    let result = apply_edits(
        source,
        &[Edit::AddFrame {
            path: "sample/layer/base/target/icon/property/scale".into(),
            offset: 0.5,
            value: "1.2".into(),
            easing: Some("easeIn".into()),
        }],
    )
    .unwrap();
    assert_eq!(
        result.compilation.definitions[0].layers[0].targets[0],
        valid(source).definitions[0].layers[0].targets[0]
    );
    assert!(result.source.contains("scale ~>"));
}

#[test]
fn equal_multi_property_edits_keep_the_group_despite_interleaved_member_order() {
    let source = "motion sample { layer base { self, icon { scale: 1; opacity: 1 } } }";
    let opacity = |target: &str| Edit::Set {
        path: format!("sample/layer/base/target/{target}/property/opacity/value"),
        value: ".5".into(),
    };
    let result = apply_edits(
        source,
        &[
            set("self", "2"),
            opacity("icon"),
            set("icon", "2"),
            opacity("self"),
        ],
    )
    .unwrap();
    assert_eq!(
        result.source,
        source
            .replace("scale: 1", "scale: 2")
            .replace("opacity: 1", "opacity: .5")
    );
}

#[test]
fn unchanged_timing_and_easing_leave_groups_intact() {
    let source = "motion sample { layer base { self, icon { @tween() scale ~> { 0%: 0 @easeIn; 100%: 1 } } } }";
    let path = "sample/layer/base/target/icon/property/scale";
    let result = apply_edits(
        source,
        &[
            Edit::Timing {
                path: path.into(),
                value: Some("tween()".into()),
            },
            Edit::Easing {
                path: format!("{path}/frame/0"),
                value: Some("easeIn".into()),
            },
            Edit::Easing {
                path: format!("{path}/frame/1"),
                value: None,
            },
        ],
    )
    .unwrap();
    assert_eq!(result.source, source);
}

#[test]
fn all_member_detection_does_not_skip_invalid_sibling_edit_destinations() {
    let source =
        "motion sample { layer base { @spring() self, icon { scale: 1 } self { opacity: 1 } } }";
    let edit = |target: &str| Edit::Set {
        path: format!("sample/layer/base/target/{target}/property/scale/blockTiming"),
        value: "tween()".into(),
    };
    // Only self has multiple blocks and therefore a lowered blockTiming mapping.
    assert!(apply_edits(source, &[edit("self"), edit("icon")]).is_err());
    let source = "motion sample { layer base { self { scale: 1 } icon {} } @tween() enter { self, icon {} } }";
    let edit = |target: &str| Edit::AddFrame {
        path: format!("sample/enter/target/{target}/property/scale"),
        offset: 0.5,
        value: "2".into(),
        easing: None,
    };
    assert!(apply_edits(source, &[edit("self"), edit("icon")]).is_err());
}

#[test]
fn matching_edits_in_distinct_source_blocks_remain_independent() {
    for lifecycle in ["enter", "leave"] {
        let source = format!(
            "motion sample {{ layer base {{ self, icon {{ scale: 1 }} }} @tween() {lifecycle} {{ self, icon {{}} icon {{ scale: .5 }} }} }}"
        );
        for frame in [false, true] {
            let edit = |name: &str| {
                let path = format!("sample/{lifecycle}/target/{name}/property/scale");
                if frame {
                    Edit::AddFrame {
                        path,
                        offset: 0.5,
                        value: "2".into(),
                        easing: None,
                    }
                } else {
                    Edit::Timing {
                        path,
                        value: Some("spring()".into()),
                    }
                }
            };
            for names in [["self", "icon"], ["icon", "self"]] {
                let first = apply_edits(&source, &[edit(names[0])]).unwrap();
                let separate = apply_edits(&first.source, &[edit(names[1])]).unwrap();
                let together = apply_edits(&source, &[edit(names[0]), edit(names[1])]).unwrap();
                assert_eq!(
                    together.compilation.definitions,
                    separate.compilation.definitions
                );
                assert_eq!(together.source, separate.source);
            }
        }
    }
}

#[test]
fn ambiguous_group_names_are_diagnosed_before_editing_in_every_scope() {
    for body in [
        "layer base { BODY }",
        "layer base { BODY state idle initial {} }",
        "layer base { state idle initial { BODY } }",
        "layer base { state idle initial {} state active {} transition idle -> active when true { BODY } }",
        "layer base {} @tween() enter { BODY }",
        "layer base {} @tween() leave { BODY }",
    ] {
        let in_layer = body.starts_with("layer base { BODY");
        for name in ["let", "event", "state", "enter", "leave", "transition"] {
            if !in_layer && !matches!(name, "let" | "event") {
                continue;
            }
            for header in [
                format!("self, {name}"),
                format!("{name}, self"),
                format!("{name} /* keep */ , self"),
            ] {
                let source = format!(
                    "// 日本😀\r\nmotion sample {{ {} }}",
                    body.replace("BODY", &format!("@spring() {header} {{ scale: 1 }}"))
                );
                let result = compile(&source, true);
                assert!(result.definitions.is_empty(), "{source}");
                let diagnostic = result
                    .diagnostics
                    .iter()
                    .find(|d| d.code == "syntax.target-name")
                    .unwrap_or_else(|| panic!("{source}: {:?}", result.diagnostics));
                assert_eq!(&source[diagnostic.range.start..diagnostic.range.end], name);
                assert!(diagnostic.message.contains("rename this target"));
            }
        }
    }
}

#[test]
fn unambiguous_keyword_targets_keep_singleton_and_group_editing_compatibility() {
    for name in [
        "state",
        "enter",
        "leave",
        "transition",
        "on",
        "motion",
        "layer",
        "when",
        "initial",
    ] {
        for (body, path) in [
            ("layer base { BODY }", "sample/layer/base"),
            (
                "layer base { BODY state idle initial {} }",
                "sample/layer/base",
            ),
            (
                "layer base { state idle initial { BODY } }",
                "sample/layer/base/state/idle",
            ),
            (
                "layer base { state idle initial { scale: 1; NAME { scale: 1 } } state active {} transition idle -> active when true { BODY } }",
                "sample/layer/base/transition/0",
            ),
            (
                "layer base { state idle initial { scale: 1; NAME { scale: 1 } } } enter { BODY }",
                "sample/enter",
            ),
            (
                "layer base { state idle initial { scale: 1; NAME { scale: 1 } } } leave { BODY }",
                "sample/leave",
            ),
        ] {
            if path == "sample/layer/base"
                && matches!(name, "state" | "enter" | "leave" | "transition")
            {
                continue;
            }
            let source = |header: &str| {
                format!(
                    "motion sample {{ {} }}",
                    body.replace("NAME", name)
                        .replace("BODY", &format!("@spring() {header} {{ scale: 1 }}"))
                )
            };
            let edit = Edit::Timing {
                path: format!("{path}/target/{name}/property/scale"),
                value: Some("tween(duration: 20)".into()),
            };
            apply_edits(&source(name), std::slice::from_ref(&edit))
                .unwrap_or_else(|e| panic!("{}: {path}: {e}", source(name)));
            for header in [
                format!("self, {name}"),
                format!("{name}, self"),
                format!("{name} /* keep */ , self"),
            ] {
                let grouped = source(&header);
                let result = apply_edits(&grouped, std::slice::from_ref(&edit)).unwrap();
                let expected = format!(
                    "motion sample {{ {} }}",
                    body.replace("NAME", name).replace(
                        "BODY",
                        &format!("@spring() self {{ scale: 1 }} @spring() {name} {{ scale: 1 @tween(duration: 20) }}")
                    )
                );
                assert_eq!(
                    result.compilation.definitions,
                    valid(&expected).definitions,
                    "{grouped}"
                );
                let again = apply_edits(
                    &result.source,
                    &[Edit::Timing {
                        path: format!("{path}/target/{name}/property/scale"),
                        value: Some("tween(duration: 30)".into()),
                    }],
                )
                .unwrap();
                assert!(again.source.contains("tween(duration: 30)"));
            }
        }
    }
}

#[test]
fn incomplete_group_headers_offer_only_targets_in_all_target_scopes() {
    for body in [
        "layer base { icon {} BODY }",
        "layer base { icon {} BODY state idle initial {} }",
        "layer base { icon {} state idle initial { BODY } }",
        "layer base { icon {} state idle initial {} state active {} transition idle -> active when true { BODY } }",
        "layer base { icon {} } enter { BODY }",
        "layer base { icon {} } leave { BODY }",
    ] {
        for header in [
            "self, ic¦",
            "self, ¦",
            "self,\r\n /* keep */ ic¦",
            "@spring() self, ic¦",
        ] {
            let marked = format!("motion sample {{ {} }}", body.replace("BODY", header));
            let offset = marked.find('¦').unwrap();
            let source = marked.replace('¦', "");
            let choices = liva_compiler::analysis::completions(&source, offset);
            assert!(
                choices.iter().any(|c| c.label == "icon"),
                "{marked}: {choices:?}"
            );
            assert!(choices.iter().all(|c| c.detail == "target"), "{marked}");
        }
    }
    for marked in [
        "motion sample { layer base { icon {} self, /* ic¦ */ } }",
        "motion sample { layer base { icon {} self, // ic¦\n } }",
        "motion sample { layer base { icon {} self, icon { scale: ic¦ } } }",
        "motion sample { layer base { icon {} self, icon { scale: 'self, ic¦' } } }",
        "motion sample { layer base { icon {} self, icon { scale ~> { self, ic¦ } } } }",
    ] {
        let offset = marked.find('¦').unwrap();
        let source = marked.replace('¦', "");
        assert!(
            liva_compiler::analysis::completions(&source, offset).is_empty(),
            "{marked}"
        );
    }
}

#[test]
fn shared_block_decorator_writes_preserve_transaction_order() {
    let source = "motion sample { layer base { @spring() self, icon { scale: 1; opacity: 1 } self, icon { rotate: 0deg } } }";
    let timing = |target: &str, property: &str, duration: u32| Edit::Set {
        path: format!("sample/layer/base/target/{target}/property/{property}/blockTiming"),
        value: format!("tween(duration: {duration})"),
    };
    for middle_target in ["self", "icon"] {
        for duration in [20, 50] {
            let edits = [
                timing("self", "scale", 20),
                timing(middle_target, "opacity", duration),
                timing("icon", "scale", 20),
            ];
            let mut sequential = source.to_string();
            for edit in &edits {
                sequential = apply_edits(&sequential, std::slice::from_ref(edit))
                    .unwrap()
                    .source;
            }
            let batch = apply_edits(source, &edits).unwrap();
            assert_eq!(
                batch.compilation.definitions,
                valid(&sequential).definitions
            );
            let mapping = &batch.compilation.mappings.as_ref().unwrap()["sample/layer/base/target/icon/property/scale/blockTiming"];
            assert_eq!(
                &batch.source[mapping.range.start..mapping.range.end],
                "tween(duration: 20)"
            );
        }
    }
    let edits = [
        timing("self", "scale", 20),
        set("icon", "2"),
        timing("icon", "scale", 20),
    ];
    let batch = apply_edits(source, &edits).unwrap();
    let mut sequential = source.to_string();
    for edit in &edits {
        sequential = apply_edits(&sequential, std::slice::from_ref(edit))
            .unwrap()
            .source;
    }
    assert_eq!(
        batch.compilation.definitions,
        valid(&sequential).definitions
    );
    let equal = apply_edits(
        source,
        &[timing("self", "scale", 20), timing("icon", "scale", 20)],
    )
    .unwrap();
    assert_eq!(
        equal.source,
        source.replace("spring()", "tween(duration: 20)")
    );
}

#[test]
fn adjacent_identical_shared_decorator_requests_keep_three_member_groups() {
    let source = "motion sample { layer base { @spring() self, icon, label { scale: 1; opacity: 1 } self, icon, label { rotate: 0deg } } }";
    let edits = ["self", "icon", "label"].map(|name| Edit::Set {
        path: format!("sample/layer/base/target/{name}/property/scale/blockTiming"),
        value: "tween(duration: 20)".into(),
    });
    assert_eq!(
        apply_edits(source, &edits).unwrap().source,
        source.replace("spring()", "tween(duration: 20)")
    );
}
