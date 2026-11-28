//! Typed expression views; all children and ranges come from the underlying CST.

use super::{AstNode, HasHeader, HasValue};
use crate::{Kind, SyntaxNode};
use rowan::NodeOrToken;

#[derive(Debug, Clone)]
pub struct Expr(SyntaxNode);

#[derive(Debug, Clone)]
pub struct Name(SyntaxNode);

#[derive(Debug, Clone)]
pub struct Argument(SyntaxNode);

#[derive(Debug, Clone)]
pub enum ExprView {
    Number,
    Boolean,
    String,
    Reference,
    Call,
    Unary,
    Binary,
    Parenthesized,
    Object,
}

impl Expr {
    /// Whether this is a string expression with a lexical closing quote.
    /// Escape validity is checked separately by string_value; other expressions
    /// and unfinished strings return false.
    pub fn is_closed_string(&self) -> bool {
        matches!(self.view(), ExprView::String)
            && crate::literal::quoted_end(&self.text()).is_some()
    }

    pub fn string_value(&self) -> Result<String, String> {
        if !matches!(self.view(), ExprView::String) {
            return Err("Expected string expression".into());
        }

        crate::literal::string_value(&self.text())
    }

    pub fn view(&self) -> ExprView {
        match self.0.kind() {
            Kind::NumberExpr => ExprView::Number,
            Kind::BooleanExpr => ExprView::Boolean,
            Kind::StringExpr => ExprView::String,
            Kind::ReferenceExpr => ExprView::Reference,
            Kind::Call => ExprView::Call,
            Kind::UnaryExpr => ExprView::Unary,
            Kind::BinaryExpr => ExprView::Binary,
            Kind::ParenExpr => ExprView::Parenthesized,
            Kind::ObjectExpr => ExprView::Object,
            _ => unreachable!(),
        }
    }

    pub fn operands(&self) -> impl Iterator<Item = Expr> {
        self.0.children().filter_map(Self::cast)
    }

    pub fn operator(&self) -> Option<String> {
        self.0
            .children_with_tokens()
            .filter_map(NodeOrToken::into_token)
            .find(|token| token.kind() == Kind::Operator)
            .map(|token| token.text().to_owned())
    }

    pub fn names(&self) -> impl Iterator<Item = Name> {
        self.0
            .children()
            .filter(|node| node.kind() == Kind::Name)
            .map(Name)
    }

    pub fn function(&self) -> Option<Name> {
        header_name(&self.0)
    }

    pub fn properties(&self) -> impl Iterator<Item = Argument> {
        self.0
            .children()
            .filter(|node| node.kind() == Kind::ObjectProperty)
            .map(Argument)
    }

    pub fn arguments(&self) -> impl Iterator<Item = Argument> {
        self.0
            .children()
            .filter(|node| node.kind() == Kind::Argument)
            .map(Argument)
    }
}

fn header_name(node: &SyntaxNode) -> Option<Name> {
    node.children()
        .find(|node| node.kind() == Kind::Header)?
        .children()
        .find(|node| node.kind() == Kind::Name)
        .map(Name)
}

impl Argument {
    pub fn name(&self) -> Option<Name> {
        header_name(&self.0)
    }

    pub fn value(&self) -> Option<Expr> {
        self.0
            .children()
            .find(|node| node.kind() == Kind::Value)?
            .children()
            .find_map(Expr::cast)
    }
}

pub fn from_container(node: &impl AstNode) -> Option<Expr> {
    node.syntax().children().find_map(Expr::cast)
}

impl AstNode for Expr {
    fn cast(node: SyntaxNode) -> Option<Self> {
        matches!(
            node.kind(),
            Kind::NumberExpr
                | Kind::BooleanExpr
                | Kind::StringExpr
                | Kind::ReferenceExpr
                | Kind::Call
                | Kind::UnaryExpr
                | Kind::BinaryExpr
                | Kind::ParenExpr
                | Kind::ObjectExpr
        )
        .then_some(Self(node))
    }

    fn syntax(&self) -> &SyntaxNode {
        &self.0
    }
}

impl AstNode for Name {
    fn cast(node: SyntaxNode) -> Option<Self> {
        (node.kind() == Kind::Name).then_some(Self(node))
    }

    fn syntax(&self) -> &SyntaxNode {
        &self.0
    }
}

impl AstNode for Argument {
    fn cast(node: SyntaxNode) -> Option<Self> {
        matches!(node.kind(), Kind::Argument | Kind::ObjectProperty).then_some(Self(node))
    }

    fn syntax(&self) -> &SyntaxNode {
        &self.0
    }
}

impl HasHeader for Argument {}
impl HasValue for Argument {}
