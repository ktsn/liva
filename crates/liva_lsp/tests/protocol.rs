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
