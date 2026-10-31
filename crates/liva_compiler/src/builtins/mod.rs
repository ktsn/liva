mod drag;

use crate::expression::Type;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Field {
    pub name: &'static str,
    pub value_type: Type,
}

pub struct Parameter {
    pub name: &'static str,
    pub value_type: Type,
}

pub struct Function {
    pub name: &'static str,
    pub parameters: &'static [Parameter],
    pub return_type: Type,
}

pub fn lookup(name: &str) -> Result<&'static Function, String> {
    [&drag::DRAG]
        .into_iter()
        .find(|function| function.name == name)
        .ok_or_else(|| format!("Unknown function: {name}"))
}
