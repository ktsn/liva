use crate::ast::{AstNode, Value};
use crate::lexer::{Token, TokenKind, lex};
use crate::literal::string_value;
use crate::{Diagnostic, Kind, Liva, Range, SyntaxNode, is_identifier};
use rowan::{GreenNodeBuilder, Language};

struct Parser<'a, 't, 'b> {
    tokens: &'t [Token<'a>],
    index: usize,
    last: Range,
    recovery_suffix: Option<Range>,
    builder: &'b mut GreenNodeBuilder<'static>,
    diagnostics: &'b mut Vec<Diagnostic>,
}

impl Parser<'_, '_, '_> {
    fn start(&mut self, kind: Kind) {
        self.builder.start_node(Liva::kind_to_raw(kind));
    }

    fn end(&mut self) {
        self.builder.finish_node();
    }

    fn significant(&self) -> Option<usize> {
        (self.index..self.tokens.len()).find(|&i| !self.tokens[i].trivia)
    }

    fn at(&self) -> &str {
        self.significant().map_or("", |i| self.tokens[i].text)
    }

    fn gap(&mut self) {
        while self.tokens.get(self.index).is_some_and(|t| t.trivia) {
            self.bump(Kind::Trivia);
        }
    }

    fn bump(&mut self, kind: Kind) {
        if let Some(token) = self.tokens.get(self.index) {
            self.builder.token(
                Liva::kind_to_raw(if token.trivia { Kind::Trivia } else { kind }),
                token.text,
            );
            if !token.trivia {
                self.last = token.range.clone();
            }
            self.index += 1;
        }
    }

    fn error(&mut self, message: impl Into<String>, range: Range) {
        self.diagnostics
            .push(Diagnostic::error("syntax.expression", message, range));
    }

    fn expect(&mut self, text: &str, message: &str) {
        self.gap();
        if self.at() == text {
            self.bump(Kind::Text);
        } else {
            self.error(message, self.last.clone());
        }
    }

    fn name(&mut self) {
        self.start(Kind::Name);
        self.bump(Kind::Text);
        self.end();
    }

    fn expression(&mut self, minimum: u8) {
        self.gap();
        let checkpoint = self.builder.checkpoint();
        let token = self.at().to_owned();
        match token.as_str() {
            "" | ")" | "," => {
                self.error("Expected expression", self.last.clone());
                return;
            }
            "!" | "+" | "-" => {
                self.start(Kind::UnaryExpr);
                self.bump(Kind::Operator);
                self.expression(7);
                self.end();
            }
            "(" => {
                self.start(Kind::ParenExpr);
                self.bump(Kind::Text);
                self.expression(0);
                self.expect(")", "Expected closing parenthesis");
                self.end();
            }
            "true" | "false" => {
                self.start(Kind::BooleanExpr);
                self.bump(Kind::Text);
                self.end();
            }
            _ if token.starts_with(['\'', '"']) => {
                self.start(Kind::StringExpr);
                self.bump(Kind::Text);
                self.end();
                if let Err(message) = string_value(&token) {
                    self.error(message, self.last.clone());
                }
            }
            _ if token.parse::<f64>().is_ok() => {
                self.start(Kind::NumberExpr);
                self.bump(Kind::Text);
                self.end();
            }
            _ if is_identifier(&token) => {
                let next = self
                    .tokens
                    .iter()
                    .skip(self.index + 1)
                    .find(|t| !t.trivia)
                    .map(|t| t.text);
                if next == Some("(") {
                    self.start(Kind::Call);
                    self.start(Kind::Header);
                    self.name();
                    self.end();
                    self.gap();
                    self.bump(Kind::Text);

                    while !matches!(self.at(), "" | ")") {
                        self.gap();
                        self.start(Kind::Argument);
                        self.start(Kind::Header);
                        let valid = is_identifier(self.at());
                        self.name();
                        self.end();
                        if !valid || self.at() != ":" {
                            self.error("Expected named argument and colon", self.last.clone());
                            self.end();
                            break;
                        }
                        self.gap();
                        self.bump(Kind::Text);
                        self.start(Kind::Value);
                        self.expression(0);
                        self.end();
                        self.end();
                        if self.at() != "," {
                            break;
                        }
                        self.gap();
                        self.bump(Kind::Text);
                    }
                    self.expect(")", "Expected closing call parenthesis");
                    self.end();
                } else {
                    self.start(Kind::ReferenceExpr);
                    self.name();
                    while self.at() == "." {
                        self.gap();
                        self.bump(Kind::Text);
                        self.gap();
                        if !is_identifier(self.at()) {
                            if self.at() != "" {
                                self.bump(Kind::Text);
                            }
                            self.error("Expected member name", self.last.clone());
                            break;
                        }
                        self.name();
                    }
                    self.end();
                }
            }
            _ => {
                self.start(Kind::Error);
                self.bump(Kind::Text);
                self.end();
                let mut range = self.last.clone();
                if token.starts_with('\\') && token.len() > 1 {
                    range.end = range.start + 1;
                    let suffix = format!(
                        "{}{}",
                        &token[1..],
                        self.tokens[self.index..]
                            .iter()
                            .map(|token| token.text)
                            .collect::<String>()
                    );
                    let length = if suffix.starts_with(['\'', '"']) {
                        crate::literal::quoted_end(&suffix).unwrap_or(suffix.len())
                    } else {
                        suffix.chars().next().unwrap().len_utf8()
                    };
                    self.recovery_suffix = Some(Range {
                        start: range.end,
                        end: range.end + length,
                    });
                }
                self.error("Unsupported expression token", range);
                return;
            }
        }

        loop {
            let priority = match self.at() {
                "||" => 1,
                "&&" => 2,
                "==" | "!=" => 3,
                "<" | "<=" | ">" | ">=" => 4,
                "+" | "-" => 5,
                "*" | "/" | "%" => 6,
                _ => break,
            };
            if priority < minimum {
                break;
            }
            self.builder
                .start_node_at(checkpoint, Liva::kind_to_raw(Kind::BinaryExpr));
            self.gap();
            if self.at() == "-" {
                let before = self
                    .index
                    .checked_sub(1)
                    .and_then(|index| self.tokens.get(index));
                let after = self.tokens.get(self.index + 1);
                if !before.is_some_and(|token| token.kind == TokenKind::Whitespace)
                    || !after.is_some_and(|token| token.kind == TokenKind::Whitespace)
                {
                    self.error(
                        "Subtraction requires whitespace on both sides of -",
                        self.tokens[self.index].range.clone(),
                    );
                }
            }
            self.bump(Kind::Operator);
            self.expression(priority + 1);
            self.end();
        }
    }
}

