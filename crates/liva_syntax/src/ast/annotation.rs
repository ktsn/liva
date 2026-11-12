//! Parameter annotations are type syntax, independent of runtime expressions.
use super::{AstNode, TypeReference};
use crate::{Diagnostic, Kind, Range};

/// A named type or a nonempty list of decoded string choices, in source order.
/// Named types are resolved by the compiler; string duplicates are retained here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TypeAnnotation {
    Named(String),
    StringUnion(Vec<String>),
}

impl TypeReference {
    /// Decode a type name or quoted-string union, ignoring annotation trivia.
    /// Malformed syntax and unsupported escapes return a diagnostic at the offending
    /// token, or an empty range after the final token when a member is missing.
    pub fn annotation(&self) -> Result<TypeAnnotation, Diagnostic> {
        let tokens: Vec<_> = self
            .syntax()
            .children_with_tokens()
            .filter_map(|element| element.into_token())
            .filter(|token| token.kind() != Kind::Trivia)
            .collect();
        let token_range = |index: usize| {
            let range = tokens[index].text_range();

            Range {
                start: u32::from(range.start()) as usize,
                end: u32::from(range.end()) as usize,
            }
        };

        let error = |message: &str, range| Diagnostic::error("syntax.type", message, range);

        let Some(first) = tokens.first() else {
            let end = self.range().end;

            return Err(error("Expected parameter type", Range { start: end, end }));
        };

        if tokens.len() == 1 && crate::is_identifier(first.text()) {
            return Ok(TypeAnnotation::Named(first.text().into()));
        }

        let mut values = vec![];
        let mut index = 0;

        loop {
            let Some(member) = tokens.get(index) else {
                let end = token_range(index - 1).end;

                return Err(error(
                    "Expected quoted string union member",
                    Range { start: end, end },
                ));
            };

            if !member.text().starts_with(['\'', '"']) {
                return Err(error(
                    "Expected quoted string union member",
                    token_range(index),
                ));
            }

            let value = crate::literal::string_value(member.text())
                .map_err(|message| error(&message, token_range(index)))?;
            values.push(value);
            index += 1;

            if index == tokens.len() {
                return Ok(TypeAnnotation::StringUnion(values));
            }

            if tokens[index].text() != "|" {
                return Err(error(
                    "Expected | between quoted type members",
                    token_range(index),
                ));
            }

            index += 1;
        }
    }
}
