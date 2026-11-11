use liva_syntax::ast::AstNode;
use liva_syntax::{
    Range,
    ast::expression::{Expr, ExprView, Name as AstName},
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum TemplatePart {
    Text(String),
    Expression(Expression),
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Type {
    Number,
    Boolean,
    String,
    Timing,
    Easing,
    Target,
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

impl Type {
    pub fn is_scalar(self) -> bool {
        matches!(self, Self::Number | Self::Boolean | Self::String)
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
            ExprView::String => Ok(Type::String),
            ExprView::Parenthesized => operand(self, 0)?.check(scope),
            ExprView::Reference => {
                let path: Vec<_> = self.names().collect();
                let first = path
                    .first()
                    .ok_or_else(|| self.error("Expected variable name"))?;
                let symbol = scope.get(&first.text()).ok_or_else(|| {
                    name_error(first, format!("Unknown variable: {}", first.text()))
                })?;
                let mut value_type = match symbol.kind {
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
                    value_type = fields
                        .iter()
                        .find(|field| field.name == member.text())
                        .ok_or_else(error)?
                        .value_type;
                }
                Ok(value_type)
            }
            ExprView::Call => {
                let function = self
                    .function()
                    .ok_or_else(|| self.error("Expected function name"))?;
                let symbol = scope.get(&function.text()).ok_or_else(|| {
                    name_error(&function, format!("Unknown function: {}", function.text()))
                })?;
                let SymbolKind::Function(metadata) = symbol.kind else {
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
                        .any(|parameter| parameter.value_type == actual)
                    {
                        return Err(value.error(format!(
                            "Invalid argument type for {}.{}: expected {:?}, got {:?}",
                            function.text(),
                            name.text(),
                            parameters[0].value_type,
                            actual
                        )));
                    }

                    candidates.retain(|signature| {
                        signature.parameters.iter().any(|parameter| {
                            parameter.name == name.text() && parameter.value_type == actual
                        })
                    });
                }

                if let Some(signature) = candidates.iter().find(|signature| {
                    signature
                        .parameters
                        .iter()
                        .all(|parameter| parameter.optional || seen.contains(parameter.name))
                }) {
                    return Ok(signature.return_type);
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
                    "&&" | "||" => Type::Boolean,
                    "+" | "-" | "*" | "/" | "%" => Type::Number,
                    _ => a,
                };
                if !a.is_scalar() || a != expected {
                    return Err(left.error("Incompatible expression operands"));
                }
                if a != b {
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
