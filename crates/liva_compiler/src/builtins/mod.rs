mod drag;
mod interaction;
mod link;
mod measure;
mod timeout;
mod timing;

use crate::{expression::Type, scope::SymbolKind, target::ROOT_TARGET};

#[derive(Debug, Clone, PartialEq)]
pub struct Field {
    pub name: &'static str,
    pub value_type: Type,
}

#[derive(Debug)]
pub struct Parameter {
    /// Requires one provable decoded string value in addition to type membership.
    /// This configuration proof is independent of whether every value is permitted.
    pub fixed: bool,
    pub optional: bool,
    pub name: &'static str,
    pub value_type: Type,
}

impl Parameter {
    /// Whether the source type satisfies both membership and configuration rules.
    pub fn accepts(&self, actual: &Type) -> bool {
        actual.is_assignable_to(&self.value_type)
            && (!self.fixed || actual.singleton_string().is_some())
    }
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
        &link::LINK,
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
