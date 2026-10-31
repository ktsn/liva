use liva_syntax::Range;
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
    Target,
    Record(&'static [crate::builtins::Field]),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(transparent)]
pub struct Name {
    pub text: String,
    #[serde(skip)]
    pub range: Option<Range>,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Expression {
    #[serde(flatten)]
    pub kind: ExpressionKind,
    #[serde(skip)]
    pub range: Option<Range>,
}

#[derive(Debug)]
pub(crate) struct TypeError {
    pub message: String,
    pub range: Option<Range>,
}

impl Name {
    fn error(&self, message: impl Into<String>) -> TypeError {
        TypeError {
            message: message.into(),
            range: self.range.clone(),
        }
    }
}

impl Expression {
    pub(crate) fn error(&self, message: impl Into<String>) -> TypeError {
        TypeError {
            message: message.into(),
            range: self.range.clone(),
        }
    }

    pub(crate) fn dependencies(&self) -> BTreeMap<String, Option<Range>> {
        fn collect(expression: &Expression, result: &mut BTreeMap<String, Option<Range>>) {
            match &expression.kind {
                ExpressionKind::Reference { path } => {
                    result
                        .entry(path[0].text.clone())
                        .or_insert_with(|| path[0].range.clone());
                }
                ExpressionKind::Call { arguments, .. } => {
                    for argument in arguments {
                        collect(&argument.value, result);
                    }
                }
                ExpressionKind::Unary { operand, .. } => collect(operand, result),
                ExpressionKind::Binary { left, right, .. } => {
                    collect(left, result);
                    collect(right, result);
                }
                _ => {}
            }
        }

        let mut result = BTreeMap::new();
        collect(self, &mut result);
        result
    }
}

struct Parser {
    tokens: Vec<String>,
    index: usize,
    ranges: Vec<Range>,
}

fn tokenize(text: &str) -> Result<(Vec<String>, Vec<Range>), TypeError> {
    let mut ranges = vec![];
    let mut tokens = vec![];
    let mut i = 0;

    while i < text.len() {
        let c = text.as_bytes()[i];
        if c.is_ascii_whitespace() {
            i += 1;
            continue;
        }
        let start = i;

        if c == b'\'' || c == b'"' {
            i += 1;
            while i < text.len() && text.as_bytes()[i] != c {
                if text.as_bytes()[i] == b'\\' {
                    i += 1;
                }
                i += 1;
            }
            if i >= text.len() {
                return Err(TypeError {
                    message: "Unclosed expression string".into(),
                    range: Some(Range {
                        start,
                        end: text.len(),
                    }),
                });
            }
            i += 1;
        } else if c.is_ascii_digit()
            || (c == b'.' && text.as_bytes().get(i + 1).is_some_and(u8::is_ascii_digit))
        {
            i += 1;
            while i < text.len()
                && (text.as_bytes()[i].is_ascii_digit() || text.as_bytes()[i] == b'.')
            {
                i += 1;
            }
        } else if c.is_ascii_alphabetic() || c == b'_' {
            i += 1;
            while i < text.len()
                && (text.as_bytes()[i].is_ascii_alphanumeric() || text.as_bytes()[i] == b'_')
            {
                i += 1;
            }
        } else if let Some(op) = [
            "===", "!==", "&&", "||", "==", "!=", "<=", ">=", "+", "-", "*", "/", "%", "!", "<",
            ">", "(", ")", ".", ",", ":",
        ]
        .iter()
        .find(|op| text[i..].starts_with(**op))
        {
            i += op.len();
        } else {
            return Err(TypeError {
                message: "Unsupported expression token".into(),
                range: Some(Range {
                    start,
                    end: start + text[start..].chars().next().unwrap().len_utf8(),
                }),
            });
        }

        tokens.push(text[start..i].into());
        ranges.push(Range { start, end: i });
        if tokens.len() > 256 {
            return Err(TypeError {
                message: "Expression is too complex".into(),
                range: Some(Range { start, end: i }),
            });
        }
    }

    Ok((tokens, ranges))
}

impl Parser {
    fn take(&mut self) -> Result<String, String> {
        let token = self
            .tokens
            .get(self.index)
            .cloned()
            .ok_or("Expected expression")?;
        self.index += 1;
        Ok(token)
    }

    fn expression(&mut self, minimum: u8) -> Result<Expression, String> {
        let start_index = self.index;
        let token = self.take()?;
        let kind = match token.as_str() {
            "!" | "+" | "-" => {
                let operand = self.expression(7)?;
                ExpressionKind::Unary {
                    operator: token,
                    operand: Box::new(operand),
                }
            }
            "(" => {
                let value = self.expression(0)?;
                if self.take()? != ")" {
                    return Err("Expected closing parenthesis".into());
                }
                value.kind
            }
            "true" | "false" => ExpressionKind::Boolean {
                value: token == "true",
            },
            _ if token.starts_with(['\'', '"']) => {
                let mut value = String::new();
                let mut chars = token[1..token.len() - 1].chars();
                while let Some(c) = chars.next() {
                    value.push(if c == '\\' {
                        match chars.next().ok_or("Invalid string escape")? {
                            'n' => '\n',
                            'r' => '\r',
                            't' => '\t',
                            '\\' => '\\',
                            '\'' => '\'',
                            '"' => '"',
                            _ => return Err("Unsupported string escape".into()),
                        }
                    } else {
                        c
                    });
                }
                ExpressionKind::String { value }
            }
            _ if token.parse::<f64>().is_ok() => ExpressionKind::Number {
                value: token.parse().unwrap(),
            },
            _ if identifier(&token) => {
                let mut path = vec![Name {
                    text: token,
                    range: Some(self.ranges[start_index].clone()),
                }];
                while self.tokens.get(self.index).is_some_and(|t| t == ".") {
                    self.index += 1;
                    let member = self.take()?;
                    if !identifier(&member) {
                        return Err("Expected member name".into());
                    }
                    path.push(Name {
                        text: member,
                        range: Some(self.ranges[self.index - 1].clone()),
                    });
                }
                if self
                    .tokens
                    .get(self.index)
                    .is_some_and(|token| token == "(")
                {
                    if path.len() != 1 {
                        return Err("Expected function name".into());
                    }

                    self.index += 1;
                    let mut arguments = vec![];

                    while self
                        .tokens
                        .get(self.index)
                        .is_some_and(|token| token != ")")
                    {
                        let name_range = self.ranges[self.index].clone();
                        let name = self.take()?;

                        if !identifier(&name)
                            || self.tokens.get(self.index).is_none_or(|token| token != ":")
                        {
                            return Err("Expected named argument and colon".into());
                        }

                        self.index += 1;
                        let value = self.expression(0)?;
                        arguments.push(Argument {
                            name: Name {
                                text: name,
                                range: Some(name_range),
                            },
                            value,
                        });

                        if !self
                            .tokens
                            .get(self.index)
                            .is_some_and(|token| token == ",")
                        {
                            break;
                        }

                        self.index += 1;
                    }

                    if self.take()? != ")" {
                        return Err("Expected closing call parenthesis".into());
                    }

                    ExpressionKind::Call {
                        function: path.remove(0),
                        arguments,
                    }
                } else {
                    ExpressionKind::Reference { path }
                }
            }
            _ => return Err("Expected expression operand".into()),
        };

        let mut left = Expression {
            kind,
            range: Some(Range {
                start: self.ranges[start_index].start,
                end: self.ranges[self.index - 1].end,
            }),
        };

        while let Some(operator) = self.tokens.get(self.index).cloned() {
            let priority = match operator.as_str() {
                "||" => 1,
                "&&" => 2,
                "==" | "!=" | "===" | "!==" => 3,
                "<" | "<=" | ">" | ">=" => 4,
                "+" | "-" => 5,
                "*" | "/" | "%" => 6,
                _ => break,
            };
            if priority < minimum {
                break;
            }
            self.index += 1;
            let right = self.expression(priority + 1)?;
            left = Expression {
                range: Some(Range {
                    start: self.ranges[start_index].start,
                    end: self.ranges[self.index - 1].end,
                }),
                kind: ExpressionKind::Binary {
                    operator,
                    left: Box::new(left),
                    right: Box::new(right),
                },
            };
        }

        Ok(left)
    }
}

pub fn identifier(text: &str) -> bool {
    let mut chars = text.bytes();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == b'_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == b'_')
}

pub fn parse(text: &str) -> Result<Expression, String> {
    parse_with_diagnostics(text).map_err(|error| error.message)
}

pub(crate) fn parse_with_diagnostics(text: &str) -> Result<Expression, TypeError> {
    let (tokens, ranges) = tokenize(text)?;
    let mut parser = Parser {
        tokens,
        ranges,
        index: 0,
    };
    let expression = parser.expression(0).map_err(|message| TypeError {
        message,
        range: Some(
            parser
                .ranges
                .get(parser.index.saturating_sub(1))
                .cloned()
                .unwrap_or(Range {
                    start: text.len(),
                    end: text.len(),
                }),
        ),
    })?;

    if parser.index != parser.tokens.len() {
        return Err(TypeError {
            message: "Unexpected expression suffix".into(),
            range: Some(parser.ranges[parser.index].clone()),
        });
    }
    Ok(expression)
}

pub type Scope = BTreeMap<String, Type>;

impl Type {
    pub fn is_scalar(self) -> bool {
        matches!(self, Self::Number | Self::Boolean | Self::String)
    }
}

impl Expression {
    pub(crate) fn check(&self, scope: &Scope) -> Result<Type, TypeError> {
        match &self.kind {
            ExpressionKind::Number { value } if value.is_finite() => Ok(Type::Number),
            ExpressionKind::Boolean { .. } => Ok(Type::Boolean),
            ExpressionKind::String { .. } => Ok(Type::String),
            ExpressionKind::Reference { path } => {
                let mut value_type = *scope
                    .get(&path[0].text)
                    .ok_or_else(|| path[0].error(format!("Unknown variable: {}", path[0].text)))?;

                for member in path.iter().skip(1) {
                    let error = || {
                        member.error(format!(
                            "Unknown variable member: {}",
                            path.iter()
                                .map(|name| name.text.as_str())
                                .collect::<Vec<_>>()
                                .join(".")
                        ))
                    };
                    let Type::Record(fields) = value_type else {
                        return Err(error());
                    };
                    value_type = fields
                        .iter()
                        .find(|field| field.name == member.text)
                        .ok_or_else(error)?
                        .value_type;
                }

                Ok(value_type)
            }
            ExpressionKind::Call {
                function,
                arguments,
            } => {
                let signature = crate::builtins::lookup(&function.text)
                    .map_err(|message| function.error(message))?;
                let mut seen = BTreeSet::new();

                for argument in arguments {
                    if !seen.insert(&argument.name.text) {
                        return Err(argument
                            .name
                            .error(format!("Duplicate argument: {}", argument.name.text)));
                    }

                    let parameter = signature
                        .parameters
                        .iter()
                        .find(|parameter| parameter.name == argument.name.text)
                        .ok_or_else(|| {
                            argument.name.error(format!(
                                "Unknown argument for {}: {}",
                                function.text, argument.name.text
                            ))
                        })?;
                    let actual = argument.value.check(scope)?;

                    if actual != parameter.value_type {
                        return Err(argument.value.error(format!(
                            "Invalid argument type for {}.{}: expected {:?}, got {:?}",
                            function.text, argument.name.text, parameter.value_type, actual
                        )));
                    }
                }

                for parameter in signature.parameters {
                    if !seen.iter().any(|name| name.as_str() == parameter.name) {
                        return Err(self.error(format!(
                            "Missing argument for {}: {}",
                            function.text, parameter.name
                        )));
                    }
                }

                Ok(signature.return_type)
            }
            ExpressionKind::Unary { operator, operand } => {
                let expected = if operator == "!" {
                    Type::Boolean
                } else {
                    Type::Number
                };

                if operand.check(scope)? != expected {
                    return Err(operand.error("Invalid unary operand type"));
                }

                Ok(expected)
            }
            ExpressionKind::Binary {
                operator,
                left,
                right,
            } => {
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
            _ => Err(self.error("Non-finite expression number")),
        }
    }
}

enum TemplateSegment<T> {
    Text(String),
    Expression(T),
}

pub fn template(text: &str) -> Result<Vec<TemplatePart>, String> {
    template_with(text, |text, _| {
        parse_with_diagnostics(text).map_err(|error| error.message)
    })
    .map(|parts| {
        parts
            .into_iter()
            .map(|part| match part {
                TemplateSegment::Text(text) => TemplatePart::Text(text),
                TemplateSegment::Expression(expression) => TemplatePart::Expression(expression),
            })
            .collect()
    })
}

pub(crate) fn check_template(text: &str, scope: &Scope) -> Result<(), TypeError> {
    let mut error = None;
    let result = template_with(text, |source, offset| {
        let checked = parse_with_diagnostics(source).and_then(|parsed| {
            if !parsed.check(scope)?.is_scalar() {
                return Err(parsed.error("CSS templates require scalar values"));
            }
            Ok(())
        });

        checked.map_err(|mut problem| {
            if let Some(range) = &mut problem.range {
                range.start += offset;
                range.end += offset;
            }
            let message = problem.message.clone();
            error = Some(problem);
            message
        })
    });

    result.map(|_| ()).map_err(|message| {
        error.unwrap_or(TypeError {
            message,
            range: Some(Range {
                start: 0,
                end: text.len(),
            }),
        })
    })
}

fn template_with<T>(
    text: &str,
    mut parse_expression: impl FnMut(&str, usize) -> Result<T, String>,
) -> Result<Vec<TemplateSegment<T>>, String> {
    let mut parts = vec![];
    let mut start = 0;

    while let Some(relative) = text[start..].find("${") {
        let begin = start + relative;
        if begin > start {
            parts.push(TemplateSegment::Text(text[start..begin].into()));
        }
        let mut quote = None;
        let mut escaped = false;
        let end = text[begin + 2..]
            .char_indices()
            .find_map(|(i, c)| {
                if escaped {
                    escaped = false;
                    return None;
                }
                if c == '\\' {
                    escaped = true;
                    return None;
                }
                if let Some(q) = quote {
                    if c == q {
                        quote = None;
                    }
                } else if matches!(c, '\'' | '"') {
                    quote = Some(c);
                } else if c == '}' {
                    return Some(begin + 2 + i);
                }
                None
            })
            .ok_or("Unclosed CSS interpolation")?;
        parts.push(TemplateSegment::Expression(parse_expression(
            &text[begin + 2..end],
            begin + 2,
        )?));
        start = end + 1;
    }

    if start < text.len() {
        parts.push(TemplateSegment::Text(text[start..].into()));
    }
    Ok(parts)
}
