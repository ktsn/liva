use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Expression {
    Call {
        function: String,
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
        path: Vec<String>,
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
pub struct Argument {
    pub name: String,
    pub value: Expression,
}

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

struct Parser {
    tokens: Vec<String>,
    index: usize,
}

fn tokenize(text: &str) -> Result<Vec<String>, String> {
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
                return Err("Unclosed expression string".into());
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
            return Err("Unsupported expression token".into());
        }

        tokens.push(text[start..i].into());
        if tokens.len() > 256 {
            return Err("Expression is too complex".into());
        }
    }

    Ok(tokens)
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
        let token = self.take()?;
        let mut left = match token.as_str() {
            "!" | "+" | "-" => Expression::Unary {
                operator: token,
                operand: Box::new(self.expression(7)?),
            },
            "(" => {
                let value = self.expression(0)?;
                if self.take()? != ")" {
                    return Err("Expected closing parenthesis".into());
                }
                value
            }
            "true" | "false" => Expression::Boolean {
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
                Expression::String { value }
            }
            _ if token.parse::<f64>().is_ok() => Expression::Number {
                value: token.parse().unwrap(),
            },
            _ if identifier(&token) => {
                let mut path = vec![token];
                while self.tokens.get(self.index).is_some_and(|t| t == ".") {
                    self.index += 1;
                    let member = self.take()?;
                    if !identifier(&member) {
                        return Err("Expected member name".into());
                    }
                    path.push(member);
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
                        let name = self.take()?;

                        if !identifier(&name) || self.take()? != ":" {
                            return Err("Expected named argument and colon".into());
                        }

                        let value = self.expression(0)?;
                        arguments.push(Argument { name, value });

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

                    Expression::Call {
                        function: path.remove(0),
                        arguments,
                    }
                } else {
                    Expression::Reference { path }
                }
            }
            _ => return Err("Expected expression operand".into()),
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
            left = Expression::Binary {
                operator,
                left: Box::new(left),
                right: Box::new(right),
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
    let mut parser = Parser {
        tokens: tokenize(text)?,
        index: 0,
    };
    let expression = parser.expression(0)?;
    if parser.index != parser.tokens.len() {
        return Err("Unexpected expression suffix".into());
    }
    Ok(expression)
}

pub type Scope = BTreeMap<String, Type>;

impl Type {
    pub fn is_scalar(self) -> bool {
        matches!(self, Self::Number | Self::Boolean | Self::String)
    }
}

pub fn check(expression: &Expression, scope: &Scope) -> Result<Type, String> {
    match expression {
        Expression::Number { value } if value.is_finite() => Ok(Type::Number),
        Expression::Boolean { .. } => Ok(Type::Boolean),
        Expression::String { .. } => Ok(Type::String),
        Expression::Reference { path } => {
            let mut value_type = *scope
                .get(&path[0])
                .ok_or_else(|| format!("Unknown variable: {}", path[0]))?;

            for member in &path[1..] {
                let Type::Record(fields) = value_type else {
                    return Err(format!("Unknown variable member: {}", path.join(".")));
                };
                value_type = fields
                    .iter()
                    .find(|field| field.name == member)
                    .ok_or_else(|| format!("Unknown variable member: {}", path.join(".")))?
                    .value_type;
            }

            Ok(value_type)
        }
        Expression::Call { function, .. } => {
            crate::builtins::lookup(function)?;
            Err("Source-producing function calls belong in source initializers".into())
        }
        Expression::Unary { operator, operand } => {
            let expected = if operator == "!" {
                Type::Boolean
            } else {
                Type::Number
            };
            if check(operand, scope)? != expected {
                return Err("Invalid unary operand type".into());
            }
            Ok(expected)
        }
        Expression::Binary {
            operator,
            left,
            right,
        } => {
            let a = check(left, scope)?;
            let b = check(right, scope)?;
            let expected = match operator.as_str() {
                "&&" | "||" => Type::Boolean,
                "+" | "-" | "*" | "/" | "%" => Type::Number,
                _ => a,
            };
            if !a.is_scalar() || a != b || a != expected {
                return Err("Incompatible expression operands".into());
            }
            Ok(
                if matches!(operator.as_str(), "+" | "-" | "*" | "/" | "%") {
                    Type::Number
                } else {
                    Type::Boolean
                },
            )
        }
        _ => Err("Non-finite expression number".into()),
    }
}

pub fn template(text: &str) -> Result<Vec<TemplatePart>, String> {
    let mut parts = vec![];
    let mut start = 0;

    while let Some(relative) = text[start..].find("${") {
        let begin = start + relative;
        if begin > start {
            parts.push(TemplatePart::Text(text[start..begin].into()));
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
        parts.push(TemplatePart::Expression(parse(&text[begin + 2..end])?));
        start = end + 1;
    }

    if start < text.len() {
        parts.push(TemplatePart::Text(text[start..].into()));
    }
    Ok(parts)
}
