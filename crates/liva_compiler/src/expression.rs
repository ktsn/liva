use liva_syntax::ast::AstNode;
use liva_syntax::{
    Range,
    ast::expression::{Expr, ExprView, Name as AstName},
};
use serde::{Deserialize, Serialize};
use std::borrow::Cow;
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum TemplatePart {
    Text(String),
    Expression(Expression),
}

/// Compile-time value types. String members contain decoded values, owned for
/// source inference or borrowed from immutable built-in metadata. Use assignability
/// for compatibility; representation equality does not normalize string sets.
#[derive(Debug, Clone, PartialEq)]
pub enum Type {
    Number,
    Boolean,
    String,
    StringLiteral(Cow<'static, str>),
    StringUnion(Cow<'static, [Cow<'static, str>]>),
    Timing,
    Easing,
    Target,
    Event,
    Controller(&'static [crate::builtins::Field]),
    Record(&'static [crate::builtins::Field]),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(transparent)]
pub struct Name {
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Argument {
    pub name: Name,
    pub value: Expression,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ExpressionKind {
    Call {
        function: Name,
        arguments: Vec<Argument>,
    },
    Number {
        value: f64,
    },
    Boolean {
        value: bool,
    },
    String {
        value: String,
    },
    Reference {
        path: Vec<Name>,
    },
    Unary {
        operator: String,
        operand: Box<Expression>,
    },
    Binary {
        operator: String,
        left: Box<Expression>,
        right: Box<Expression>,
    },
}

/// Serializable runtime IR, lowered from syntax views after validation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Expression {
    #[serde(flatten)]
    pub kind: ExpressionKind,
}

#[derive(Debug)]
pub(crate) struct TypeError {
    pub message: String,
    pub range: Range,
}

pub use crate::scope::{Scope, SymbolKind};
pub use liva_syntax::is_identifier as identifier;

/// Primitive categories govern scalar operations without widening inferred types.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrimitiveCategory {
    Number,
    Boolean,
    String,
}

impl Type {
    /// The primitive category of a scalar value; records and opaque built-ins have none.
    pub fn primitive_category(&self) -> Option<PrimitiveCategory> {
        match self {
            Self::Number => Some(PrimitiveCategory::Number),
            Self::Boolean => Some(PrimitiveCategory::Boolean),
            Self::String | Self::StringLiteral(_) | Self::StringUnion(_) => {
                Some(PrimitiveCategory::String)
            }
            _ => None,
        }
    }

    pub fn is_scalar(&self) -> bool {
        self.primitive_category().is_some()
    }

    /// A provable fixed decoded string value, without observing runtime state.
    /// Duplicate union members do not change the proof. Broad strings, empty sets,
    /// sets with distinct members, and non-string types have no singleton value.
    pub fn singleton_string(&self) -> Option<&str> {
        match self {
            Self::StringLiteral(value) => Some(value.as_ref()),
            Self::StringUnion(values) => {
                let (first, remaining) = values.split_first()?;

                remaining
                    .iter()
                    .all(|value| value == first)
                    .then_some(first.as_ref())
            }
            _ => None,
        }
    }

    /// Whether every value represented by this source type is permitted by `destination`.
    /// String sets compare decoded values, ignoring duplicates and order. Other types
    /// retain exact compatibility, including the existing record/controller contracts.
    pub fn is_assignable_to(&self, destination: &Self) -> bool {
        match (self, destination) {
            (Self::StringLiteral(_) | Self::StringUnion(_), Self::String) => true,
            (Self::StringLiteral(source), Self::StringLiteral(target)) => source == target,
            (Self::StringLiteral(source), Self::StringUnion(target)) => target.contains(source),
            (Self::StringUnion(source), Self::StringLiteral(target)) => {
                source.iter().all(|member| member == target)
            }
            (Self::StringUnion(source), Self::StringUnion(target)) => {
                source.iter().all(|member| target.contains(member))
            }
            _ => self == destination,
        }
    }
}

impl fmt::Display for Type {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Number => formatter.write_str("number"),
            Self::Boolean => formatter.write_str("boolean"),
            Self::String => formatter.write_str("string"),
            Self::StringLiteral(value) => {
                // JSON quoting escapes control characters and quotes while preserving Unicode.
                formatter.write_str(&serde_json::to_string(value).map_err(|_| fmt::Error)?)
            }
            Self::StringUnion(values) => {
                let members: BTreeSet<_> = values.iter().collect();

                for (index, member) in members.into_iter().enumerate() {
                    if index > 0 {
                        formatter.write_str(" | ")?;
                    }

                    formatter.write_str(&serde_json::to_string(member).map_err(|_| fmt::Error)?)?;
                }

                Ok(())
            }
            Self::Timing => formatter.write_str("timing"),
            Self::Easing => formatter.write_str("easing"),
            Self::Target => formatter.write_str("target"),
            Self::Event => formatter.write_str("event"),
            Self::Controller(_) => formatter.write_str("controller"),
            Self::Record(fields) => {
                formatter.write_str("{ ")?;

                for (index, field) in fields.iter().enumerate() {
                    if index > 0 {
                        formatter.write_str(", ")?;
                    }

                    write!(formatter, "{}: {}", field.name, field.value_type)?;
                }

                formatter.write_str(" }")
            }
        }
    }
}

fn name_error(name: &AstName, message: impl Into<String>) -> TypeError {
    TypeError {
        message: message.into(),
        range: name.range(),
    }
}

pub(crate) trait ExprExt {
    fn error(&self, message: impl Into<String>) -> TypeError;
    fn check(&self, scope: &Scope) -> Result<Type, TypeError>;
    fn dependencies(&self) -> BTreeMap<String, Range>;
    fn to_output(&self) -> Result<Expression, TypeError>;
}

fn operand(expr: &Expr, index: usize) -> Result<Expr, TypeError> {
    expr.operands()
        .nth(index)
        .ok_or_else(|| expr.error("Expected expression"))
}

impl ExprExt for Expr {
    fn error(&self, message: impl Into<String>) -> TypeError {
        TypeError {
            message: message.into(),
            range: self.range(),
        }
    }

