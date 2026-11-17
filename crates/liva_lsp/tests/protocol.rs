use lsp_server::{Connection, Message, Notification, Request, Response};
use serde_json::{Value, json};
use std::{thread, time::Duration};

fn receive(connection: &Connection) -> Message {
    connection
        .receiver
        .recv_timeout(Duration::from_secs(5))
        .expect("server response")
}

fn request(connection: &Connection, id: i32, method: &str, params: Value) -> Response {
    connection
        .sender
        .send(Message::Request(Request::new(
            id.into(),
            method.into(),
            params,
        )))
        .unwrap();
    let Message::Response(response) = receive(connection) else {
        panic!("expected response")
    };
    response
}

fn notify(connection: &Connection, method: &str, params: Value) {
    connection
        .sender
        .send(Message::Notification(Notification::new(
            method.into(),
            params,
        )))
        .unwrap();
}

fn diagnostics(connection: &Connection) -> Value {
    let Message::Notification(notification) = receive(connection) else {
        panic!("expected diagnostics")
    };
    assert_eq!(notification.method, "textDocument/publishDiagnostics");
    notification.params
}

#[test]
fn lifecycle_unsaved_changes_hover_diagnostics_and_close() {
    let (server, client) = Connection::memory();
    let worker = thread::spawn(move || liva_lsp::run(server).unwrap());
    let initialized = request(&client, 1, "initialize", json!({ "capabilities": {} }));
    assert_eq!(
        initialized.response_result.unwrap()["capabilities"]["textDocumentSync"]["change"],
        1
    );
    notify(&client, "initialized", json!({}));

    let uri = "file:///example.liv";
    let valid = "motion a(value: number) {\n let twice = value * 2\n layer idle { body { opacity: ${twice} } }\n}";
    notify(
        &client,
        "textDocument/didOpen",
        json!({ "textDocument": { "uri": uri, "languageId": "liva", "version": 1, "text": valid } }),
    );
    assert_eq!(diagnostics(&client)["diagnostics"], json!([]));

    let hover = request(
        &client,
        2,
        "textDocument/hover",
        json!({ "textDocument": { "uri": uri }, "position": { "line": 1, "character": 6 } }),
    );
    assert!(
        hover.response_result.unwrap()["contents"]["value"]
            .as_str()
            .unwrap()
            .contains("twice: number")
    );

    let invalid = valid.replace("value * 2", "value * true");
    notify(
        &client,
        "textDocument/didChange",
        json!({ "textDocument": { "uri": uri, "version": 2 }, "contentChanges": [{ "text": invalid }] }),
    );
    let errors = diagnostics(&client);
    assert_eq!(errors["version"], 2);
    assert!(
        errors["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(
                |error| error["message"] == "Incompatible expression operands"
                    && error["range"]
                        == json!({
                            "start": { "line": 1, "character": 21 },
                            "end": { "line": 1, "character": 25 },
                        })
            )
    );

    notify(
        &client,
        "textDocument/didChange",
        json!({ "textDocument": { "uri": uri, "version": 3 }, "contentChanges": [{ "text": valid }] }),
    );
    assert_eq!(diagnostics(&client)["diagnostics"], json!([]));

    // Older notifications must not replace the current buffer.
    notify(
        &client,
        "textDocument/didChange",
        json!({ "textDocument": { "uri": uri, "version": 2 }, "contentChanges": [{ "text": invalid }] }),
    );
    let hover = request(
        &client,
        3,
        "textDocument/hover",
        json!({ "textDocument": { "uri": uri }, "position": { "line": 1, "character": 6 } }),
    );
    assert!(
        hover.response_result.unwrap()["contents"]["value"]
            .as_str()
            .unwrap()
            .contains("twice: number")
    );

    notify(
        &client,
        "textDocument/didClose",
        json!({ "textDocument": { "uri": uri } }),
    );
    assert_eq!(diagnostics(&client)["diagnostics"], json!([]));
    let hover = request(
        &client,
        4,
        "textDocument/hover",
        json!({ "textDocument": { "uri": uri }, "position": { "line": 1, "character": 6 } }),
    );
    assert!(hover.response_result.unwrap().is_null());

    assert_eq!(
        request(&client, 5, "unknown", json!({}))
            .response_result
            .unwrap_err()
            .code,
        -32601
    );
    assert_eq!(
        request(&client, 6, "textDocument/hover", json!({}))
            .response_result
            .unwrap_err()
            .code,
        -32602
    );
    request(&client, 7, "shutdown", Value::Null);
    notify(&client, "exit", Value::Null);
    worker.join().unwrap();
}

