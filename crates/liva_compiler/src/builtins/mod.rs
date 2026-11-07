mod drag;
mod interaction;
mod timing;

use crate::expression::Type;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Field {
    pub name: &'static str,
    pub value_type: Type,
}

pub struct Parameter {
    pub optional: bool,
    pub name: &'static str,
    pub value_type: Type,
}

pub struct Function {
    pub name: &'static str,
    pub signatures: &'static [Signature],
}

pub struct Signature {
    pub parameters: &'static [Parameter],
    pub return_type: Type,
}

pub fn functions() -> impl Iterator<Item = &'static Function> {
    [
        &drag::DRAG,
        &interaction::INTERACTION,
        &timing::TWEEN,
        &timing::SPRING,
        &timing::CUBIC_BEZIER,
        &timing::STEPS,
    ]
    .into_iter()
}

pub fn lookup(name: &str) -> Result<&'static Function, String> {
    functions()
        .find(|function| function.name == name)
        .ok_or_else(|| format!("Unknown function: {name}"))
}

pub fn constant_type(name: &str) -> Option<Type> {
    matches!(
        name,
        "linear" | "ease" | "easeIn" | "easeOut" | "easeInOut" | "stepStart" | "stepEnd"
    )
    .then_some(Type::Easing)
}