    fn dependencies(&self) -> BTreeMap<String, Range> {
        let mut result = BTreeMap::new();
        for node in self.syntax().descendants().filter_map(Expr::cast) {
            let name = match node.view() {
                ExprView::Reference => node.names().next(),
                ExprView::Call => node.function(),
                _ => None,
            };

            if let Some(name) = name {
                result.entry(name.text()).or_insert_with(|| name.range());
            }
        }
        result
    }

    fn check(&self, scope: &Scope) -> Result<Type, TypeError> {
        match self.view() {
            ExprView::Number => {
                if self.text().parse::<f64>().is_ok_and(f64::is_finite) {
                    Ok(Type::Number)
                } else {
                    Err(self.error("Non-finite expression number"))
                }
            }
            ExprView::Boolean => Ok(Type::Boolean),
            ExprView::String => Ok(Type::StringLiteral(
                self.string_value()
                    .map_err(|message| self.error(message))?
                    .into(),
            )),
            ExprView::Parenthesized => operand(self, 0)?.check(scope),
            ExprView::Reference => {
                let path: Vec<_> = self.names().collect();
                let first = path
                    .first()
                    .ok_or_else(|| self.error("Expected variable name"))?;
                let symbol = scope.get(&first.text()).ok_or_else(|| {
                    name_error(first, format!("Unknown variable: {}", first.text()))
                })?;
                let mut value_type = match &symbol.kind {
                    SymbolKind::Value(value_type) => value_type,
                    SymbolKind::Function(_) => {
                        return Err(name_error(first, "Functions cannot be used as values"));
                    }
                    SymbolKind::Pending => {
                        return Err(name_error(
                            first,
                            format!("Unresolved variable: {}", first.text()),
                        ));
                    }
                };

                for member in path.iter().skip(1) {
                    let error = || {
                        name_error(
                            member,
                            format!(
                                "Unknown variable member: {}",
                                path.iter().map(AstName::text).collect::<Vec<_>>().join(".")
                            ),
                        )
                    };
                    let (Type::Record(fields) | Type::Controller(fields)) = value_type else {
                        return Err(error());
                    };
                    value_type = &fields
                        .iter()
                        .find(|field| field.name == member.text())
                        .ok_or_else(error)?
                        .value_type;
                }
                Ok(value_type.clone())
            }
            ExprView::Call => {
                let function = self
                    .function()
                    .ok_or_else(|| self.error("Expected function name"))?;
                let symbol = scope.get(&function.text()).ok_or_else(|| {
                    name_error(&function, format!("Unknown function: {}", function.text()))
                })?;
                let SymbolKind::Function(metadata) = &symbol.kind else {
                    return Err(name_error(
                        &function,
                        format!("Value is not callable: {}", function.text()),
                    ));
                };
                let mut seen = BTreeSet::new();
                let arguments: Vec<_> = self.arguments().collect();

                for argument in &arguments {
                    let name = argument
                        .name()
                        .ok_or_else(|| self.error("Expected argument name"))?;

                    if !seen.insert(name.text()) {
                        return Err(name_error(
                            &name,
                            format!("Duplicate argument: {}", name.text()),
                        ));
                    }
                }

                let mut candidates: Vec<_> = metadata.signatures.iter().collect();

                for argument in &arguments {
                    let name = argument
                        .name()
                        .ok_or_else(|| self.error("Expected argument name"))?;
                    let value = argument
                        .value()
                        .ok_or_else(|| self.error("Expected argument value"))?;
                    let actual = value.check(scope)?;

                    let parameters: Vec<_> = metadata
                        .signatures
                        .iter()
                        .flat_map(|signature| signature.parameters)
                        .filter(|parameter| parameter.name == name.text())
                        .collect();

                    if parameters.is_empty() {
                        return Err(name_error(
                            &name,
                            format!("Unknown argument for {}: {}", function.text(), name.text()),
                        ));
                    }

                    if !parameters
                        .iter()
                        .any(|parameter| actual.is_assignable_to(&parameter.value_type))
                    {
                        return Err(value.error(format!(
                            "Invalid argument type for {}.{}: expected {}, got {}",
                            function.text(),
                            name.text(),
                            parameters[0].value_type,
                            actual
                        )));
                    }

                    if !parameters
                        .iter()
                        .any(|parameter| parameter.accepts(&actual))
                    {
                        return Err(value.error(format!(
                            "Argument for {}.{} must be a fixed string; got {}",
                            function.text(),
                            name.text(),
                            actual
                        )));
                    }

                    candidates.retain(|signature| {
                        signature.parameters.iter().any(|parameter| {
                            parameter.name == name.text() && parameter.accepts(&actual)
                        })
                    });
                }

                if let Some(signature) = candidates.iter().find(|signature| {
                    signature
                        .parameters
                        .iter()
                        .all(|parameter| parameter.optional || seen.contains(parameter.name))
                }) {
                    return Ok(signature.return_type.clone());
                }

                if let Some(signature) = candidates.first() {
                    let missing = signature
                        .parameters
                        .iter()
                        .filter(|parameter| !parameter.optional && !seen.contains(parameter.name))
                        .map(|parameter| parameter.name)
                        .collect::<Vec<_>>()
                        .join(", ");
                    return Err(self.error(format!(
                        "Missing argument for {}: {}",
                        function.text(),
                        missing
                    )));
                }

                Err(self.error(format!(
                    "Incompatible argument groups for {}: {}",
                    function.text(),
                    seen.into_iter().collect::<Vec<_>>().join(", ")
                )))
            }
            ExprView::Unary => {
                let value = operand(self, 0)?;
                let expected = if self.operator().as_deref() == Some("!") {
                    Type::Boolean
                } else {
                    Type::Number
                };
                if value.check(scope)? != expected {
                    return Err(value.error("Invalid unary operand type"));
                }
                Ok(expected)
            }
            ExprView::Binary => {
                let left = operand(self, 0)?;
                let right = operand(self, 1)?;
                let operator = self.operator().unwrap_or_default();
                let a = left.check(scope)?;
                let b = right.check(scope)?;
                let expected = match operator.as_str() {
                    "&&" | "||" => Some(PrimitiveCategory::Boolean),
                    "+" | "-" | "*" | "/" | "%" => Some(PrimitiveCategory::Number),
                    _ => a.primitive_category(),
                };
                if !a.is_scalar() || a.primitive_category() != expected {
                    return Err(left.error("Incompatible expression operands"));
                }
                if a.primitive_category() != b.primitive_category() {
                    return Err(right.error("Incompatible expression operands"));
                }
                Ok(
                    if matches!(operator.as_str(), "+" | "-" | "*" | "/" | "%") {
                        Type::Number
                    } else {
                        Type::Boolean
                    },
                )
            }
        }
    }