#[test]
fn utf16_positions_validate_boundaries_and_crlf() {
    let text = "// 😀日本\r\nvalue";

    for (character, expected) in [
        (0, Some(0)),
        (3, Some(3)),
        (4, None),
        (5, Some(7)),
        (7, Some(13)),
        (8, None),
    ] {
        assert_eq!(
            liva_lsp::offset(text, liva_lsp::Position { line: 0, character }),
            expected
        );
    }

    assert_eq!(
        liva_lsp::position(text, 15),
        json!({ "line": 1, "character": 0 })
    );
    assert_eq!(
        liva_lsp::offset(
            text,
            liva_lsp::Position {
                line: 1,
                character: 5
            }
        ),
        Some(text.len())
    );
}

#[test]
fn diagnostic_ranges_map_to_utf16_in_liva_and_vue() {
    let (server, client) = Connection::memory();
    let worker = thread::spawn(move || liva_lsp::run(server).unwrap());
    request(&client, 1, "initialize", json!({ "capabilities": {} }));
    notify(&client, "initialized", json!({}));

    for (uri, text, expected) in [
        (
            "file:///range.liv",
            "motion a {\r\n let value = /* 日本😀 */ 1 + true;\r\n layer idle {}\r\n}",
            json!({ "start": { "line": 1, "character": 28 }, "end": { "line": 1, "character": 32 } }),
        ),
        (
            "file:///range.vue",
            "<template>😀</template>\r\n<liva lang=\"liva\">\r\nmotion a {\r\n let value = /* 日本😀 */ 1 + true;\r\n layer idle {}\r\n}\r\n</liva>",
            json!({ "start": { "line": 3, "character": 28 }, "end": { "line": 3, "character": 32 } }),
        ),
        (
            "file:///inline.vue",
            "<template>😀</template><liva lang=\"liva\">motion a { let value = 1 + true; layer idle {} }</liva>",
            json!({ "start": { "line": 0, "character": 68 }, "end": { "line": 0, "character": 72 } }),
        ),
        (
            "file:///multiline.liv",
            "motion a {\n let value = drag(target: (1 +\n 2));\n layer idle { body { opacity: 1 } }\n}",
            json!({ "start": { "line": 1, "character": 26 }, "end": { "line": 2, "character": 3 } }),
        ),
    ] {
        notify(
            &client,
            "textDocument/didOpen",
            json!({ "textDocument": {
            "uri": uri, "languageId": if uri.ends_with(".vue") { "vue" } else { "liva" }, "version": 1, "text": text,
        } }),
        );
        let result = diagnostics(&client);
        let errors = result["diagnostics"].as_array().unwrap();

        assert_eq!(errors.len(), 1, "{uri}: {result}");
        assert_eq!(errors[0]["range"], expected, "{uri}");
        assert_eq!(errors[0]["severity"], 1);
        assert_eq!(errors[0]["code"], "semantic.expression");
    }

    request(&client, 2, "shutdown", Value::Null);
    notify(&client, "exit", Value::Null);
    worker.join().unwrap();
}

fn with_server(run: impl FnOnce(&Connection)) {
    let (server, client) = Connection::memory();
    let worker = thread::spawn(move || liva_lsp::run(server).unwrap());

    request(&client, 1, "initialize", json!({"capabilities": {}}));
    notify(&client, "initialized", json!({}));

    run(&client);

    request(&client, 1000, "shutdown", Value::Null);
    notify(&client, "exit", Value::Null);

    worker.join().unwrap();
}

fn reference_position(text: &str, byte: usize) -> Value {
    let prefix = &text[..byte];

    json!({
        "line": prefix.split('\n').count() - 1,
        "character": prefix.rsplit('\n').next().unwrap().encode_utf16().count(),
    })
}

