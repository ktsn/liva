pub mod ast;
mod diagnostic;
mod kind;
mod lexer;
mod literal;
mod parser;

pub use diagnostic::{Diagnostic, Range};
pub use kind::{Kind, Liva, SyntaxNode};
pub use lexer::{contains_comments, is_identifier, is_name, is_property, semantic_text};
pub use literal::quote_string;
pub use parser::{expression::parse as parse_expression, parse};

pub struct Parse<N = ast::Document> {
    pub root: N,
    pub diagnostics: Vec<Diagnostic>,
}
