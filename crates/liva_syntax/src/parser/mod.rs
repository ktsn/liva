pub(crate) mod expression;
mod template;

use crate::ast::{
    AstNode, Block, Document, HasHeader, Layer, Motion, PropertyBlock, State, Target, Transition,
};
use crate::lexer::{Token, TokenKind, lex};
use crate::{Diagnostic, Kind, Liva, Parse, Range, SyntaxNode, is_name, is_property};
use rowan::{GreenNodeBuilder, Language};

struct Parser<'a> {
    tokens: Vec<Token<'a>>,
    index: usize,
    len: usize,
    builder: GreenNodeBuilder<'static>,
    diagnostics: Vec<Diagnostic>,
    lexical_diagnostics: Vec<Diagnostic>,
    expression_diagnostics: Vec<Diagnostic>,
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

            if self.at() == "event" {
                if depth != 1 {
                    self.error("Events must be declared directly inside a Motion");
                }
                self.start(Kind::Event);
                self.bump();

                while self
                    .tokens
                    .get(self.index)
                    .is_some_and(|token| token.trivia)
                    && !matches!(self.at(), "\n" | "\r")
                {
                    self.bump();
                }
                self.start(Kind::Header);

                while !matches!(self.at(), "" | "when" | "{" | "}" | ";" | "\n" | "\r") {
                    self.bump();
                }
                self.end();

                if self.at() == "when" {
                    self.bump();
                    self.start(Kind::Condition);
                    self.expression_region(true);
                    self.end();
                } else {
                    self.error("Expected event condition after when");
                }
                self.end();
                continue;
            }

            if self.at() == "let" {
                self.start(Kind::Let);
                self.bump();
                self.gap();
                self.start(Kind::Header);

                while !matches!(self.at(), "" | "=" | "{" | "}" | ";" | "\n" | "\r") {
                    self.bump();
                }
                self.end();

                if self.at() == "=" {
                    self.bump();
                    self.start(Kind::Value);
                    self.expression_region(false);
                    self.end();
                } else {
                    self.error("Expected let initializer after =");
                }
                self.end();
                continue;
            }

            let checkpoint = self.builder.checkpoint();
            let begin = self.index;
            self.start(Kind::Header);

            // Keep colons and newlines inside parentheses or brackets in the header
            // expression so a named argument's colon in a state condition is not mistaken
            // for a property declaration separator, with the preceding header as its name.
            let mut nesting_depth = 0usize;
            let mut header_words = 0;
            let mut guarded_transition = false;

            while !self.at().is_empty()
                && !matches!(self.at(), "{" | "}" | ";")
                && !(nesting_depth == 0 && matches!(self.at(), ":" | "\n" | "\r"))
            {
                if depth >= 2 && header_words > 0 && nesting_depth == 0 && self.at() == "@" {
                    self.decorator();
                    break;
                }

                if depth == 2
                    && self.tokens[begin].text == "transition"
                    && header_words == 4
                    && self.at() == "when"
                {
                    self.bump();
                    self.start(Kind::Condition);
                    self.expression_region(true);
                    self.end();
                    guarded_transition = true;
                    break;
                }

                if (depth == 1 || depth == 2)
                    && matches!(self.tokens[begin].text, "state" | "layer")
                    && header_words == 2
                    && self.at() == "when"
                {
                    self.bump();
                    self.start(Kind::Condition);
                    self.expression_region(true);
                    self.end();
                    break;
                }
                if !self.tokens[self.index].trivia {
                    header_words += 1;
                }

                if depth == 0 && self.tokens[begin].text == "motion" && self.at() == "(" {
                    self.parameters();
                } else {
                    match self.at() {
                        "(" | "[" => nesting_depth += 1,
                        ")" | "]" => nesting_depth = nesting_depth.saturating_sub(1),
                        _ => {}
                    }

                    self.bump();
                }
            }
            self.end();

            if guarded_transition && self.at() != "{" {
                self.builder
                    .start_node_at(checkpoint, Liva::kind_to_raw(Kind::Block));
                self.end();
                continue;
            }

            if self.at() == ":" {
                self.builder
                    .start_node_at(checkpoint, Liva::kind_to_raw(Kind::Declaration));
                let name = self.tokens[begin..self.index]
                    .iter()
                    .map(|t| {
                        if t.kind == TokenKind::Comment {
                            " "
                        } else {
                            t.text
                        }
                    })
                    .collect::<String>();
                if !(if in_state && depth < 4 {
                    is_property(name.trim())
                } else {
                    is_property(name.trim().trim_start_matches('@'))
                }) && ((in_state && depth < 4)
                    || !name
                        .trim()
                        .strip_suffix('%')
                        .is_some_and(|v| v.parse::<f64>().is_ok()))
                {
                    self.error("Expected a property name");
                }
                self.bump();
                self.start(Kind::Value);
                self.raw();
                self.end();
                self.end();
            } else if self.at() == "{" {
                self.builder
                    .start_node_at(checkpoint, Liva::kind_to_raw(Kind::Block));
                self.bump();
                let header = self.tokens[begin..self.index - 1]
                    .iter()
                    .map(|t| {
                        if t.kind == TokenKind::Comment {
                            " "
                        } else {
                            t.text
                        }
                    })
                    .collect::<String>();
                self.items(
                    depth + 1,
                    (in_state
                        && !(depth == 2 && header.split_whitespace().next() == Some("transition")))
                        || (depth == 1
                            && matches!(header.split_whitespace().next(), Some("state" | "layer"))),
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

    fn parameters(&mut self) {
        self.start(Kind::Parameters);
        self.bump();
        self.gap();

        while !matches!(self.at(), "" | ")" | "{" | "}") {
            self.start(Kind::Parameter);
            self.start(Kind::Header);

            while !matches!(self.at(), "" | ":" | "," | ")" | "{" | "}") {
                self.bump();
            }
            self.end();

            if self.at() == ":" {
                self.bump();
                self.start(Kind::TypeReference);

                while !matches!(self.at(), "" | "," | ")" | "{" | "}") {
                    self.bump();
                }
                self.end();
            } else {
                self.error("Expected parameter type annotation");
            }
            self.end();

            if self.at() != "," {
                break;
            }
            self.bump();
            self.gap();
        }

        if self.at() == ")" {
            self.bump();
        } else {
            self.error("Expected closing parameter parenthesis");
        }
        self.end();
    }

    fn decorator(&mut self) {
        self.start(Kind::Decorator);
        self.bump();
        let mut depth = 0usize;

        while !self.at().is_empty() {
            if matches!(self.at(), "{" | "}")
                || (depth == 0 && matches!(self.at(), ";" | "\n" | "\r"))
            {
                break;
            }

            match self.at() {
                "(" | "[" => depth += 1,
                ")" | "]" => depth = depth.saturating_sub(1),
                _ => {}
            }

            self.bump();
        }

        self.end();
    }

    fn raw(&mut self) {
        let mut stack = vec![];

        while !self.at().is_empty() {
            if stack.is_empty() && self.at() == "@" {
                self.decorator();
                break;
            }

            if self.at() == "${" {
                self.interpolation();
                continue;
            }
            if !self.tokens[self.index].parts.is_empty() {
                template::emit(
                    &self.tokens[self.index].parts,
                    &mut self.builder,
                    &mut self.expression_diagnostics,
                );
                self.index += 1;
                continue;
            }
            self.validate_url();
            let text = self.at();

            if text == "}" {
                break;
            }

            if stack.is_empty() && matches!(text, ";" | "\n" | "\r") {
                break;
            }

            match text {
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

    fn validate_url(&mut self) {
        let invalid = if self.at() == "://" {
            Some(self.index)
        } else if self.at().eq_ignore_ascii_case("url") {
            let mut following =
                (self.index + 1..self.tokens.len()).filter(|&index| !self.tokens[index].trivia);
            if let Some(open) = following
                .next()
                .filter(|&index| self.tokens[index].text == "(")
            {
                match following.next() {
                    Some(index) if self.tokens[index].kind == TokenKind::String => None,
                    Some(index) => Some(index),
                    None => Some(open),
                }
            } else {
                None
            }
        } else {
            None
        };

        if let Some(index) = invalid {
            self.diagnostics.push(Diagnostic::error(
                "syntax.url",
                "URLs must be enclosed in quotes",
                self.tokens[index].range.clone(),
            ));
        }
    }

    fn expression_region(&mut self, header: bool) {
        let begin = self.index;
        let mut stack = vec![];

        while !self.at().is_empty() {
            let text = self.at();
            if header && matches!(text, "\n" | "\r") && !stack.is_empty() {
                let mut next = self.tokens[self.index + 1..]
                    .iter()
                    .filter(|token| !token.trivia)
                    .map(|token| token.text);
                let declaration = match (next.next(), next.next(), next.next()) {
                    (Some("state"), Some(name), Some("{" | "when")) => is_name(name),
                    (Some("enter" | "leave" | "transition"), Some("{"), _) => true,
                    (Some("transition"), Some(name), Some("->")) => is_name(name),
                    (Some("event"), Some(name), Some("when")) => is_name(name),
                    (Some("let"), Some(name), Some("=")) => is_name(name),
                    _ => false,
                };

                if declaration {
                    break;
                }
            }

            if matches!(text, "\n" | "\r") && stack.is_empty() {
                let next = self.tokens[self.index + 1..]
                    .iter()
                    .find(|token| !token.trivia);
                if next.is_some_and(|token| matches!(token.text, "&&" | "||")) {
                    self.index += 1;
                    continue;
                }
            }
            if text == "}"
                || (header && matches!(text, "{" | ";"))
                || (stack.is_empty() && matches!(text, ";" | "\n" | "\r"))
                || (header && stack.is_empty() && text == ":")
            {
                break;
            }

            match text {
                "(" => stack.push(")"),
                "[" => stack.push("]"),
                ")" | "]" => {
                    if stack.pop() != Some(text) && !header {
                        self.error("Mismatched delimiter");
                    }
                }
                "{" if !header => self.error("Unexpected brace in value"),
                _ => {}
            }
            self.index += 1;
        }
        if !header && !stack.is_empty() {
            self.error("Unclosed value group");
        }

        expression::emit(
            &self.tokens[begin..self.index],
            self.offset(),
            &mut self.builder,
            &mut self.expression_diagnostics,
        );
    }

    fn interpolation(&mut self) {
        let begin = self.index;
        let start = self.offset();
        let mut end = begin + 1;
        while end < self.tokens.len() {
            template::split_boundary(&mut self.tokens, end);
            if matches!(self.tokens[end].text, "}" | "\n" | "\r") {
                break;
            }
            end += 1;
        }
        let closed = self.tokens.get(end).is_some_and(|token| token.text == "}");

        // Interpolation contents are diagnosed by the expression parser. Lexical
        // string/comment errors here would duplicate the enclosing recovery error.
        let offset = self.tokens.get(end).map_or(self.len, |token| token.start);
        self.lexical_diagnostics.retain(|diagnostic| {
            diagnostic.range.start < start || diagnostic.range.start >= offset
        });

        if !closed {
            let range = Range { start, end: offset };
            if !self
                .tokens
                .get(end.saturating_sub(1))
                .is_some_and(|token| token.text.ends_with('}'))
            {
                self.lexical_diagnostics.push(Diagnostic::error(
                    "syntax.interpolation",
                    "Unclosed interpolation",
                    range.clone(),
                ));
            }
            self.expression_diagnostics.push(Diagnostic::error(
                "syntax.expression",
                "Unclosed CSS interpolation",
                range,
            ));
            while self.index < end {
                self.bump();
            }
            return;
        }

        self.start(Kind::Interpolation);
        self.bump();
        expression::emit(
            &self.tokens[self.index..end],
            self.tokens[end].start,
            &mut self.builder,
            &mut self.expression_diagnostics,
        );
        self.index = end;
        self.bump();
        self.end();
    }
}

pub fn parse(source: &str) -> Parse {
    let (tokens, diagnostics) = lex(source);
    let mut p = Parser {
        tokens,
        index: 0,
        len: source.len(),
        builder: GreenNodeBuilder::new(),
        diagnostics: vec![],
        lexical_diagnostics: diagnostics,
        expression_diagnostics: vec![],
    };
    p.start(Kind::Document);
    p.items(0, false);

    while !p.at().is_empty() {
        p.error("Unexpected closing brace");
        p.bump();
    }
    p.end();

    let root = SyntaxNode::new_root(p.builder.finish());
    let root = Document::cast(root).unwrap();
    p.lexical_diagnostics
        .sort_by_key(|diagnostic| diagnostic.range.start);
    p.lexical_diagnostics.append(&mut p.diagnostics);
    p.lexical_diagnostics.append(&mut p.expression_diagnostics);
    p.diagnostics = p.lexical_diagnostics;
    validate_headers(&root, 0, &mut p.diagnostics);

    Parse {
        root,
        diagnostics: p.diagnostics,
    }
}

fn validate_headers(node: &impl AstNode, depth: usize, diagnostics: &mut Vec<Diagnostic>) {
    for block in node.children::<Block>() {
        let header = block.header().unwrap_or_default();
        let words: Vec<_> = header.split_whitespace().collect();
        let valid = if depth == 0 {
            Motion::cast(block.syntax().clone())
                .and_then(|motion| motion.name())
                .is_some()
        } else if Layer::cast(block.syntax().clone()).is_some() {
            match words.as_slice() {
                ["layer", name] => is_name(name),
                ["layer", name, "when", ..] => is_name(name) && words.len() > 3,
                _ => false,
            }
        } else if State::cast(block.syntax().clone()).is_some() {
            match words.as_slice() {
                ["state", name] => is_name(name),
                ["state", name, "initial"] => depth == 2 && is_name(name),
                ["state", name, "when", ..] => is_name(name) && words.len() > 3,
                _ => false,
            }
        } else if Transition::cast(block.syntax().clone()).is_some() {
            match words.as_slice() {
                ["transition"] | ["enter"] | ["leave"] => true,
                ["transition", from, "->", to] => is_name(from) && is_name(to),
                ["transition", from, "->", to, "when", ..] => {
                    depth == 2 && is_name(from) && is_name(to) && words.len() > 5
                }
                _ => false,
            }
        } else if Target::cast(block.syntax().clone()).is_some() {
            is_name(&header)
        } else if PropertyBlock::cast(block.syntax().clone()).is_some() {
            is_property(&header)
        } else {
            depth == 4
                && header.strip_suffix('%').is_some_and(|n| {
                    !n.is_empty()
                        && n.bytes()
                            .all(|c| c.is_ascii_digit() || c == b'.' || c == b'-')
                })
        };

        if !valid {
            diagnostics.push(Diagnostic::error(
                "syntax.name",
                "Invalid block header or identifier",
                block.header_node().unwrap().range(),
            ));
        }

        validate_headers(&block, depth + 1, diagnostics);
    }
}
