//! Editor-facing type information, using the compiler's motion scope and checker.
use crate::{Compiler, expression};
use liva_syntax::ast::expression::{Expr, ExprView};
use liva_syntax::ast::{AstNode, HasHeader, HasItems, HasValue};
use liva_syntax::{Range, parse};
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
        diagnostics: parsed
            .diagnostics
            .into_iter()
            .map(|mut diagnostic| {
                if diagnostic.code == "syntax.expression" {
                    diagnostic.code = "semantic.expression".into();
                }
                diagnostic
            })
            .collect(),
        mappings: BTreeMap::new(),
    };
    let mut result = vec![];

    for motion in parsed.root.motions() {
        if motion.name().is_none() {
            continue;
        }

        let parameters = compiler.parameters(&motion);
        let bindings = compiler.let_bindings(&motion);
        let scope = compiler.motion_scope(&motion, &parameters, &bindings);

        for parameter in motion.parameters() {
            if let Some(header) = parameter.header_node() {
                scan(&header.text(), header.range().start, &scope, &mut result);
            }
        }

        for binding in motion.bindings() {
            if let Some(header) = binding.header_node() {
                scan(&header.text(), header.range().start, &scope, &mut result);
            }
            if let Some(value) = binding.value_node() {
                expression_hovers(&value, &scope, &mut result);
            }
        }

        for state in motion.states() {
            if let Some(condition) = state.condition() {
                expression_hovers(&condition, &scope, &mut result);
            }

            for target in state.targets() {
                if let Some(header) = target.header_node() {
                    scan(&header.text(), header.range().start, &scope, &mut result);
                }

                for property in target.properties() {
                    if let Some(value) = property.value_node() {
                        expression_hovers(&value, &scope, &mut result);
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
                && (text.as_bytes()[i].is_ascii_alphanumeric()
                    || matches!(text.as_bytes()[i], b'_' | b'-'))
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
    for (word, start) in words(text) {
        let previous_end = start + word.len();
        let label = scope
            .get(word)
            .map(|value_type| format!("{word}: {}", type_name(*value_type)));

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

fn expression_hovers(node: &impl AstNode, scope: &expression::Scope, result: &mut Vec<Hover>) {
    for expr in node.syntax().descendants().filter_map(Expr::cast) {
        match expr.view() {
            ExprView::Reference => {
                let mut names = expr.names();
                let Some(first) = names.next() else {
                    continue;
                };
                let mut path = first.text();
                let Some(mut value_type) = scope.get(&path).copied() else {
                    continue;
                };
                result.push(Hover {
                    range: first.range(),
                    label: format!("{path}: {}", type_name(value_type)),
                });

                for name in names {
                    let expression::Type::Record(fields) = value_type else {
                        break;
                    };
                    let Some(field) = fields.iter().find(|field| field.name == name.text()) else {
                        break;
                    };
                    value_type = field.value_type;
                    path.push('.');
                    path.push_str(&name.text());
                    result.push(Hover {
                        range: name.range(),
                        label: format!("{path}: {}", type_name(value_type)),
                    });
                }
            }
            ExprView::Call => {
                let Some(name) = expr.function() else {
                    continue;
                };
                let Ok(function) = crate::builtins::lookup(&name.text()) else {
                    continue;
                };
                result.push(Hover {
                    range: name.range(),
                    label: format!(
                        "{}({}): {}",
                        function.name,
                        function
                            .parameters
                            .iter()
                            .map(|p| format!("{}: {}", p.name, type_name(p.value_type)))
                            .collect::<Vec<_>>()
                            .join(", "),
                        type_name(function.return_type)
                    ),
                });
            }
            _ => {}
        }
    }
}