fn reference_range(text: &str, start: usize, end: usize) -> Value {
    json!({"start": reference_position(text, start), "end": reference_position(text, end)})
}

fn completion_result(client: &Connection, uri: &str, text: &str, byte: usize) -> Value {
    request(
        client,
        2,
        "textDocument/completion",
        json!({
            "textDocument": {"uri": uri}, "position": reference_position(text, byte),
        }),
    )
    .response_result
    .unwrap()
}

fn completion_at(client: &Connection, uri: &str, text: &str, byte: usize) -> Vec<Value> {
    let result = completion_result(client, uri, text, byte);

    result
        .as_array()
        .or_else(|| result["items"].as_array())
        .unwrap()
        .clone()
}

fn byte_at_utf16(text: &str, position: &Value) -> usize {
    let line = position["line"].as_u64().unwrap() as usize;
    let character = position["character"].as_u64().unwrap() as usize;
    let start: usize = text.split_inclusive('\n').take(line).map(str::len).sum();
    let line_text = text[start..]
        .split('\n')
        .next()
        .unwrap()
        .trim_end_matches('\r');
    let mut units = 0;

    for (byte, value) in line_text.char_indices() {
        if units == character {
            return start + byte;
        }

        units += value.len_utf16();
    }

    assert_eq!(units, character, "{text:?}: {position}");

    start + line_text.len()
}

fn apply_completion(text: &str, item: &Value) -> String {
    let mut edits = vec![item["textEdit"].clone()];
    let mut edited = text.to_owned();

    if let Some(additional) = item["additionalTextEdits"].as_array() {
        edits.extend(additional.iter().cloned());
    }

    edits.sort_by_key(|edit| {
        std::cmp::Reverse((
            byte_at_utf16(text, &edit["range"]["start"]),
            byte_at_utf16(text, &edit["range"]["end"]),
        ))
    });

    for edit in edits {
        let start = byte_at_utf16(text, &edit["range"]["start"]);
        let end = byte_at_utf16(text, &edit["range"]["end"]);

        edited.replace_range(start..end, edit["newText"].as_str().unwrap());
    }

    edited
}