    fn to_output(&self) -> Result<Expression, TypeError> {
        let kind = match self.view() {
            ExprView::Number => ExpressionKind::Number {
                value: self
                    .text()
                    .parse()
                    .map_err(|_| self.error("Expected number"))?,
            },
            ExprView::Boolean => ExpressionKind::Boolean {
                value: self.text() == "true",
            },
            ExprView::String => ExpressionKind::String {
                value: self.string_value().map_err(|message| self.error(message))?,
            },
            ExprView::Reference => ExpressionKind::Reference {
                path: self
                    .names()
                    .map(|name| Name { text: name.text() })
                    .collect(),
            },
            ExprView::Parenthesized => return operand(self, 0)?.to_output(),
            ExprView::Call => ExpressionKind::Call {
                function: Name {
                    text: self
                        .function()
                        .ok_or_else(|| self.error("Expected function name"))?
                        .text(),
                },
                arguments: self
                    .arguments()
                    .map(|argument| {
                        Ok(Argument {
                            name: Name {
                                text: argument
                                    .name()
                                    .ok_or_else(|| self.error("Expected argument name"))?
                                    .text(),
                            },
                            value: argument
                                .value()
                                .ok_or_else(|| self.error("Expected argument value"))?
                                .to_output()?,
                        })
                    })
                    .collect::<Result<_, TypeError>>()?,
            },
            ExprView::Unary => ExpressionKind::Unary {
                operator: self.operator().unwrap_or_default(),
                operand: Box::new(operand(self, 0)?.to_output()?),
            },
            ExprView::Binary => ExpressionKind::Binary {
                operator: self.operator().unwrap_or_default(),
                left: Box::new(operand(self, 0)?.to_output()?),
                right: Box::new(operand(self, 1)?.to_output()?),
            },
        };
        Ok(Expression { kind })
    }
}

pub fn parse(text: &str) -> Result<Expression, String> {
    parse_with_diagnostics(text)
        .and_then(|expr| expr.to_output())
        .map_err(|error| error.message)
}

pub(crate) fn parse_with_diagnostics(text: &str) -> Result<Expr, TypeError> {
    let parsed = liva_syntax::parse_expression(text);
    if let Some(error) = parsed.diagnostics.into_iter().next() {
        return Err(TypeError {
            message: error.message,
            range: error.range,
        });
    }
    liva_syntax::ast::expression::from_container(&parsed.root).ok_or_else(|| TypeError {
        message: "Expected expression".into(),
        range: parsed.root.range(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::builtins::{Function, Parameter, Signature};

    static CHOOSE: Function = Function {
        name: "choose",
        signatures: &[
            Signature {
                parameters: &[
                    Parameter {
                        fixed: false,
                        name: "option",
                        optional: false,
                        value_type: Type::StringUnion(Cow::Borrowed(&[
                            Cow::Borrowed("x"),
                            Cow::Borrowed("y"),
                        ])),
                    },
                    Parameter {
                        fixed: false,
                        name: "amount",
                        optional: false,
                        value_type: Type::Number,
                    },
                ],
                return_type: Type::Number,
            },
            Signature {
                parameters: &[
                    Parameter {
                        fixed: false,
                        name: "option",
                        optional: false,
                        value_type: Type::StringLiteral(Cow::Borrowed("z")),
                    },
                    Parameter {
                        fixed: false,
                        name: "enabled",
                        optional: false,
                        value_type: Type::Boolean,
                    },
                ],
                return_type: Type::Boolean,
            },
        ],
    };

    static CONFIGURED: Function = Function {
        name: "configured",
        signatures: &[
            Signature {
                parameters: &[
                    Parameter {
                        fixed: true,
                        optional: false,
                        name: "option",
                        value_type: Type::String,
                    },
                    Parameter {
                        fixed: false,
                        optional: false,
                        name: "amount",
                        value_type: Type::Number,
                    },
                ],
                return_type: Type::Number,
            },
            Signature {
                parameters: &[
                    Parameter {
                        fixed: false,
                        optional: false,
                        name: "option",
                        value_type: Type::String,
                    },
                    Parameter {
                        fixed: false,
                        optional: false,
                        name: "enabled",
                        value_type: Type::Boolean,
                    },
                ],
                return_type: Type::Boolean,
            },
        ],
    };

    fn scope_with_options() -> Scope {
        let mut scope = Scope::motion();

        for (name, kind) in [
            ("choose", SymbolKind::Function(&CHOOSE)),
            ("configured", SymbolKind::Function(&CONFIGURED)),
            ("broad", SymbolKind::Value(Type::String)),
            (
                "subset",
                SymbolKind::Value(Type::StringUnion(Cow::Borrowed(&[
                    Cow::Borrowed("y"),
                    Cow::Borrowed("x"),
                    Cow::Borrowed("y"),
                ]))),
            ),
        ] {
            scope
                .declare(name.into(), kind, Range { start: 0, end: 0 })
                .unwrap();
        }

        scope
    }

    #[test]
    fn argument_validation_and_overload_selection_share_assignability() {
        let scope = scope_with_options();

        for (expression, expected) in [
            ("choose(option: ('x'), amount: 1)", Type::Number),
            ("choose(option: subset, amount: 1)", Type::Number),
            ("choose(option: 'z', enabled: true)", Type::Boolean),
        ] {
            let actual = parse_with_diagnostics(expression)
                .unwrap()
                .check(&scope)
                .unwrap();

            assert_eq!(actual, expected, "{expression}");
        }
    }

    #[test]
    fn invalid_argument_diagnostics_use_type_notation_and_expression_range() {
        let scope = scope_with_options();
        let expression = "choose(option: broad, amount: 1)";

        let error = parse_with_diagnostics(expression)
            .unwrap()
            .check(&scope)
            .unwrap_err();

        assert_eq!(&expression[error.range.start..error.range.end], "broad");
        assert_eq!(
            error.message,
            "Invalid argument type for choose.option: expected \"x\" | \"y\", got string"
        );
    }

    #[test]
    fn compatible_arguments_must_belong_to_one_overload() {
        let scope = scope_with_options();
        let expression = "choose(option: 'z', amount: 1)";

        let error = parse_with_diagnostics(expression)
            .unwrap()
            .check(&scope)
            .unwrap_err();

        assert!(
            error
                .message
                .starts_with("Incompatible argument groups for choose:")
        );
    }

    #[test]
    fn finite_unions_compare_as_strings() {
        let scope = scope_with_options();

        for expression in [
            "subset == 'x'",
            "subset != broad",
            "subset <= broad",
            "'z' > subset",
        ] {
            let actual = parse_with_diagnostics(expression)
                .unwrap()
                .check(&scope)
                .unwrap();

            assert_eq!(actual, Type::Boolean, "{expression}");
        }
    }

    #[test]
    fn configured_overloads_accept_their_fixed_and_dynamic_groups() {
        let scope = scope_with_options();

        for (expression, expected) in [
            ("configured(option: 'x', amount: 1)", Type::Number),
            ("configured(option: subset, enabled: true)", Type::Boolean),
        ] {
            let actual = parse_with_diagnostics(expression)
                .unwrap()
                .check(&scope)
                .unwrap();

            assert_eq!(actual, expected);
        }
    }

    #[test]
    fn overload_filtering_rejects_nonfixed_values_in_a_fixed_group() {
        let scope = scope_with_options();
        let expression = "configured(option: subset, amount: 1)";

        let error = parse_with_diagnostics(expression)
            .unwrap()
            .check(&scope)
            .unwrap_err();

        assert!(
            error
                .message
                .starts_with("Incompatible argument groups for configured:")
        );
    }
}
