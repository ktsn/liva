use rowan::{GreenNodeBuilder, Language};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[repr(u16)]
pub enum Kind {
    Document,
    Block,
    Header,
    Declaration,
    Value,
    Call,
    Argument,
    Text,
    Trivia,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Liva {}

impl Language for Liva {
    type Kind = Kind;

    fn kind_from_raw(raw: rowan::SyntaxKind) -> Kind {
        match raw.0 {
            0 => Kind::Document,
            1 => Kind::Block,
            2 => Kind::Header,
            3 => Kind::Declaration,
            4 => Kind::Value,
            5 => Kind::Call,
            6 => Kind::Argument,
            7 => Kind::Text,
            8 => Kind::Trivia,
            _ => Kind::Error,
        }
    }

    fn kind_to_raw(kind: Kind) -> rowan::SyntaxKind {
        rowan::SyntaxKind(kind as u16)
    }
}

pub type SyntaxNode = rowan::SyntaxNode<Liva>;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Range {
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Diagnostic {
    pub code: String,
    pub severity: String,
    pub message: String,
    pub range: Range,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub related: Vec<Range>,
}

impl Diagnostic {
    pub fn error(code: &str, message: impl Into<String>, range: Range) -> Self {
        Self {
            code: code.into(),
            severity: "error".into(),
            message: message.into(),
            range,
            related: vec![],
        }
    }
}

#[derive(Debug, Clone)]
pub struct Ast(pub SyntaxNode);

impl Ast {
    pub fn children(&self, kind: Kind) -> impl Iterator<Item = Ast> + '_ {
        self.0.children().filter(move |n| n.kind() == kind).map(Ast)
    }

    pub fn child(&self, kind: Kind) -> Option<Ast> {
        self.children(kind).next()
    }

    pub fn text(&self) -> String {
        self.0.text().to_string()
    }

    pub fn range(&self) -> Range {
        let r = self.0.text_range();
        Range {
            start: u32::from(r.start()) as usize,
            end: u32::from(r.end()) as usize,
        }
    }

    pub fn header(&self) -> Option<String> {
        self.child(Kind::Header).map(|n| semantic_text(&n.text()))
    }

    pub fn value(&self) -> Option<String> {
        self.child(Kind::Value).map(|n| semantic_text(&n.text()))
    }
}

pub struct Parse {
    pub root: Ast,
    pub diagnostics: Vec<Diagnostic>,
}

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

// Tokens retain strings and comments atomically, so delimiters inside them never
// participate in structural parsing. Offsets always count UTF-8 bytes.
#[derive(Clone)]
struct Token<'a> {
    text: &'a str,
    start: usize,
    trivia: bool,
}

fn lex(source: &str, raw_value: bool) -> (Vec<Token<'_>>, Vec<Diagnostic>) {
    let mut tokens: Vec<Token<'_>> = vec![];
    let mut errors = vec![];
    let mut i = 0;
    let mut in_value = raw_value;
    let mut groups = 0usize;

    while i < source.len() {
        let start = i;
        let rest = &source[i..];
        let c = rest.chars().next().unwrap();
        let mut trivia = false;

        if let Some(comment) = rest.strip_prefix("/*") {
            trivia = true;
            i = comment
                .find("*/")
                .map_or(source.len(), |end| start + end + 4);

            if comment.find("*/").is_none() {
                errors.push(Diagnostic::error(
                    "syntax.comment",
                    "Unclosed comment",
                    Range { start, end: i },
                ));
            }
        } else if rest.starts_with("//") {
            trivia = true;
            i = rest
                .find(['\r', '\n'])
                .map_or(source.len(), |end| start + end);
        } else if c == '\'' || c == '"' {
            i += c.len_utf8();
            let mut closed = false;

            while i < source.len() {
                let next = source[i..].chars().next().unwrap();
                i += next.len_utf8();

                if next == '\\' && i < source.len() {
                    i += source[i..].chars().next().unwrap().len_utf8();
                } else if next == c {
                    closed = true;
                    break;
                }
            }

            if !closed {
                errors.push(Diagnostic::error(
                    "syntax.string",
                    "Unclosed string",
                    Range { start, end: i },
                ));
            }
        } else if c == '\\' {
            i += 1;
            if i < source.len() {
                i += source[i..].chars().next().unwrap().len_utf8();
            }
        } else if c.is_whitespace() {
            trivia = true;
            i += c.len_utf8();
        } else if "{}():;,[]".contains(c) {
            i += 1;
        } else {
            i += c.len_utf8();

            while i < source.len() {
                let next = source[i..].chars().next().unwrap();

                if in_value && source[i..].starts_with("://") {
                    i += 3;
                } else if next == '\\' {
                    i += 1;
                    if i < source.len() {
                        i += source[i..].chars().next().unwrap().len_utf8();
                    }
                } else if next.is_whitespace()
                    || "{}():;,[]\"'".contains(next)
                    || source[i..].starts_with("/*")
                {
                    break;
                } else {
                    i += next.len_utf8();
                }
            }
        }

        if !raw_value {
            match &source[start..i] {
                ":" => in_value = true,
                "(" | "[" => groups += 1,
                ")" | "]" => groups = groups.saturating_sub(1),
                "{" | "}" => {
                    in_value = false;
                    groups = 0;
                }
                ";" | "\n" | "\r" if groups == 0 => in_value = false,
                _ => {}
            }
        }

        tokens.push(Token {
            text: &source[start..i],
            start,
            trivia,
        });
    }

    (tokens, errors)
}

