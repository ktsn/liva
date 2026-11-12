//! Editor-facing type information, using the compiler's motion scope and checker.
use crate::{
    Compiler, expression,
    scope::{Symbol, SymbolKind},
};
use liva_syntax::ast::expression::{Expr, ExprView};
use liva_syntax::ast::{AstNode, HasHeader, HasItems};
use liva_syntax::{Range, parse};
use std::collections::BTreeMap;

#[derive(Debug, Clone)]
pub struct Hover {
    /// Derived from symbol metadata, for theme-controlled root-target highlighting.
    pub builtin_target: bool,
    pub range: Range,
    pub label: String,
}

/// Format a compiler type with the notation shared by hovers and diagnostics.
pub fn type_name(value: &expression::Type) -> String {
    value.to_string()
}

#[derive(Debug, Clone)]
pub struct Completion {
    pub label: String,
    pub detail: String,
}

/// Complete expression variables, record fields, and registered built-in functions.
pub fn completions(source: &str, offset: usize) -> Vec<Completion> {
    let Some(prefix) = source.get(..offset) else {
        return vec![];
    };
    let typed = prefix
        .rsplit(|c: char| !c.is_ascii_alphanumeric() && !matches!(c, '_' | '-' | '.'))
        .next()
        .unwrap_or_default();
    let parsed = parse(source);
    let mut compiler = Compiler {
        diagnostics: vec![],
        mappings: BTreeMap::new(),
        sources: BTreeMap::new(),
    };
    let Some(motion) = parsed.root.motions().find(|motion| {
        let range = motion.range();
        range.start <= offset && offset <= range.end
    }) else {
        return vec![];
    };
    let parameters = compiler.parameters(&motion);
    let bindings = compiler.let_bindings(&motion);
    let scope = compiler.motion_scope(&motion, &parameters, &bindings);

    if let Some((parent, partial)) = typed.rsplit_once('.') {
        let mut path = parent.split('.');
        let Some(mut value_type) = path
            .next()
            .and_then(|name| scope.get(name))
            .and_then(Symbol::value_type)
        else {
            return vec![];
        };

        for name in path {
            let (expression::Type::Record(fields) | expression::Type::Controller(fields)) =
                value_type
            else {
                return vec![];
            };
            let Some(field) = fields.iter().find(|field| field.name == name) else {
                return vec![];
            };
            value_type = &field.value_type;
        }

        return match value_type {
            expression::Type::Record(fields) | expression::Type::Controller(fields) => fields
                .iter()
                .filter(|field| field.name.starts_with(partial))
                .map(|field| Completion {
                    label: field.name.into(),
                    detail: type_name(&field.value_type),
                })
                .collect(),
            _ => vec![],
        };
    }

    scope
        .iter()
        .filter(|(name, _)| name.starts_with(typed))
        .filter_map(|(name, symbol)| {
            symbol_detail(symbol).map(|detail| Completion {
                label: name.into(),
                detail,
            })
        })
        .collect()
}

fn symbol_detail(symbol: &Symbol) -> Option<String> {
    match &symbol.kind {
        SymbolKind::Value(value_type) => Some(type_name(value_type)),
        SymbolKind::Pending => None,
        SymbolKind::Function(function) => Some(
            function
                .signatures
                .iter()
                .map(|signature| {
                    format!(
                        "{}({}): {}",
                        function.name,
                        signature
                            .parameters
                            .iter()
                            .map(|parameter| format!(
                                "{}{}: {}",
                                parameter.name,
                                if parameter.optional { "?" } else { "" },
                                type_name(&parameter.value_type),
                            ))
                            .collect::<Vec<_>>()
                            .join(", "),
                        type_name(&signature.return_type),
                    )
                })
                .collect::<Vec<_>>()
                .join("\n"),
        ),
    }
}

fn symbol_label(name: &str, symbol: &Symbol) -> Option<String> {
    symbol_detail(symbol).map(|detail| match &symbol.kind {
        SymbolKind::Function(_) => detail,
        _ => format!("{name}: {detail}"),
    })
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
        sources: BTreeMap::new(),
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
        }

        expression_hovers(&motion, &scope, &mut result);

        for target in motion
            .syntax()
            .descendants()
            .filter_map(liva_syntax::ast::Target::cast)
        {
            if let Some(header) = target.header_node() {
                scan(
                    header.text().split('@').next().unwrap_or_default(),
                    header.range().start,
                    &scope,
                    &mut result,
                );
            }
        }

        for decorator in motion
            .syntax()
            .descendants()
            .filter_map(liva_syntax::ast::Decorator::cast)
        {
            let value = liva_syntax::parse_expression(&decorator.expression_text());
            let mut local = vec![];

            expression_hovers(&value.root, &scope, &mut local);

            for mut hover in local {
                hover.range.start += decorator.range().start + 1;
                hover.range.end += decorator.range().start + 1;
                result.push(hover);
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
            .and_then(|symbol| symbol_label(word, symbol));

        if let Some(label) = label {
            result.push(Hover {
                builtin_target: scope.get(word).is_some_and(Symbol::is_builtin_target),
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
                let Some(mut value_type) = scope.get(&path).and_then(Symbol::value_type) else {
                    continue;
                };
                result.push(Hover {
                    builtin_target: scope.get(&path).is_some_and(Symbol::is_builtin_target),
                    range: first.range(),
                    label: format!("{path}: {}", type_name(value_type)),
                });

                for name in names {
                    let (expression::Type::Record(fields) | expression::Type::Controller(fields)) =
                        value_type
                    else {
                        break;
                    };
                    let Some(field) = fields.iter().find(|field| field.name == name.text()) else {
                        break;
                    };
                    value_type = &field.value_type;
                    path.push('.');
                    path.push_str(&name.text());
                    result.push(Hover {
                        builtin_target: false,
                        range: name.range(),
                        label: format!("{path}: {}", type_name(value_type)),
                    });
                }
            }
            ExprView::Call => {
                let Some(name) = expr.function() else {
                    continue;
                };
                let Some(label) = scope
                    .get(&name.text())
                    .and_then(|symbol| symbol_label(&name.text(), symbol))
                else {
                    continue;
                };
                result.push(Hover {
                    builtin_target: false,
                    range: name.range(),
                    label,
                });
            }
            _ => {}
        }
    }
}
