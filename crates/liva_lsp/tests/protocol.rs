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
    let valid = "motion a(value: number) {\n let twice = value * 2\n state idle { body { opacity: ${twice} } }\n}";
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
                    && error["range"]["start"]["line"] == 1
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