pub fn semantic_text(source: &str) -> String {
    let (tokens, _) = lex(source, true);
    tokens
        .iter()
        .map(|t| {
            if t.trivia && (t.text.starts_with("/*") || t.text.starts_with("//")) {
                " "
            } else {
                t.text
            }
        })
        .collect::<String>()
        .trim()
        .into()
}

struct Parser<'a> {
    tokens: Vec<Token<'a>>,
    index: usize,
    len: usize,
    builder: GreenNodeBuilder<'static>,
    diagnostics: Vec<Diagnostic>,
}

impl Parser<'_> {
    fn start(&mut self, kind: Kind) {
        self.builder.start_node(Liva::kind_to_raw(kind));
    }
    fn end(&mut self) {
        self.builder.finish_node();
    }
    fn at(&self) -> &str {
        self.tokens.get(self.index).map_or("", |t| t.text)
    }
    fn offset(&self) -> usize {
        self.tokens.get(self.index).map_or(self.len, |t| t.start)
    }
    fn bump(&mut self) {
        if let Some(t) = self.tokens.get(self.index) {
            self.builder.token(
                Liva::kind_to_raw(if t.trivia { Kind::Trivia } else { Kind::Text }),
                t.text,
            );
            self.index += 1;
        }
    }
    fn gap(&mut self) {
        while self.tokens.get(self.index).is_some_and(|t| t.trivia) {
            self.bump();
        }
    }
    fn error(&mut self, message: &str) {
        let start = self.offset();
        self.diagnostics.push(Diagnostic::error(
            "syntax.expected",
            message,
            Range {
                start,
                end: start + self.at().len(),
            },
        ));
    }

    fn items(&mut self, depth: usize, in_state: bool) {
        while self.index < self.tokens.len() {
            self.gap();
            if self.at().is_empty() || self.at() == "}" {
                break;
            }
            if self.at() == ";" {
                self.bump();
                continue;
            }

            if depth > 64 {
                self.error("Maximum block nesting exceeded");
                while !self.at().is_empty() {
                    self.bump();
                }
                return;
            }

            let checkpoint = self.builder.checkpoint();
            let begin = self.index;
            self.start(Kind::Header);

            while !self.at().is_empty() && !matches!(self.at(), "{" | "}" | ":" | ";" | "\n" | "\r")
            {
                self.bump();
            }
            self.end();

            if self.at() == ":" {
                self.builder
                    .start_node_at(checkpoint, Liva::kind_to_raw(Kind::Declaration));
                let name = self.tokens[begin..self.index]
                    .iter()
                    .map(|t| t.text)
                    .collect::<String>();
                if !is_property(semantic_text(&name).as_str()) {
                    self.error("Expected a property name");
                }
                self.bump();
                self.start(Kind::Value);
                self.raw(false, !in_state && semantic_text(&name) == "timing");
                self.end();
                self.end();
            } else if self.at() == "{" {
                self.builder
                    .start_node_at(checkpoint, Liva::kind_to_raw(Kind::Block));
                self.bump();
                let header = self.tokens[begin..self.index - 1]
                    .iter()
                    .map(|t| t.text)
                    .collect::<String>();
                self.items(
                    depth + 1,
                    in_state
                        || (depth == 1
                            && semantic_text(&header).split_whitespace().next() == Some("state")),
                );

                if self.at() == "}" {
                    self.bump();
                } else {
                    self.error("Expected closing brace");
                }
                self.end();
            } else {
                self.error("Expected a block or declaration");
                if self.index == begin {
                    self.bump();
                }
            }
        }
    }

    fn raw(&mut self, argument: bool, call: bool) {
        let mut stack = vec![];
        let mut first = true;

        while !self.at().is_empty() {
            let text = self.at();

            if text == "}" {
                break;
            }

            if stack.is_empty()
                && (text == "}"
                    || (!argument && matches!(text, ";" | "\n" | "\r"))
                    || (argument && matches!(text, "," | ")")))
            {
                break;
            }

            if call && first && !self.tokens[self.index].trivia {
                let next = self
                    .tokens
                    .iter()
                    .enumerate()
                    .skip(self.index + 1)
                    .find(|(_, t)| !t.trivia)
                    .map(|(i, _)| i);

                if next.is_some_and(|i| self.tokens[i].text == "(") {
                    self.call();
                    first = false;
                    continue;
                }
            }

            if !self.tokens[self.index].trivia {
                first = false;
            }

            match text {
                ";" if argument && stack.is_empty() => {
                    self.error("Arguments must be separated by commas, not semicolons")
                }
                "(" => stack.push(")"),
                "[" => stack.push("]"),
                ")" | "]" => {
                    if stack.pop() != Some(text) {
                        self.error("Mismatched delimiter");
                    }
                }
                "{" => {
                    self.error("Unexpected brace in value");
                }
                _ => {}
            }

            self.bump();
        }

        if !stack.is_empty() {
            self.error("Unclosed value group");
        }
    }

    fn call(&mut self) {
        self.start(Kind::Call);
        self.start(Kind::Header);
        self.bump();
        self.end();
        self.gap();
        self.bump();
        self.gap();

        while !matches!(self.at(), "" | ")" | "}") {
            let begin = self.index;
            self.start(Kind::Argument);
            self.start(Kind::Header);

            while !matches!(self.at(), "" | ":" | "," | ")" | "}") {
                self.bump();
            }
            self.end();

            if self.at() == ":" {
                self.bump();
                self.start(Kind::Value);
                self.raw(true, false);
                self.end();
            } else {
                self.error("Expected named argument and colon");
            }
            self.end();

            if self.at() == "," {
                self.bump();
                self.gap();
            } else if !matches!(self.at(), "" | ")" | "}") {
                self.error("Expected argument comma");
            }

            if self.index == begin {
                break;
            }
        }

        if self.at() == ")" {
            self.bump();
        } else {
            self.error("Expected closing parenthesis");
        }
        self.end();
    }
}

