pub(crate) use liva_syntax::ast::significant_range;
use liva_syntax::ast::{AstNode, Header, Layer, Motion, State};
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

    if Motion::cast(node.syntax().clone()).is_some()
        || Layer::cast(node.syntax().clone()).is_some()
        || State::cast(node.syntax().clone()).is_some()
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
