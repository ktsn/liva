mod drag;

use crate::expression::{Argument, Scope, Type};
use std::collections::BTreeSet;

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

pub fn check_call(function: &str, arguments: &[Argument], scope: &Scope) -> Result<Type, String> {
    let signature = lookup(function)?;
    let mut seen = BTreeSet::new();

    for argument in arguments.iter() {
        if !seen.insert(argument.name.clone()) {
            return Err(format!("Duplicate argument: {}", argument.name));
        }

        let parameter = signature
            .parameters
            .iter()
            .find(|parameter| parameter.name == argument.name)
            .ok_or_else(|| format!("Unknown argument for {function}: {}", argument.name))?;

        let actual = crate::expression::check(&argument.value, scope)?;

        if actual != parameter.value_type {
            return Err(format!(
                "Invalid argument type for {function}.{}: expected {:?}, got {:?}",
                argument.name, parameter.value_type, actual
            ));
        }
    }

    for parameter in signature.parameters {
        if !seen.contains(parameter.name) {
            return Err(format!(
                "Missing argument for {function}: {}",
                parameter.name
            ));
        }
    }

    Ok(signature.return_type)
}
