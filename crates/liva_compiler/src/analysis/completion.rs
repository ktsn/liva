//! Completion contexts, signature filtering, and source edits share the checked scope.
use super::{symbol_detail, type_name};
use crate::{
    Compiler,
    expression::ExprExt,
    scope::{Scope, Symbol, SymbolKind},
};
use liva_syntax::ast::expression::{Argument, Expr, ExprView};
use liva_syntax::ast::{AstNode, Decorator, HasValue, Motion, Property};
use liva_syntax::{Kind, Range, parse, parse_expression, quote_string};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone)]
pub struct Completion {
    pub label: String,
    pub detail: String,
    pub text_edit: Option<CompletionEdit>,
}

/// Replacement text and UTF-8 byte range relative to the analyzed source.
/// Empty ranges insert text; literal edits include their own surrounding quotes.
#[derive(Debug, Clone)]
pub struct CompletionEdit {
    pub range: Range,
    pub new_text: String,
}

/// Complete names/members and metadata-derived finite-string argument choices.
/// offset is a UTF-8 byte boundary in source. Invalid/out-of-motion offsets return
/// no results. Quoted choices replace the whole closed string, or only the typed
/// prefix of an unfinished string so following structural text is preserved.
/// Ambiguous unfinished suffixes and incomplete escapes produce no literal edits.
/// Closed multiline literals can produce multiline ranges for editor adapters.
pub fn completions(source: &str, offset: usize) -> Vec<Completion> {
    let Some(prefix) = source.get(..offset) else {
        return vec![];
    };
    let parsed = parse(source);
    let Some(motion) = parsed
        .root
        .motions()
        .find(|motion| contains(&motion.range(), offset))
    else {
        return vec![];
    };
    let mut compiler = Compiler {
        diagnostics: vec![],
        mappings: BTreeMap::new(),
        sources: BTreeMap::new(),
    };
    let parameters = compiler.parameters(&motion);
    let bindings = compiler.let_bindings(&motion);
    let scope = compiler.motion_scope(&motion, &parameters, &bindings);
    let context = argument_context(&motion, offset);
    let mut choices = context
        .as_ref()
        .map_or_else(Vec::new, |context| literal_choices(context, &scope));

    // Names remain available for empty argument values and normal expression contexts.
    // Inside quotes only literal edits can replace the value without corrupting it.
    if context.as_ref().is_some_and(|context| context.edit.quoted) {
        return choices;
    }

    if context.is_none() && !name_context(&motion, offset) {
        return choices;
    }

    let typed = prefix
        .rsplit(|c: char| !c.is_ascii_alphanumeric() && !matches!(c, '_' | '-' | '.'))
        .next()
        .unwrap_or_default();
    choices.extend(name_choices(&scope, typed));

    choices
}

fn contains(range: &Range, point: usize) -> bool {
    range.start <= point && point <= range.end
}

fn name_choices(scope: &Scope, typed: &str) -> Vec<Completion> {
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
            let (crate::expression::Type::Record(fields)
            | crate::expression::Type::Controller(fields)) = value_type
            else {
                return vec![];
            };
            let Some(field) = fields.iter().find(|field| field.name == name) else {
                return vec![];
            };
            value_type = &field.value_type;
        }

        return match value_type {
            crate::expression::Type::Record(fields)
            | crate::expression::Type::Controller(fields) => fields
                .iter()
                .filter(|field| field.name.starts_with(partial))
                .map(|field| Completion {
                    label: field.name.into(),
                    detail: type_name(&field.value_type),
                    text_edit: None,
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
                text_edit: None,
            })
        })
        .collect()
}

struct LiteralEdit {
    prefix: String,
    range: Range,
    quoted: bool,
}

struct ArgumentContext {
    call: Expr,
    argument: Argument,
    edit: LiteralEdit,
}

fn in_comment(node: &impl AstNode, offset: usize) -> bool {
    node.syntax()
        .descendants_with_tokens()
        .filter_map(|element| element.into_token())
        .any(|token| {
            let text = token.text();
            let start = u32::from(token.text_range().start()) as usize;
            let end = u32::from(token.text_range().end()) as usize;
            let open_end = text.starts_with("//") || !text.ends_with("*/");

            token.kind() == Kind::Trivia
                && (text.starts_with("//") || text.starts_with("/*"))
                && start <= offset
                && (offset < end || (offset == end && open_end))
        })
}

