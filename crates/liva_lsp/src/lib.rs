mod vue;

use liva_compiler::analysis::{self, Hover};
use lsp_server::{Connection, Message, Notification, Request, Response};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, Deserialize)]
pub struct Position {
    pub line: usize,
    pub character: usize,
}

pub fn offset(text: &str, position: Position) -> Option<usize> {
    let start = if position.line == 0 {
        0
    } else {
        text.match_indices('\n').nth(position.line - 1)?.0 + 1
    };
    let line = text[start..].split('\n').next()?.trim_end_matches('\r');
    let mut units = 0;

    for (index, c) in line.char_indices() {
        if units == position.character {
            return Some(start + index);
        }

        units += c.len_utf16();
    }

    (units == position.character).then_some(start + line.len())
}

pub fn position(text: &str, offset: usize) -> Value {
    let prefix = &text[..offset];
    let line = prefix.bytes().filter(|byte| *byte == b'\n').count();
    let character = prefix.rsplit('\n').next().unwrap().encode_utf16().count();
    json!({ "line": line, "character": character })
}

fn range(text: &str, range: &liva_syntax::Range) -> Value {
    json!({ "start": position(text, range.start), "end": position(text, range.end) })
}

struct Document {
    text: String,
    version: i64,
    hovers: Vec<Hover>,
    diagnostics: Vec<Value>,
}

impl Document {
    fn new(text: String, version: i64, uri: &str) -> Self {
        let blocks = if uri.ends_with(".vue") {
            vue::blocks(&text)
        } else {
            std::iter::once(0..text.len()).collect()
        };
        let mut diagnostics = vec![];
        let mut hovers = vec![];

        for block in blocks {
            let source = &text[block.clone()];

            for diagnostic in liva_compiler::compile(source, false).diagnostics {
                let mapped = liva_syntax::Range {
                    start: block.start + diagnostic.range.start,
                    end: block.start + diagnostic.range.end,
                };
                diagnostics.push(json!({
                    "range": range(&text, &mapped),
                    "severity": if diagnostic.severity == "error" { 1 } else { 2 },
                    "code": diagnostic.code,
                    "source": "liva",
                    "message": diagnostic.message,
                }));
            }

            for mut hover in analysis::hovers(source) {
                hover.range.start += block.start;
                hover.range.end += block.start;
                hovers.push(hover);
            }
        }

        Self {
            text,
            version,
            hovers,
            diagnostics,
        }
    }

    fn completions(&self, point: Position, uri: &str) -> Vec<Value> {
        let Some(offset) = offset(&self.text, point) else {
            return vec![];
        };
        let blocks = if uri.ends_with(".vue") {
            vue::blocks(&self.text)
        } else {
            std::iter::once(0..self.text.len()).collect()
        };
        let Some(block) = blocks
            .into_iter()
            .find(|block| block.start <= offset && offset < block.end)
        else {
            return vec![];
        };

        analysis::completions(&self.text[block.clone()], offset - block.start)
            .into_iter()
            .map(|item| json!({ "label": item.label, "detail": item.detail }))
            .collect()
    }