/// Parse one expression, leaving the next declaration and its trivia untouched.
pub(crate) fn emit_prefix(
    tokens: &[Token<'_>],
    end: usize,
    builder: &mut GreenNodeBuilder<'static>,
    diagnostics: &mut Vec<Diagnostic>,
) -> usize {
    let boundary = tokens
        .iter()
        .position(|token| matches!(token.text, "{" | "}" | ";" | "@"))
        .unwrap_or(tokens.len());
    // A track's CSS name is a structural suffix, including custom/vendor names
    // whose leading hyphens would otherwise be consumed as expression operators.
    let mut nesting = 0usize;
    let track = tokens[..boundary].iter().position(|token| {
        match token.text {
            "(" | "[" => nesting += 1,
            ")" | "]" => nesting = nesting.saturating_sub(1),
            "~>" if nesting == 0 => return true,
            _ => {}
        }

        false
    });
    let boundary = track
        .and_then(|track| {
            let end = (0..track).rfind(|&index| !tokens[index].trivia)?;
            let mut start = end;

            while start > 0
                && tokens[start - 1].range.end == tokens[start].range.start
                && !tokens[start - 1].trivia
            {
                start -= 1;
            }

            let name = tokens[start..=end]
                .iter()
                .map(|token| token.text)
                .collect::<String>();
            crate::is_property(&name).then_some(start)
        })
        .unwrap_or(boundary);
    let tokens = &tokens[..boundary];
    let limit = tokens
        .iter()
        .enumerate()
        .filter(|(_, token)| !token.trivia)
        .nth(256)
        .map(|(index, _)| index);
    let mut parser = Parser {
        tokens: &tokens[..limit.unwrap_or(tokens.len())],
        index: 0,
        last: Range { start: end, end },
        recovery_suffix: None,
        builder,
        diagnostics,
    };

    parser.expression(0);

    if limit.is_some() && parser.index == parser.tokens.len() {
        parser.error("Expression is too complex", parser.last.clone());
    }

    parser.index
}

pub(crate) fn emit(
    tokens: &[Token<'_>],
    end: usize,
    builder: &mut GreenNodeBuilder<'static>,
    diagnostics: &mut Vec<Diagnostic>,
) {
    let limit = tokens
        .iter()
        .filter(|t| !t.trivia)
        .nth(256)
        .map(|t| t.range.clone());
    let mut parser = Parser {
        tokens,
        index: 0,
        last: Range { start: end, end },
        recovery_suffix: None,
        builder,
        diagnostics,
    };

    if let Some(range) = limit {
        parser.error("Expression is too complex", range);
    } else {
        parser.expression(0);
        parser.gap();
        if parser.index < parser.tokens.len() || parser.recovery_suffix.is_some() {
            let range = parser
                .recovery_suffix
                .take()
                .unwrap_or_else(|| parser.tokens[parser.index].range.clone());
            parser.error("Unsupported expression token", range);
        }
    }

    if parser.index < parser.tokens.len() {
        parser.start(Kind::Error);
        while parser.index < parser.tokens.len() {
            parser.bump(Kind::Text);
        }
        parser.end();
    }
}

pub fn parse(text: &str) -> crate::Parse<Value> {
    let (tokens, _) = lex(text);
    let mut builder = GreenNodeBuilder::new();
    let mut diagnostics = vec![];
    builder.start_node(Liva::kind_to_raw(Kind::Value));
    emit(&tokens, text.len(), &mut builder, &mut diagnostics);
    builder.finish_node();

    crate::Parse {
        root: Value::cast(SyntaxNode::new_root(builder.finish())).unwrap(),
        diagnostics,
    }
}