fn argument_context(motion: &Motion, offset: usize) -> Option<ArgumentContext> {
    if in_comment(motion, offset) {
        return None;
    }

    let mut contexts = contexts_in(motion, offset, 0);

    // Suffix decorators preserve opaque text in the CST. Reparse precisely that
    // expression, using the same source origin already used by hover analysis.
    for decorator in motion.syntax().descendants().filter_map(Decorator::cast) {
        let base = decorator.expression_range().start;

        if contains(&decorator.expression_range(), offset) {
            let parsed = parse_expression(&decorator.expression_text());

            if !in_comment(&parsed.root, offset - base) {
                contexts.extend(contexts_in(&parsed.root, offset - base, base));
            }
        }
    }

    contexts
        .into_iter()
        .min_by_key(|context| context.call.range().end - context.call.range().start)
}

fn name_context(motion: &Motion, offset: usize) -> bool {
    if names_in(motion, offset) {
        return true;
    }

    motion
        .syntax()
        .descendants()
        .filter_map(Decorator::cast)
        .any(|decorator| {
            let range = decorator.expression_range();

            if !contains(&range, offset) {
                return false;
            }

            let parsed = parse_expression(&decorator.expression_text());

            names_in(&parsed.root, offset - range.start)
        })
}

fn names_in(node: &impl AstNode, offset: usize) -> bool {
    if in_comment(node, offset) {
        return false;
    }

    // A closing-quote trigger is outside literal editing, but still must not
    // insert an expression name immediately after the completed string.
    if node
        .syntax()
        .descendants()
        .filter_map(Expr::cast)
        .any(|expression| {
            matches!(expression.view(), ExprView::String)
                && (contains(&expression.range(), offset)
                    || (offset < expression.range().start
                        && expression
                            .syntax()
                            .ancestors()
                            .find(|node| node.kind() == Kind::Value)
                            .is_some_and(|value| {
                                let range = value.range();

                                contains(&range, offset)
                                    && value.text().to_string()[offset - range.start
                                        ..expression.range().start - range.start]
                                        .chars()
                                        .all(char::is_whitespace)
                            })))
        })
    {
        return false;
    }

    if node
        .syntax()
        .descendants()
        .filter_map(Expr::cast)
        .any(|expression| contains(&expression.range(), offset))
    {
        return true;
    }

    if node.syntax().kind() == Kind::Value && node.semantic_text().is_empty() {
        return true;
    }

    node.syntax().descendants().any(|syntax| {
        let expression_container = matches!(syntax.kind(), Kind::Condition | Kind::Interpolation)
            || (syntax.kind() == Kind::Value
                && syntax.parent().is_some_and(|parent| {
                    matches!(
                        parent.kind(),
                        Kind::Let | Kind::Argument | Kind::Interpolation
                    ) || Property::cast(parent).is_some_and(|property| property.is_attachment())
                }));
        let range = syntax.text_range();

        expression_container
            && u32::from(range.start()) as usize <= offset
            && offset <= u32::from(range.end()) as usize
    })
}

fn contexts_in(node: &impl AstNode, offset: usize, base: usize) -> Vec<ArgumentContext> {
    let mut result = vec![];

    for call in node
        .syntax()
        .descendants()
        .filter_map(Expr::cast)
        .filter(|expr| matches!(expr.view(), ExprView::Call))
    {
        if !contains(&call.range(), offset) {
            continue;
        }

        for argument in call.arguments() {
            if let Some(edit) = literal_edit(&argument, offset, base) {
                result.push(ArgumentContext {
                    call: call.clone(),
                    argument,
                    edit,
                });
            }
        }
    }

    result
}

fn literal_edit(argument: &Argument, offset: usize, base: usize) -> Option<LiteralEdit> {
    let value = argument.value_node()?;

    if !contains(&value.range(), offset) {
        return None;
    }

    if value.semantic_text().is_empty() {
        return Some(LiteralEdit {
            prefix: String::new(),
            range: Range {
                start: base + offset,
                end: base + offset,
            },
            quoted: false,
        });
    }

    let mut expression = value.expression()?;

    while matches!(expression.view(), ExprView::Parenthesized) {
        let inner = expression.operands().next()?;
        expression = inner;
    }

    if !matches!(expression.view(), ExprView::String) || !contains(&expression.range(), offset) {
        return None;
    }

    let range = expression.range();
    let closed = expression.is_closed_string();

    if closed && offset == range.end {
        return None;
    }

    let text = expression.text();

    // An unclosed token can absorb subsequent source. At a caret inside existing
    // contents there is no sound replacement boundary; wait for closure or for
    // the caret to reach a structural delimiter/end instead of leaving stale text.
    if !closed {
        let remaining = text.get(offset - range.start..)?.trim_start();

        if !remaining.is_empty() && !remaining.starts_with([')', ',', ';', '}']) {
            return None;
        }
    }

    let prefix = if offset == range.start {
        String::new()
    } else {
        let quote = text.chars().next()?;
        let spelling = format!("{}{quote}", text.get(..offset - range.start)?);
        let parsed = parse_expression(&spelling);

        parsed.root.expression()?.string_value().ok()?
    };

    Some(LiteralEdit {
        prefix,
        range: Range {
            start: base + range.start,
            end: base + if closed { range.end } else { offset },
        },
        quoted: true,
    })
}