    fn hover(&self, point: Position) -> Option<Value> {
        let offset = offset(&self.text, point)?;
        let hover = self
            .hovers
            .iter()
            .find(|hover| hover.range.start <= offset && offset < hover.range.end)?;

        Some(json!({
            "contents": { "kind": "markdown", "value": format!("```liva\n{}\n```", hover.label) },
            "range": range(&self.text, &hover.range),
        }))
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TextDocument {
    uri: String,
    #[serde(default)]
    version: i64,
    #[serde(default)]
    text: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DocumentParams {
    text_document: TextDocument,
    #[serde(default)]
    content_changes: Vec<Change>,
    position: Option<Position>,
}

#[derive(Deserialize)]
struct Change {
    text: String,
    range: Option<Value>,
}

fn publish(
    connection: &Connection,
    uri: &str,
    document: Option<&Document>,
) -> Result<(), Box<dyn std::error::Error>> {
    let params = match document {
        Some(document) => {
            json!({ "uri": uri, "version": document.version, "diagnostics": document.diagnostics })
        }
        None => json!({ "uri": uri, "diagnostics": [] }),
    };

    connection
        .sender
        .send(Message::Notification(Notification::new(
            "textDocument/publishDiagnostics".into(),
            params,
        )))?;
    Ok(())
}

pub fn run(connection: Connection) -> Result<(), Box<dyn std::error::Error>> {
    connection.initialize(json!({
        "positionEncoding": "utf-16",
        "textDocumentSync": { "openClose": true, "change": 1 },
        "hoverProvider": true,
        "completionProvider": { "triggerCharacters": ["."] },
    }))?;
    let mut documents = HashMap::<String, Document>::new();

    for message in &connection.receiver {
        match message {
            Message::Request(request) => {
                if connection.handle_shutdown(&request)? {
                    return Ok(());
                }

                let response = handle_request(request, &documents);
                connection.sender.send(Message::Response(response))?;
            }
            Message::Notification(notification) => {
                if notification.method == "exit" {
                    return Err("exit before shutdown".into());
                }

                if !matches!(
                    notification.method.as_str(),
                    "textDocument/didOpen" | "textDocument/didChange" | "textDocument/didClose"
                ) {
                    continue;
                }

                let Ok(params) = serde_json::from_value::<DocumentParams>(notification.params)
                else {
                    continue;
                };
                let uri = params.text_document.uri;

                match notification.method.as_str() {
                    "textDocument/didOpen" => {
                        documents.insert(
                            uri.clone(),
                            Document::new(
                                params.text_document.text,
                                params.text_document.version,
                                &uri,
                            ),
                        );
                    }
                    "textDocument/didChange" => {
                        let Some(current) = documents.get(&uri) else {
                            continue;
                        };

                        if params.text_document.version <= current.version
                            || params
                                .content_changes
                                .iter()
                                .any(|change| change.range.is_some())
                        {
                            continue;
                        }

                        let Some(change) = params.content_changes.into_iter().last() else {
                            continue;
                        };
                        documents.insert(
                            uri.clone(),
                            Document::new(change.text, params.text_document.version, &uri),
                        );
                    }
                    "textDocument/didClose" => {
                        documents.remove(&uri);
                    }
                    _ => unreachable!(),
                }

                publish(&connection, &uri, documents.get(&uri))?;
            }
            Message::Response(_) => {}
        }
    }

    Ok(())
}

fn handle_request(request: Request, documents: &HashMap<String, Document>) -> Response {
    if !matches!(
        request.method.as_str(),
        "textDocument/hover" | "textDocument/completion"
    ) {
        return Response::new_err(
            request.id,
            -32601,
            format!("Unsupported method: {}", request.method),
        );
    }

    let params = match serde_json::from_value::<DocumentParams>(request.params) {
        Ok(params) if params.position.is_some() => params,
        _ => {
            return Response::new_err(
                request.id,
                -32602,
                "Expected textDocument and position".into(),
            );
        }
    };
    let document = documents.get(&params.text_document.uri);

    if request.method == "textDocument/completion" {
        let completions = document
            .map(|document| {
                document.completions(params.position.unwrap(), &params.text_document.uri)
            })
            .unwrap_or_default();

        return Response::new_ok(request.id, completions);
    }

    let hover = document.and_then(|document| document.hover(params.position.unwrap()));

    Response::new_ok(request.id, hover)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn completion_requests_map_vue_blocks_and_exclude_host_code() {
        let uri = "file:///test.vue";
        let text = "<script setup>const ui = 1</script>\n<liva>motion button { let ui = interaction(target: body)\nlayer focus when ui.fo { body { opacity: 1 } } }</liva>";
        let document = Document::new(text.into(), 1, uri);
        let documents = HashMap::from([(uri.into(), document)]);
        let request = Request::new(
            1.into(),
            "textDocument/completion".into(),
            json!({
                "textDocument": { "uri": uri },
                "position": { "line": 2, "character": 22 },
            }),
        );
        let result = handle_request(request, &documents).response_result.unwrap();

        assert_eq!(
            result
                .as_array()
                .unwrap()
                .iter()
                .map(|item| item["label"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["focus", "focusVisible", "focusWithin"]
        );
        assert!(
            documents[uri]
                .completions(
                    Position {
                        line: 0,
                        character: 23
                    },
                    uri
                )
                .is_empty()
        );
    }

    #[test]
    fn vue_blocks_map_types_and_errors_to_original_document() {
        let text = "<script setup>const s = '<liva>fake</liva>'</script>\r\n<template><div title=\">\"><liva>html</liva></div></template>\r\n<!-- <liva>ignored</liva> -->\r\n<liva lang=\"liva\">\r\nmotion a(value: number) {\r\n let wrong = value + true\r\n layer idle { body { opacity: ${value} } }\r\n}\r\n</liva>\r\n<liva>motion b(value: string) { layer idle { body { content: ${value} } } }</liva>";
        let document = Document::new(text.into(), 1, "file:///test.vue");

        assert_eq!(vue::blocks(text).len(), 2);
        assert!(
            document
                .diagnostics
                .iter()
                .any(|error| error["range"]["start"]["line"] == 5
                    && error["message"] == "Incompatible expression operands")
        );
        assert!(
            document
                .hover(Position {
                    line: 4,
                    character: 10
                })
                .unwrap()["contents"]["value"]
                .as_str()
                .unwrap()
                .contains("value: number")
        );
        assert!(
            document
                .hover(Position {
                    line: 9,
                    character: 16
                })
                .unwrap()["contents"]["value"]
                .as_str()
                .unwrap()
                .contains("value: string")
        );
        assert!(
            document
                .hover(Position {
                    line: 0,
                    character: 30
                })
                .is_none()
        );
    }
}
