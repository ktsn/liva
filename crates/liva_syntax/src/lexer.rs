use crate::{Diagnostic, Range};

pub fn is_name(s: &str) -> bool {
    let mut chars = s.bytes();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == b'_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}

pub fn is_property(s: &str) -> bool {
    is_name(s)
        || s.strip_prefix('-').is_some_and(is_name)
        || s.strip_prefix("--").is_some_and(is_name)
}

pub fn is_identifier(text: &str) -> bool {
    is_name(text)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TokenKind {
    Identifier,
    Number,
    Dimension,
    String,
    Text,
    Symbol,
    Whitespace,
    Comment,
}

#[derive(Debug, Clone)]
pub(crate) struct Token<'a> {
    pub text: &'a str,
    pub start: usize,
    pub range: Range,
    pub kind: TokenKind,
    pub trivia: bool,
    // Quoted CSS templates share the same lexical tokens as unquoted ones.
    // The enclosing raw string remains available to expression string literals.
    pub parts: Vec<Token<'a>>,
}

struct Lexer<'a> {
    source: &'a str,
    index: usize,
    limit: usize,
    diagnostics: Vec<Diagnostic>,
}

impl<'a> Lexer<'a> {
    fn token(&self, start: usize, kind: TokenKind) -> Token<'a> {
        Token {
            text: &self.source[start..self.index],
            start,
            range: Range {
                start,
                end: self.index,
            },
            kind,
            trivia: matches!(kind, TokenKind::Whitespace | TokenKind::Comment),
            parts: vec![],
        }
    }

    fn quoted(&mut self, _quote: char) -> Token<'a> {
        let start = self.index;
        // Locate the boundary without decoding escapes; embedded template text
        // cannot alter the extent of the enclosing raw string token.
        let boundary = crate::literal::quoted_end(&self.source[start..self.limit]);
        let closed = boundary.is_some();
        self.index = boundary.map_or(self.limit, |length| start + length);
        let end = self.index;
        let mut token = self.token(start, TokenKind::String);
        if !closed {
            self.diagnostics.push(Diagnostic::error(
                "syntax.string",
                "Unclosed string",
                token.range.clone(),
            ));
        }

        let saved_limit = self.limit;
        let saved_diagnostics = self.diagnostics.len();
        self.limit = if closed { end - 1 } else { end };
        let mut segment = start;
        self.index = start + 1;

        while self.index < self.limit {
            let Some(relative) = self.source[self.index..self.limit].find("${") else {
                break;
            };
            self.index += relative;
            if segment < self.index {
                token.parts.push(self.token(segment, TokenKind::Text));
            }
            token.parts.push(self.next());

            while self.index < self.limit {
                let part = self.next();
                let done = part.text == "}"
                    || (part.kind == TokenKind::Comment && part.text.contains('}'));
                token.parts.push(part);
                if done {
                    break;
                }
            }
            segment = self.index;
        }
        self.index = end;
        if !token.parts.is_empty() && segment < end {
            token.parts.push(self.token(segment, TokenKind::Text));
        }
        self.limit = saved_limit;
        self.diagnostics.truncate(saved_diagnostics);
        token
    }

    fn next(&mut self) -> Token<'a> {
        let start = self.index;
        let rest = &self.source[start..self.limit];
        let c = rest.chars().next().unwrap();
        let kind;

        if matches!(c, '\'' | '"') {
            return self.quoted(c);
        }
        if let Some(comment) = rest.strip_prefix("/*") {
            self.index += comment.find("*/").map_or(rest.len(), |end| end + 4);
            if !comment.contains("*/") {
                self.diagnostics.push(Diagnostic::error(
                    "syntax.comment",
                    "Unclosed comment",
                    Range {
                        start,
                        end: self.index,
                    },
                ));
            }
            kind = TokenKind::Comment;
        } else if rest.starts_with("//") {
            self.index += rest.find(['\r', '\n']).unwrap_or(rest.len());
            kind = TokenKind::Comment;
        } else if c.is_whitespace() {
            self.index += c.len_utf8();
            kind = TokenKind::Whitespace;
        } else if c == '\\' {
            self.index += 1;
            if self.index < self.limit {
                self.index += self.source[self.index..self.limit]
                    .chars()
                    .next()
                    .unwrap()
                    .len_utf8();
            }
            kind = TokenKind::Text;
        } else if c.is_ascii_digit()
            || (c == '.' && rest.as_bytes().get(1).is_some_and(u8::is_ascii_digit))
        {
            self.index += 1;
            while self.index < self.limit
                && (self.source.as_bytes()[self.index].is_ascii_digit()
                    || self.source.as_bytes()[self.index] == b'.')
            {
                self.index += 1;
            }
            let unit = self.index;
            if self.index < self.limit
                && (self.source.as_bytes()[self.index].is_ascii_alphabetic()
                    || self.source.as_bytes()[self.index] == b'_')
            {
                self.index += 1;
                while self.index < self.limit
                    && (self.source.as_bytes()[self.index].is_ascii_alphanumeric()
                        || matches!(self.source.as_bytes()[self.index], b'_' | b'-'))
                {
                    self.index += 1;
                }
            }
            kind = if self.index > unit {
                TokenKind::Dimension
            } else {
                TokenKind::Number
            };
        } else if c.is_ascii_alphabetic() || c == '_' {
            self.index += 1;
            while self.index < self.limit
                && (self.source.as_bytes()[self.index].is_ascii_alphanumeric()
                    || matches!(self.source.as_bytes()[self.index], b'_' | b'-'))
            {
                self.index += 1;
            }
            kind = TokenKind::Identifier;
        } else if let Some(op) = [
            "===", "!==", "&&", "||", "==", "!=", "<=", ">=", "->", "~>", ":=", "${", "://",
        ]
        .iter()
        .find(|op| {
            rest.starts_with(**op) && (**op != "://" || !rest[3..].starts_with(char::is_whitespace))
        }) {
            self.index += op.len();
            kind = TokenKind::Symbol;
        } else {
            self.index += c.len_utf8();
            kind = TokenKind::Symbol;
        }
        self.token(start, kind)
    }
}