pub fn parse(source: &str) -> Parse {
    let (tokens, diagnostics) = lex(source, false);
    let mut p = Parser {
        tokens,
        index: 0,
        len: source.len(),
        builder: GreenNodeBuilder::new(),
        diagnostics,
    };
    p.start(Kind::Document);
    p.items(0, false);

    while !p.at().is_empty() {
        p.error("Unexpected closing brace");
        p.bump();
    }
    p.end();

    let root = Ast(SyntaxNode::new_root(p.builder.finish()));
    validate_headers(&root, 0, &mut p.diagnostics);

    Parse {
        root,
        diagnostics: p.diagnostics,
    }
}

fn validate_headers(node: &Ast, depth: usize, diagnostics: &mut Vec<Diagnostic>) {
    for block in node.children(Kind::Block) {
        let header = block.header().unwrap_or_default();
        let words: Vec<_> = header.split_whitespace().collect();
        let valid = match depth {
            0 | 2 => is_name(&header),
            1 => match words.as_slice() {
                ["state", name] => is_name(name),
                ["transition"] => true,
                ["transition", from, "->", to] => is_name(from) && is_name(to),
                _ => false,
            },
            3 => is_property(&header),
            4 => header.strip_suffix('%').is_some_and(|n| {
                !n.is_empty()
                    && n.bytes()
                        .all(|c| c.is_ascii_digit() || c == b'.' || c == b'-')
            }),
            _ => false,
        };

        if !valid {
            diagnostics.push(Diagnostic::error(
                "syntax.name",
                "Invalid block header or identifier",
                block.child(Kind::Header).unwrap().range(),
            ));
        }

        validate_headers(&block, depth + 1, diagnostics);
    }
}

pub fn contains_comments(source: &str) -> bool {
    lex(source, true)
        .0
        .iter()
        .any(|token| token.trivia && (token.text.starts_with("/*") || token.text.starts_with("//")))
}
