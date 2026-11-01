use rowan::Language;

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
    Let,
    Parameters,
    Parameter,
    TypeReference,
    NumberExpr,
    BooleanExpr,
    StringExpr,
    ReferenceExpr,
    UnaryExpr,
    BinaryExpr,
    ParenExpr,
    Name,
    Operator,
    Condition,
    Interpolation,
    Event,
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
            10 => Kind::Let,
            11 => Kind::Parameters,
            12 => Kind::Parameter,
            13 => Kind::TypeReference,
            14 => Kind::NumberExpr,
            15 => Kind::BooleanExpr,
            16 => Kind::StringExpr,
            17 => Kind::ReferenceExpr,
            18 => Kind::UnaryExpr,
            19 => Kind::BinaryExpr,
            20 => Kind::ParenExpr,
            21 => Kind::Name,
            22 => Kind::Operator,
            23 => Kind::Condition,
            24 => Kind::Interpolation,
            25 => Kind::Event,
            _ => Kind::Error,
        }
    }

    fn kind_to_raw(kind: Kind) -> rowan::SyntaxKind {
        rowan::SyntaxKind(kind as u16)
    }
}

pub type SyntaxNode = rowan::SyntaxNode<Liva>;