pub(crate) fn lex(source: &str) -> (Vec<Token<'_>>, Vec<Diagnostic>) {
    let mut lexer = Lexer {
        source,
        index: 0,
        limit: source.len(),
        diagnostics: vec![],
    };
    let mut tokens = vec![];
    while lexer.index < source.len() {
        tokens.push(lexer.next());
    }
    (tokens, lexer.diagnostics)
}

pub fn semantic_text(source: &str) -> String {
    let (tokens, _) = lex(source);
    let mut interpolation = false;
    let mut text = String::new();

    for token in tokens {
        if token.text == "${" {
            interpolation = true;
        }
        if token.kind == TokenKind::Comment && !interpolation {
            text.push(' ');
        } else {
            text.push_str(token.text);
        }
        if matches!(token.text, "}" | "\n" | "\r") {
            interpolation = false;
        }
    }
    text.trim().into()
}

pub fn contains_comments(source: &str) -> bool {
    lex(source)
        .0
        .iter()
        .any(|token| token.trivia && (token.text.starts_with("/*") || token.text.starts_with("//")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_numbers_units_and_operators_use_one_token_vocabulary() {
        let source = "max-min max - min -1 20px 1.5rem .5s 1%2 background-color --offset";
        let (tokens, diagnostics) = lex(source);
        let significant: Vec<_> = tokens
            .iter()
            .filter(|token| !token.trivia)
            .map(|token| (token.text, token.kind))
            .collect();

        assert!(diagnostics.is_empty());
        assert_eq!(
            significant,
            [
                ("max-min", TokenKind::Identifier),
                ("max", TokenKind::Identifier),
                ("-", TokenKind::Symbol),
                ("min", TokenKind::Identifier),
                ("-", TokenKind::Symbol),
                ("1", TokenKind::Number),
                ("20px", TokenKind::Dimension),
                ("1.5rem", TokenKind::Dimension),
                (".5s", TokenKind::Dimension),
                ("1", TokenKind::Number),
                ("%", TokenKind::Symbol),
                ("2", TokenKind::Number),
                ("background-color", TokenKind::Identifier),
                ("-", TokenKind::Symbol),
                ("-", TokenKind::Symbol),
                ("offset", TokenKind::Identifier),
            ]
        );
        assert_eq!(
            tokens.iter().map(|token| token.text).collect::<String>(),
            source
        );
        for token in tokens {
            assert_eq!(&source[token.range.start..token.range.end], token.text);
        }
    }

    #[test]
    fn quoted_spelling_and_embedded_token_ranges_are_preserved() {
        let source = r#""日本\n ${value - 1} ${'😀'}" "https://example.com""#;
        let (tokens, diagnostics) = lex(source);
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        assert_eq!(tokens[0].kind, TokenKind::String);
        assert_eq!(
            tokens[0]
                .parts
                .iter()
                .map(|token| token.text)
                .collect::<String>(),
            tokens[0].text
        );

        for token in &tokens[0].parts {
            assert_eq!(&source[token.range.start..token.range.end], token.text);
        }
        assert_eq!(tokens.last().unwrap().text, "\"https://example.com\"");
    }
}
