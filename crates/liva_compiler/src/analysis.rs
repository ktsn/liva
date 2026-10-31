//! Editor-facing type information, using the compiler's motion scope and checker.
use crate::{Compiler, expression};
use liva_syntax::{Ast, Kind, Range, parse};
use std::collections::BTreeMap;

#[derive(Debug, Clone)]
pub struct Hover {
    pub range: Range,
    pub label: String,
}

pub fn type_name(value: expression::Type) -> String {
    use expression::Type;

    match value {
        Type::Number => "number".into(),
        Type::Boolean => "boolean".into(),
        Type::String => "string".into(),
        Type::Target => "target".into(),
        Type::Record(fields) => format!(
            "{{ {} }}",
            fields
                .iter()
                .map(|field| format!("{}: {}", field.name, type_name(field.value_type)))
                .collect::<Vec<_>>()
                .join(", ")
        ),
    }
}

pub fn hovers(source: &str) -> Vec<Hover> {
    let parsed = parse(source);
    let mut compiler = Compiler {
        diagnostics: vec![],
        mappings: BTreeMap::new(),
    };
    let mut result = vec![];

    for motion in parsed.root.children(Kind::Block) {
        if motion.motion_name().is_none() {
            continue;
        }

        let parameters = compiler.parameters(&motion);
        let bindings = compiler.let_bindings(&motion);
        let scope = compiler.motion_scope(&motion, &parameters, &bindings);

        for parameter in motion.parameters() {
            if let Some(header) = parameter.child(Kind::Header) {
                scan(&header.text(), header.range().start, &scope, &mut result);
            }
        }

        for binding in motion.children(Kind::Let) {
            for kind in [Kind::Header, Kind::Value] {
                if let Some(node) = binding.child(kind) {
                    scan(&node.text(), node.range().start, &scope, &mut result);
                }
            }
        }

        for state in motion.children(Kind::Block) {
            let Some(header) = state.child(Kind::Header) else {
                continue;
            };
            let text = header.text();
            let words = words(&text);

            if words.first().map(|(word, _)| *word) != Some("state") {
                continue;
            }

            if let Some((_, start)) = words.iter().find(|(word, _)| *word == "when") {
                scan(
                    &text[start + 4..],
                    header.range().start + start + 4,
                    &scope,
                    &mut result,
                );
            }

            for target in state.children(Kind::Block) {
                if let Some(header) = target.child(Kind::Header) {
                    scan(&header.text(), header.range().start, &scope, &mut result);
                }

                for property in target.children(Kind::Declaration) {
                    if let Some(value) = property.child(Kind::Value) {
                        interpolations(&value, &scope, &mut result);
                    }
                }
            }
        }
    }

    result
}

// Preserve byte offsets while excluding comments and quoted text.
fn words(text: &str) -> Vec<(&str, usize)> {
    let mut result = vec![];
    let mut i = 0;

    while i < text.len() {
        let rest = &text[i..];
        let c = rest.chars().next().unwrap();

        if rest.starts_with("//") {
            i += rest.find('\n').unwrap_or(rest.len());
        } else if rest.starts_with("/*") {
            i += rest.find("*/").map_or(rest.len(), |end| end + 2);
        } else if matches!(c, '\'' | '"') {
            i += 1;

            while i < text.len() {
                let next = text[i..].chars().next().unwrap();
                i += next.len_utf8();

                if next == '\\' && i < text.len() {
                    i += text[i..].chars().next().unwrap().len_utf8();
                } else if next == c {
                    break;
                }
            }
        } else if c.is_ascii_alphabetic() || c == '_' {
            let start = i;
            i += 1;

            while i < text.len()
                && (text.as_bytes()[i].is_ascii_alphanumeric() || text.as_bytes()[i] == b'_')
            {
                i += 1;
            }

            result.push((&text[start..i], start));
        } else {
            i += c.len_utf8();
        }
    }

    result
}

fn scan(text: &str, base: usize, scope: &expression::Scope, result: &mut Vec<Hover>) {
    let mut path = String::new();
    let mut previous_end = 0;

    for (word, start) in words(text) {
        if !path.is_empty() && text[previous_end..start].trim() == "." {
            path.push('.');
            path.push_str(word);
        } else {
            path = word.into();
        }

        previous_end = start + word.len();
        let value_type =
            expression::parse_with_diagnostics(&path).and_then(|value| value.check(scope));
        let label = if let Ok(value_type) = value_type {
            Some(format!("{path}: {}", type_name(value_type)))
        } else if text[previous_end..].trim_start().starts_with('(') {
            crate::builtins::lookup(word).ok().map(|function| {
                format!(
                    "{}({}): {}",
                    function.name,
                    function
                        .parameters
                        .iter()
                        .map(|p| format!("{}: {}", p.name, type_name(p.value_type)))
                        .collect::<Vec<_>>()
                        .join(", "),
                    type_name(function.return_type)
                )
            })
        } else {
            None
        };

        if let Some(label) = label {
            result.push(Hover {
                range: Range {
                    start: base + start,
                    end: base + previous_end,
                },
                label,
            });
        }
    }
}

fn interpolations(node: &Ast, scope: &expression::Scope, result: &mut Vec<Hover>) {
    // The lossless lexer keeps each interpolation in a single text token.
    for token in node
        .0
        .descendants_with_tokens()
        .filter_map(|element| element.into_token())
    {
        let text = token.text();

        if let Some(expression) = text
            .strip_prefix("${")
            .and_then(|text| text.strip_suffix('}'))
        {
            scan(
                expression,
                u32::from(token.text_range().start()) as usize + 2,
                scope,
                result,
            );
        }
    }
}
