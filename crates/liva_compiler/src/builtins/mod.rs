mod drag;
mod interaction;
mod measure;
mod timeout;
mod timing;

use crate::{expression::Type, scope::SymbolKind, target::ROOT_TARGET};

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Field {
    pub name: &'static str,
    pub value_type: Type,
}

#[derive(Debug)]
pub struct Parameter {
    pub optional: bool,
    pub name: &'static str,
    pub value_type: Type,
}

#[derive(Debug)]
pub struct Function {
    pub name: &'static str,
    pub signatures: &'static [Signature],
}

#[derive(Debug)]
pub struct Signature {
    pub parameters: &'static [Parameter],
    pub return_type: Type,
}

pub fn functions() -> impl Iterator<Item = &'static Function> {
    [
        &measure::MEASURE,
        &timeout::TIMEOUT,
        &drag::DRAG,
        &interaction::INTERACTION,
        &timing::TWEEN,
        &timing::SPRING,
        &timing::CUBIC_BEZIER,
        &timing::STEPS,
    ]
    .into_iter()
}

/// All names in the immutable parent environment; only the root is reserved.
pub fn symbols() -> impl Iterator<Item = (&'static str, SymbolKind, bool)> {
    std::iter::once((ROOT_TARGET, SymbolKind::Value(Type::Target), true))
        .chain(
            [
                "linear",
                "ease",
                "easeIn",
                "easeOut",
                "easeInOut",
                "stepStart",
                "stepEnd",
            ]
            .into_iter()
            .map(|name| (name, SymbolKind::Value(Type::Easing), false)),
        )
        .chain(std::iter::once((
            "instant",
            SymbolKind::Value(Type::Timing),
            false,
        )))
        .chain(functions().map(|function| (function.name, SymbolKind::Function(function), false)))
}
