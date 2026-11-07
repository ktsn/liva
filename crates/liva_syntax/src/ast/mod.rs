//! Typed views sharing the lossless syntax tree. Casts classify syntax;
//! semantic validity is checked separately so malformed input remains accessible.

pub mod expression;
mod structure;
pub use structure::*;

use crate::{Kind, Range, SyntaxNode};

pub trait AstNode: Sized {
    fn cast(node: SyntaxNode) -> Option<Self>;
    fn syntax(&self) -> &SyntaxNode;

    fn range(&self) -> Range {
        let range = self.syntax().text_range();
        Range {
            start: u32::from(range.start()) as usize,
            end: u32::from(range.end()) as usize,
        }
    }

    fn text(&self) -> String {
        self.syntax().text().to_string()
    }

    fn semantic_text(&self) -> String {
        fn append(node: &SyntaxNode, text: &mut String, interpolation: &mut bool) {
            for element in node.children_with_tokens() {
                match element {
                    rowan::NodeOrToken::Node(child) if child.kind() == Kind::Interpolation => {
                        text.push_str(&child.text().to_string())
                    }
                    rowan::NodeOrToken::Node(child) => append(&child, text, interpolation),
                    rowan::NodeOrToken::Token(token) => {
                        if token.text() == "${" {
                            *interpolation = true;
                        }
                        if !*interpolation
                            && token.kind() == Kind::Trivia
                            && (token.text().starts_with("/*") || token.text().starts_with("//"))
                        {
                            text.push(' ');
                        } else {
                            text.push_str(token.text());
                        }
                        if matches!(token.text(), "}" | "\n" | "\r") {
                            *interpolation = false;
                        }
                    }
                }
            }
        }

        let mut text = String::new();
        append(self.syntax(), &mut text, &mut false);
        text.trim().into()
    }

    fn children<N: AstNode>(&self) -> impl Iterator<Item = N> {
        self.syntax().children().filter_map(N::cast)
    }

    fn child<N: AstNode>(&self) -> Option<N> {
        self.children().next()
    }

    fn decorators(&self) -> impl Iterator<Item = Decorator> {
        self.syntax().children().flat_map(|child| {
            if let Some(decorator) = Decorator::cast(child.clone()) {
                return vec![decorator];
            }

            if !matches!(child.kind(), Kind::Header | Kind::Value) {
                return vec![];
            }

            child
                .children()
                .filter_map(Decorator::cast)
                .collect::<Vec<_>>()
        })
    }
}

impl AstNode for SyntaxNode {
    fn cast(node: SyntaxNode) -> Option<Self> {
        Some(node)
    }

    fn syntax(&self) -> &SyntaxNode {
        self
    }
}

pub trait HasHeader: AstNode {
    fn header_node(&self) -> Option<Header> {
        self.child()
    }

    fn header(&self) -> Option<String> {
        self.header_node().map(|node| without_decorator(&node))
    }
}

pub trait HasValue: AstNode {
    fn value_node(&self) -> Option<Value> {
        self.child()
    }

    fn value_text(&self) -> Option<String> {
        self.value_node().map(|node| without_decorator(&node))
    }
}

/// Exposes misplaced items too, so validators can report them instead of dropping them.
pub trait HasItems: AstNode {
    fn blocks(&self) -> impl Iterator<Item = Block> {
        self.children()
    }

    fn properties(&self) -> impl Iterator<Item = Property> {
        self.children()
    }

    fn bindings(&self) -> impl Iterator<Item = LetBinding> {
        self.children()
    }
}

fn without_decorator(node: &impl AstNode) -> String {
    if !node
        .syntax()
        .children()
        .any(|child| child.kind() == Kind::Decorator)
    {
        return node.semantic_text();
    }

    node.syntax()
        .children_with_tokens()
        .filter(|element| element.kind() != Kind::Decorator)
        .map(|element| match element {
            rowan::NodeOrToken::Node(child) => format!(" {} ", child.semantic_text()),
            rowan::NodeOrToken::Token(token)
                if token.kind() == Kind::Trivia
                    && (token.text().starts_with("/*") || token.text().starts_with("//")) =>
            {
                " ".into()
            }
            rowan::NodeOrToken::Token(token) => token.text().into(),
        })
        .collect::<String>()
        .trim()
        .into()
}