#[test]
fn literal_hover_diagnostics_and_edits_map_utf16_in_standalone_and_vue_buffers() {
    with_server(|client| {
        for (uri, prefix, suffix, value) in [
            ("file:///literals.liv", "/* 日本😀 */ ", "", r#""st¦ale""#),
            (
                "file:///literals.vue",
                "<template>😀</template><liva>/* 日本😀 */ ",
                "</liva>",
                "'st¦ale'",
            ),
        ] {
            let marked = format!(
                r#"{prefix}motion a(axis: 'x', position: "start" | 'end') {{ let alias = axis; let curve = steps(count: 4, position: {value}); let movement = link(input: 1, component: alias); layer base {{ translate := movement }} }}{suffix}"#
            );
            let cursor = marked.find('¦').unwrap();
            let source = marked.replace('¦', "");
            let spelling = value.replace('¦', "");
            let start = source.find(&spelling).unwrap();
            let expected = reference_range(&source, start, start + spelling.len());

            notify(
                client,
                "textDocument/didOpen",
                json!({"textDocument": {
                    "uri": uri, "languageId": if uri.ends_with(".vue") {"vue"} else {"liva"},
                    "version": 1, "text": source,
                }}),
            );

            let published = diagnostics(client);
            let error = published["diagnostics"]
                .as_array()
                .unwrap()
                .iter()
                .find(|error| {
                    error["message"]
                        .as_str()
                        .unwrap()
                        .starts_with("Invalid argument type for steps.position")
                })
                .unwrap();

            assert_eq!(error["range"], expected);

            for (name, expected_label) in [
                ("alias =", r#"alias: "x""#),
                ("position:", r#"position: "end" | "start""#),
                ("steps(", r#"position?: "end" | "jump-both""#),
                ("link(", r#"component: "x" | "y", sensitivity?: number"#),
            ] {
                let byte = source.find(name).unwrap();

                let hover = request(client, 3, "textDocument/hover", json!({
                    "textDocument": {"uri": uri}, "position": reference_position(&source, byte + 1),
                })).response_result.unwrap();

                assert!(
                    hover["contents"]["value"]
                        .as_str()
                        .unwrap()
                        .contains(expected_label),
                    "{hover}"
                );
                assert_eq!(hover["range"]["start"], reference_position(&source, byte));
            }

            let items = completion_at(client, uri, &source, cursor);
            let item = items
                .iter()
                .find(|item| item["label"] == r#""start""#)
                .unwrap();

            assert_eq!(items.len(), 1);
            assert_eq!(item["textEdit"]["range"], expected);
            assert_eq!(item["kind"], 12);
            assert_eq!(item["filterText"], &source[start..cursor]);

            let edited = apply_completion(&source, item);

            notify(
                client,
                "textDocument/didChange",
                json!({
                    "textDocument": {"uri": uri, "version": 2}, "contentChanges": [{"text": edited}],
                }),
            );

            assert_eq!(diagnostics(client)["diagnostics"], json!([]));
        }
    });
}

#[test]
fn changed_documents_recover_literal_edits_and_hovers_without_stale_ranges() {
    with_server(|client| {
        for (uri, prefix, suffix) in [
            ("file:///recovery.liv", "", ""),
            (
                "file:///recovery.vue",
                "<template>😀</template>\r\n<liva>",
                "</liva>",
            ),
        ] {
            let initial = format!(
                "{prefix}motion a(axis: 'x') {{ let curve = steps(count: 4, position: ); layer base {{}} }}{suffix}"
            );
            let cursor = initial.find("position: ").unwrap() + "position: ".len();

            notify(
                client,
                "textDocument/didOpen",
                json!({"textDocument": {
                    "uri": uri, "languageId": "liva", "version": 1, "text": initial,
                }}),
            );

            diagnostics(client);

            let first = completion_at(client, uri, &initial, cursor);
            let first_edit = first
                .iter()
                .find(|item| item["label"] == r#""end""#)
                .unwrap();

            assert_eq!(
                first_edit["textEdit"]["range"],
                reference_range(&initial, cursor, cursor)
            );
            assert!(
                first
                    .iter()
                    .any(|item| item["label"] == "axis" && item["textEdit"].is_null())
            );

            let partial = format!(
                "{prefix}// 😀 newer\r\nmotion a(axis: 'x' |) {{ let curve = steps(count: 4, position: ); layer base {{}} }}{suffix}"
            );
            let partial_cursor = partial.find("position: ").unwrap() + "position: ".len();

            notify(
                client,
                "textDocument/didChange",
                json!({
                    "textDocument": {"uri": uri, "version": 2}, "contentChanges": [{"text": partial}],
                }),
            );

            diagnostics(client);

            let items = completion_at(client, uri, &partial, partial_cursor);
            let edit = items
                .iter()
                .find(|item| item["label"] == r#""end""#)
                .unwrap();
            let hover = request(client, 3, "textDocument/hover", json!({
                "textDocument": {"uri": uri}, "position": reference_position(&partial, partial.find("axis:").unwrap()),
            })).response_result.unwrap();

            assert_eq!(
                edit["textEdit"]["range"],
                reference_range(&partial, partial_cursor, partial_cursor)
            );
            assert_ne!(edit["textEdit"]["range"], first_edit["textEdit"]["range"]);
            assert!(hover.is_null());

            let marked = format!(
                "{prefix}// 日本😀 newest\r\nmotion a(axis: 'x') {{ let curve = steps(count: 4, position: 'ju¦); layer base {{}} }}{suffix}"
            );
            let cursor = marked.find('¦').unwrap();
            let source = marked.replace('¦', "");
            let start = source.find("'ju").unwrap();

            notify(
                client,
                "textDocument/didChange",
                json!({
                    "textDocument": {"uri": uri, "version": 3}, "contentChanges": [{"text": source}],
                }),
            );

            diagnostics(client);

            let items = completion_at(client, uri, &source, cursor);
            let edit = items
                .iter()
                .find(|item| item["label"] == r#""jump-end""#)
                .unwrap();

            assert_eq!(items.len(), 4);
            assert_eq!(
                edit["textEdit"]["range"],
                reference_range(&source, start, cursor)
            );

            let edited = apply_completion(&source, edit);

            notify(
                client,
                "textDocument/didChange",
                json!({
                    "textDocument": {"uri": uri, "version": 4}, "contentChanges": [{"text": edited}],
                }),
            );

            assert_eq!(diagnostics(client)["diagnostics"], json!([]));

            let end = edited.find(r#""jump-end""#).unwrap() + r#""jump-end""#.len();

            assert!(completion_at(client, uri, &edited, end).is_empty());
        }
    });
}

#[test]
fn completion_triggers_ignore_nonexpression_locations() {
    with_server(|client| {
        for marked in [
            "motion a(axis:¦ 'x') { layer base {} }",
            "motion a { layer base { color:¦ red } }",
            "motion a { // ¦\nlayer base {} }",
            "motion a { let label = 'unrelated'¦; layer base {} }",
        ] {
            let byte = marked.find('¦').unwrap();
            let source = marked.replace('¦', "");
            let uri = "file:///contexts.liv";

            notify(
                client,
                "textDocument/didOpen",
                json!({"textDocument": {
                    "uri": uri, "languageId": "liva", "version": 1, "text": source,
                }}),
            );

            diagnostics(client);

            assert!(
                completion_at(client, uri, &source, byte).is_empty(),
                "{marked}"
            );
        }
    });
}

#[test]
fn empty_attachments_offer_usable_controller_names_in_standalone_and_vue() {
    with_server(|client| {
        for (uri, prefix, suffix) in [
            ("file:///attachment.liv", "// 日本😀\n", ""),
            (
                "file:///attachment.vue",
                "<template>😀</template>\r\n<liva>",
                "</liva>",
            ),
        ] {
            let marked = format!(
                "{prefix}motion a {{ let movement = link(input: 1, component: 'x'); let alias = movement; layer base {{ translate := ¦ }} }}{suffix}"
            );
            let cursor = marked.find('¦').unwrap();
            let source = marked.replace('¦', "");

            notify(
                client,
                "textDocument/didOpen",
                json!({"textDocument": {
                    "uri": uri, "languageId": "liva", "version": 1, "text": source,
                }}),
            );

            diagnostics(client);

            let items = completion_at(client, uri, &source, cursor);
            let item = items.iter().find(|item| item["label"] == "alias").unwrap();

            assert!(item["textEdit"].is_null());
            assert!(items.iter().all(|item| item["textEdit"].is_null()));

            let mut edited = source.clone();

            edited.insert_str(cursor, item["label"].as_str().unwrap());
            notify(
                client,
                "textDocument/didChange",
                json!({
                    "textDocument": {"uri": uri, "version": 2}, "contentChanges": [{"text": edited}],
                }),
            );

            assert_eq!(diagnostics(client)["diagnostics"], json!([]));
        }
    });
}

#[test]
fn member_completion_survives_literal_context_detection() {
    with_server(|client| {
        let marked = "motion a { let ui = interaction(target: self); layer active when ui.fo¦ {} }";
        let byte = marked.find('¦').unwrap();
        let source = marked.replace('¦', "");
        let uri = "file:///members.liv";

        notify(
            client,
            "textDocument/didOpen",
            json!({"textDocument": {
                "uri": uri, "languageId": "liva", "version": 1, "text": source,
            }}),
        );

        diagnostics(client);

        let items = completion_at(client, uri, &source, byte);

        assert_eq!(
            items
                .iter()
                .map(|item| item["label"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["focus", "focusVisible", "focusWithin"]
        );
    });
}

#[test]
fn multiline_literal_replacement_uses_single_line_primary_and_nonoverlapping_cleanup() {
    with_server(|client| {
        for (uri, prefix, suffix, value) in [
            (
                "file:///multiline-completion.liv",
                "/* 😀 */ ",
                "",
                "\"st¦\nale\"",
            ),
            (
                "file:///multiline-completion.vue",
                "<template>😀</template><liva>",
                "</liva>",
                "'st¦\r\nale'",
            ),
            (
                "file:///multiline-completion.liv",
                "/* 😀 */ ",
                "",
                "'st¦\r\nale'",
            ),
            (
                "file:///multiline-completion.vue",
                "<template>😀</template><liva>",
                "</liva>",
                "\"st¦\nale\"",
            ),
        ] {
            let marked = format!(
                "{prefix}motion a {{ let curve = steps(count: 4, position: {value}); layer base {{}} }}{suffix}"
            );
            let cursor = marked.find('¦').unwrap();
            let source = marked.replace('¦', "");
            let start = source.find(value.split('¦').next().unwrap()).unwrap();

            notify(
                client,
                "textDocument/didOpen",
                json!({"textDocument": {
                    "uri": uri, "languageId": "liva", "version": 1, "text": source,
                }}),
            );

            diagnostics(client);

            let result = completion_result(client, uri, &source, cursor);
            let item = result["items"]
                .as_array()
                .unwrap()
                .iter()
                .find(|item| item["label"] == r#""start""#)
                .unwrap();

            assert_eq!(result["isIncomplete"], true);
            assert_eq!(
                item["textEdit"]["range"],
                reference_range(&source, start, cursor)
            );
            assert_eq!(item["filterText"], &source[start..cursor]);
            assert_eq!(item["additionalTextEdits"].as_array().unwrap().len(), 1);
            assert_eq!(
                item["additionalTextEdits"][0]["range"]["start"],
                item["textEdit"]["range"]["end"]
            );

            let edited = apply_completion(&source, item);

            assert_eq!(
                edited,
                source.replacen(&value.replace('¦', ""), "\"start\"", 1)
            );

            notify(
                client,
                "textDocument/didChange",
                json!({
                    "textDocument": {"uri": uri, "version": 2}, "contentChanges": [{"text": edited}],
                }),
            );

            assert_eq!(diagnostics(client)["diagnostics"], json!([]));
        }
    });
}

#[test]
fn multiline_prefixes_with_line_breaks_have_no_builtin_choices() {
    with_server(|client| {
        for (uri, prefix, suffix) in [
            ("file:///later-line.liv", "/* 😀 */ ", ""),
            (
                "file:///later-line.vue",
                "<template>😀</template><liva>",
                "</liva>",
            ),
        ] {
            for separator in ["\n", "\r\n"] {
                for ending in ["¦tail", "¦", "ta¦il"] {
                    let marked = format!(
                        "{prefix}motion a {{ let curve = steps(count: 4, position: \"st{separator}{ending}\"); layer base {{}} }}{suffix}"
                    );
                    let cursor = marked.find('¦').unwrap();
                    let source = marked.replace('¦', "");

                    notify(
                        client,
                        "textDocument/didOpen",
                        json!({"textDocument": {
                            "uri": uri, "languageId": "liva", "version": 1, "text": source,
                        }}),
                    );

                    diagnostics(client);

                    assert!(
                        completion_at(client, uri, &source, cursor).is_empty(),
                        "{marked}"
                    );
                }
            }
        }
    });
}

#[test]
fn ambiguous_unclosed_middle_and_partial_escape_buffers_return_no_insertions() {
    with_server(|client| {
        for value in [r#""ju¦nk"#, "'ju¦nk", r#""a\¦q"#, r#""a\¦"#] {
            let marked = format!(
                "motion a {{ let curve = steps(count: 4, position: {value}); layer base {{}} }}"
            );
            let cursor = marked.find('¦').unwrap();
            let source = marked.replace('¦', "");
            let uri = "file:///ambiguous.liv";

            notify(
                client,
                "textDocument/didOpen",
                json!({"textDocument": {
                    "uri": uri, "languageId": "liva", "version": 1, "text": source,
                }}),
            );

            diagnostics(client);

            assert!(
                completion_at(client, uri, &source, cursor).is_empty(),
                "{marked}"
            );
        }
    });
}

#[test]
fn layout_declarations_expose_fixed_keyword_completion_hover_and_utf16_diagnostics() {
    with_server(|client| {
        for (uri, prefix, suffix) in [
            ("file:///layout.liv", "// 日本😀\r\n", ""),
            (
                "file:///layout.vue",
                "<template><div>日本😀</div></template>\r\n<liva lang=\"liva\">\r\n",
                "\r\n</liva>",
            ),
        ] {
            let marked = format!(
                "{prefix}motion item {{ layer base {{ /* 😀 */ $layout: po¦ @instant }} }}{suffix}"
            );
            let byte = marked.find('¦').unwrap();
            let source = marked.replace('¦', "");

            notify(
                client,
                "textDocument/didOpen",
                json!({"textDocument": {"uri": uri, "languageId": "liva", "version": 1, "text": source}}),
            );
            let errors = diagnostics(client);
            let start = source.find("$layout").unwrap();

            assert!(
                errors["diagnostics"].as_array().unwrap().iter().any(
                    |diagnostic| diagnostic["code"] == "semantic.layout"
                        && diagnostic["range"]
                            == reference_range(&source, start, start + "$layout".len())
                )
            );

            let items = completion_at(client, uri, &source, byte);

            assert_eq!(items.len(), 1);
            assert_eq!(items[0]["label"], "position");
            assert_eq!(items[0]["textEdit"]["newText"], "position");
            assert_eq!(
                items[0]["textEdit"]["range"],
                reference_range(&source, byte - 2, byte)
            );

            let hover = request(client, 3, "textDocument/hover", json!({"textDocument": {"uri": uri}, "position": reference_position(&source, start + 2)})).response_result.unwrap();

            assert!(
                hover["contents"]["value"]
                    .as_str()
                    .unwrap()
                    .contains("fixed physical")
            );
        }
    });
}

#[test]
fn layout_completion_keeps_timing_expressions_and_comments_in_their_own_contexts() {
    with_server(|client| {
        for (marked, expected) in [
            ("motion item { layer base { $layout: ¦ } }", Some("none")),
            (
                "motion item { layer base { $layout: y /* gap */ he¦ } }",
                Some("height"),
            ),
            (
                "motion item { layer base { $layout: y @ins¦ } }",
                Some("instant"),
            ),
            ("motion item { layer base { $layout: y /* po¦ */ } }", None),
            ("motion item { layer base { $layout := po¦ } }", None),
        ] {
            let byte = marked.find('¦').unwrap();
            let source = marked.replace('¦', "");
            let uri = "file:///layout-context.liv";

            notify(
                client,
                "textDocument/didOpen",
                json!({"textDocument": {"uri": uri, "languageId": "liva", "version": 1, "text": source}}),
            );
            diagnostics(client);

            let items = completion_at(client, uri, &source, byte);

            if let Some(expected) = expected {
                assert!(
                    items.iter().any(|item| item["label"] == expected),
                    "{marked}: {items:?}"
                );
            } else {
                assert!(items.is_empty(), "{marked}: {items:?}");
            }
        }
    });
}

#[test]
fn layout_completion_applies_whole_tokens_without_damaging_adjacent_source() {
    with_server(|client| {
        for (uri, prefix, suffix) in [
            ("file:///layout-token.liv", "// 日本😀\r\n", ""),
            (
                "file:///layout-token.vue",
                "<template><div>日本😀</div></template>\r\n<liva lang=\"liva\">\r\n",
                "\r\n</liva>",
            ),
        ] {
            for (value, keyword) in [
                ("¦position size @instant", "position"),
                ("pos¦ition /* keep */ size @instant", "position"),
                ("position¦@instant", "position"),
                ("x he¦ight @instant", "height"),
            ] {
                let marked = format!(
                    "{prefix}motion item {{ layer base {{ /* 😀 */ $layout: {value}; opacity: 1 }} }}{suffix}"
                );
                let byte = marked.find('¦').unwrap();
                let source = marked.replace('¦', "");

                notify(
                    client,
                    "textDocument/didOpen",
                    json!({"textDocument": {"uri": uri, "languageId": "liva", "version": 1, "text": source}}),
                );
                assert_eq!(diagnostics(client)["diagnostics"], json!([]));

                let choices = completion_at(client, uri, &source, byte);
                let choice = choices
                    .iter()
                    .find(|choice| choice["label"] == keyword)
                    .unwrap();
                let edited = apply_completion(&source, choice);

                assert_eq!(edited, source, "{value}");

                notify(
                    client,
                    "textDocument/didChange",
                    json!({"textDocument": {"uri": uri, "version": 2}, "contentChanges": [{"text": edited}]}),
                );

                assert_eq!(diagnostics(client)["diagnostics"], json!([]));
            }
        }
    });
}
