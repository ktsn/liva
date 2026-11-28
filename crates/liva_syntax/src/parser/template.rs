use super::expression;
use crate::lexer::{Token, TokenKind};
use crate::{Diagnostic, Kind, Liva, Range};
use rowan::{GreenNodeBuilder, Language};

// A quoted template keeps its surrounding string text verbatim. Only embedded
// expressions are parsed; all ranges already refer to the original document.
pub(super) fn emit(
    tokens: &[Token<'_>],
    builder: &mut GreenNodeBuilder<'static>,
    diagnostics: &mut Vec<Diagnostic>,
) {
    let mut tokens = tokens.to_vec();
    let mut index = 0;

    while index < tokens.len() {
        let token = tokens[index].clone();
        if token.text != "${" {
            builder.token(Liva::kind_to_raw(Kind::Text), token.text);
            index += 1;
            continue;
        }

        let begin = index;
        index += 1;
        let mut objects = 0usize;
        while index < tokens.len() {
            split_boundary(&mut tokens, index);
            match tokens[index].text {
                "{" => objects += 1,
                "}" if objects > 0 => objects -= 1,
                "}" => break,
                _ => {}
            }
            index += 1;
        }
        if index == tokens.len() {
            diagnostics.push(Diagnostic::error(
                "syntax.expression",
                "Unclosed CSS interpolation",
                Range {
                    start: token.start,
                    end: tokens.last().unwrap().range.end,
                },
            ));
            for token in &tokens[begin..] {
                builder.token(Liva::kind_to_raw(Kind::Text), token.text);
            }
            return;
        }

        builder.start_node(Liva::kind_to_raw(Kind::Interpolation));
        builder.token(Liva::kind_to_raw(Kind::Text), "${");
        expression::emit(
            &tokens[begin + 1..index],
            tokens[index].start,
            builder,
            diagnostics,
        );
        builder.token(Liva::kind_to_raw(Kind::Text), "}");
        builder.finish_node();
        index += 1;
    }
}

// Interpolation recovery uses the original brace/newline boundary even when the
// common lexer grouped it into a comment. Keep the untouched suffix losslessly.
pub(super) fn split_boundary(tokens: &mut Vec<Token<'_>>, index: usize) {
    let token = &tokens[index];
    if token.kind != TokenKind::Comment {
        return;
    }
    let Some(relative) = token.text.find(['}', '\n', '\r']) else {
        return;
    };
    let mut fragments = vec![];
    if relative > 0 {
        let mut prefix = token.clone();
        prefix.text = &token.text[..relative];
        prefix.range.end = token.start + relative;
        fragments.push(prefix);
    }
    for (offset, c) in token.text[relative..].char_indices() {
        let start = token.start + relative + offset;
        let trivia = c.is_whitespace();
        fragments.push(Token {
            text: &token.text[relative + offset..relative + offset + c.len_utf8()],
            start,
            range: Range {
                start,
                end: start + c.len_utf8(),
            },
            kind: if trivia {
                TokenKind::Whitespace
            } else {
                TokenKind::Symbol
            },
            trivia,
            parts: vec![],
        });
    }
    tokens.splice(index..=index, fragments);
}
