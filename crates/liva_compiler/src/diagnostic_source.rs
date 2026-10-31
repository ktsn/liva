use liva_syntax::ast::{AstNode, Header, Motion, State};
use liva_syntax::{Kind, Range};

pub(crate) fn header_range(node: &impl AstNode) -> Range {
    node.child::<Header>().map_or_else(
        || significant_range(node),
        |header| significant_range(&header),
    )
}

pub(crate) fn name_range(node: &impl AstNode) -> Range {
    let Some(header) = node.child::<Header>() else {
        return significant_range(node);
    };

    if Motion::cast(node.syntax().clone()).is_some() || State::cast(node.syntax().clone()).is_some()
    {
        return header
            .syntax()
            .children_with_tokens()
            .filter_map(|element| element.into_token())
            .filter(|token| token.kind() != Kind::Trivia)
            .nth(1)
            .map(|token| Range {
                start: u32::from(token.text_range().start()) as usize,
                end: u32::from(token.text_range().end()) as usize,
            })
            .unwrap_or_else(|| significant_range(&header));
    }

    significant_range(&header)
}

pub(crate) fn significant_range(node: &impl AstNode) -> Range {
    let tokens: Vec<_> = node
        .syntax()
        .descendants_with_tokens()
        .filter_map(|element| element.into_token())
        .filter(|token| token.kind() != Kind::Trivia)
        .collect();

    match (tokens.first(), tokens.last()) {
        (Some(first), Some(last)) => Range {
            start: u32::from(first.text_range().start()) as usize,
            end: u32::from(last.text_range().end()) as usize,
        },
        _ => Range {
            start: node.range().start,
            end: node.range().start,
        },
    }
}

/// Semantic text with byte origins, so removing comments never shifts diagnostics.
/// This is temporary compiler metadata, not part of the serialized IR.
pub(crate) struct SourceText {
    pub text: String,
    origins: Vec<Range>,
    empty: usize,
}

impl SourceText {
    pub fn new(node: &impl AstNode) -> Self {
        let mut text = String::new();
        let mut origins = Vec::new();
        let mut interpolation = false;

        for token in node
            .syntax()
            .descendants_with_tokens()
            .filter_map(|e| e.into_token())
        {
            let start = u32::from(token.text_range().start()) as usize;
            let end = u32::from(token.text_range().end()) as usize;
            let spelling = token.text();

            if spelling == "${" {
                interpolation = true;
            }

            let in_interpolation = token
                .parent_ancestors()
                .any(|n| n.kind() == Kind::Interpolation);
            if !interpolation
                && !in_interpolation
                && token.kind() == Kind::Trivia
                && (spelling.starts_with("/*") || spelling.starts_with("//"))
            {
                text.push(' ');
                origins.push(Range { start, end });
            } else {
                text.push_str(spelling);
                origins.extend((start..end).map(|start| Range {
                    start,
                    end: start + 1,
                }));
            }

            if matches!(spelling, "}" | "\n" | "\r") {
                interpolation = false;
            }
        }

        Self {
            text,
            origins,
            empty: node.range().start,
        }
    }

    /// Maps a slice borrowed from `self.text` back to the original source.
    pub fn range(&self, text: &str) -> Range {
        let start = text.as_ptr() as usize - self.text.as_ptr() as usize;
        let end = start + text.len();

        if text.is_empty() {
            let point = self.origins.get(start).map_or(
                self.origins.last().map_or(self.empty, |origin| origin.end),
                |origin| origin.start,
            );
            return Range {
                start: point,
                end: point,
            };
        }

        Range {
            start: self.origins[start].start,
            end: self.origins[end - 1].end,
        }
    }
}