fn literal_choices(context: &ArgumentContext, scope: &Scope) -> Vec<Completion> {
    let Some(function_name) = context.call.function() else {
        return vec![];
    };
    let Some(Symbol {
        kind: SymbolKind::Function(function),
        ..
    }) = scope.get(&function_name.text())
    else {
        return vec![];
    };
    let Some(argument_name) = context.argument.name() else {
        return vec![];
    };
    let argument_name = argument_name.text();
    let mut values = BTreeSet::new();

    for signature in function.signatures {
        let Some(parameter) = signature
            .parameters
            .iter()
            .find(|parameter| parameter.name == argument_name)
        else {
            continue;
        };
        let mut seen = BTreeSet::from([argument_name.clone()]);
        let compatible = context
            .call
            .arguments()
            .filter(|argument| argument.syntax() != context.argument.syntax())
            .all(|argument| {
                let Some(name) = argument.name() else {
                    return false;
                };
                let name = name.text();
                let Some(parameter) = signature
                    .parameters
                    .iter()
                    .find(|parameter| parameter.name == name)
                else {
                    return false;
                };

                if !seen.insert(name) {
                    return false;
                }

                // Incomplete/unresolved values leave candidates open; a resolved type
                // must satisfy the same assignability rule as argument checking.
                argument
                    .value()
                    .and_then(|value| value.check(scope).ok())
                    .is_none_or(|actual| actual.is_assignable_to(&parameter.value_type))
            });

        if compatible {
            values.extend(
                parameter
                    .value_type
                    .string_literals()
                    .filter(|value| value.starts_with(&context.edit.prefix)),
            );
        }
    }

    values
        .into_iter()
        .map(|value| Completion {
            label: crate::expression::Type::StringLiteral(value.into()).to_string(),
            detail: format!("{}.{}", function.name, argument_name),
            text_edit: Some(CompletionEdit {
                range: context.edit.range.clone(),
                new_text: quote_string(value),
            }),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::builtins::{Function, Parameter, Signature};
    use crate::expression::Type;
    use liva_syntax::ast::HasItems;
    use std::borrow::Cow;

    static QUOTED: Function = Function {
        name: "quoted",
        signatures: &[Signature {
            parameters: &[Parameter {
                name: "mode",
                optional: false,
                value_type: Type::StringUnion(Cow::Borrowed(&[
                    Cow::Borrowed("a'quote"),
                    Cow::Borrowed("a\"quote"),
                    Cow::Borrowed("a\\path"),
                    Cow::Borrowed("a\nline"),
                    Cow::Borrowed("a\tline"),
                    Cow::Borrowed("日本😀"),
                    Cow::Borrowed(""),
                    Cow::Borrowed("\u{8}"),
                    Cow::Borrowed("\0"),
                    Cow::Borrowed("/* text */"),
                    Cow::Borrowed("${literal}"),
                    Cow::Borrowed("a'quote"),
                ])),
            }],
            return_type: Type::Boolean,
        }],
    };

    static FILTERED: Function = Function {
        name: "filtered",
        signatures: &[
            Signature {
                parameters: &[
                    Parameter {
                        name: "selector",
                        optional: false,
                        value_type: Type::Number,
                    },
                    Parameter {
                        name: "choice",
                        optional: false,
                        value_type: Type::StringLiteral(Cow::Borrowed("number")),
                    },
                ],
                return_type: Type::Boolean,
            },
            Signature {
                parameters: &[
                    Parameter {
                        name: "selector",
                        optional: false,
                        value_type: Type::Boolean,
                    },
                    Parameter {
                        name: "choice",
                        optional: false,
                        value_type: Type::StringLiteral(Cow::Borrowed("boolean")),
                    },
                ],
                return_type: Type::Boolean,
            },
            Signature {
                parameters: &[
                    Parameter {
                        name: "selector",
                        optional: false,
                        value_type: Type::String,
                    },
                    Parameter {
                        name: "choice",
                        optional: false,
                        value_type: Type::StringLiteral(Cow::Borrowed("string")),
                    },
                ],
                return_type: Type::Boolean,
            },
        ],
    };

    fn custom_choices(
        marked: &str,
        function: &'static Function,
    ) -> (String, Scope, Vec<Completion>) {
        let offset = marked.find('¦').unwrap();
        let source = marked.replace('¦', "");
        let mut scope = Scope::motion();

        for (name, kind) in [
            (function.name, SymbolKind::Function(function)),
            ("broad", SymbolKind::Value(Type::String)),
            (
                "multiple",
                SymbolKind::Value(Type::StringUnion(Cow::Borrowed(&[
                    Cow::Borrowed("x"),
                    Cow::Borrowed("y"),
                ]))),
            ),
        ] {
            scope
                .declare(name.into(), kind, Range { start: 0, end: 0 })
                .unwrap();
        }

        let parsed = parse(&source);
        let motion = parsed.root.motions().next().unwrap();
        let context = argument_context(&motion, offset).unwrap();
        let found = literal_choices(&context, &scope);

        (source, scope, found)
    }

    fn assert_choice_round_trips(source: &str, scope: &Scope, item: &Completion) -> String {
        let edit = item.text_edit.as_ref().unwrap();
        let mut edited = source.to_owned();

        edited.replace_range(edit.range.start..edit.range.end, &edit.new_text);

        let parsed = parse(&edited);
        let call = parsed
            .root
            .motions()
            .next()
            .unwrap()
            .bindings()
            .next()
            .unwrap()
            .initializer()
            .unwrap();
        let argument = call.arguments().next().unwrap().value().unwrap();
        let decoded = argument.string_value().unwrap();
        let label: String = serde_json::from_str(&item.label).unwrap();

        assert!(
            parsed.diagnostics.is_empty(),
            "{edited:?}: {:?}",
            parsed.diagnostics
        );
        assert_eq!(call.check(scope).unwrap(), Type::Boolean);
        assert_eq!(decoded, label);

        decoded
    }

    #[test]
    fn arbitrary_metadata_choices_insert_decodable_source_without_json_only_escapes() {
        let (source, scope, found) = custom_choices(
            "motion a { let result = quoted(mode: ¦); layer base {} }",
            &QUOTED,
        );

        assert_eq!(found.len(), 11);

        for item in found {
            assert_choice_round_trips(&source, &scope, &item);
        }
    }

    #[test]
    fn both_quotes_and_equivalent_escapes_filter_decoded_prefixes() {
        for (value, prefix) in [
            (r#""a\'¦tail""#, "a'"),
            (r#"'a\"¦tail'"#, "a\""),
            (r#""a\\¦tail""#, "a\\"),
            (r#""a\n¦tail""#, "a\n"),
            (r#""a\t¦tail""#, "a\t"),
            ("'日本¦tail'", "日本"),
            ("'/* ¦tail'", "/* "),
        ] {
            let (source, scope, found) = custom_choices(
                &format!("motion a {{ let result = quoted(mode: {value}); layer base {{}} }}"),
                &QUOTED,
            );

            assert_eq!(found.len(), 1, "{source}: {found:?}");
            assert!(assert_choice_round_trips(&source, &scope, &found[0]).starts_with(prefix));
        }
    }

    #[test]
    fn compatible_overloads_use_supplied_argument_types() {
        for (arguments, expected) in [
            ("selector: 1, choice: ¦", vec![r#""number""#]),
            ("choice: 'n¦onsense', selector: 1", vec![r#""number""#]),
            ("selector: true, choice: ¦", vec![r#""boolean""#]),
            ("selector: 'value', choice: ¦", vec![r#""string""#]),
            ("selector: broad, choice: ¦", vec![r#""string""#]),
            ("selector: multiple, choice: ¦", vec![r#""string""#]),
            ("selector: 1, unknown: true, choice: ¦", vec![]),
            ("selector: 1, selector: 1, choice: ¦", vec![]),
            ("selector: 1, choice: 'number', choice: ¦", vec![]),
            (
                "choice: ¦",
                vec![r#""boolean""#, r#""number""#, r#""string""#],
            ),
            (
                "selector: missing, choice: ¦",
                vec![r#""boolean""#, r#""number""#, r#""string""#],
            ),
            (
                "selector: , choice: ¦",
                vec![r#""boolean""#, r#""number""#, r#""string""#],
            ),
        ] {
            let (_, _, found) = custom_choices(
                &format!("motion a {{ let result = filtered({arguments}); layer base {{}} }}"),
                &FILTERED,
            );

            assert_eq!(
                found
                    .iter()
                    .map(|item| item.label.as_str())
                    .collect::<Vec<_>>(),
                expected,
                "{arguments}"
            );
        }
    }
}
