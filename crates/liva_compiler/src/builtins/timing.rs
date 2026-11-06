use super::{Function, Parameter, Type};

const fn optional(name: &'static str, value_type: Type) -> Parameter {
    Parameter {
        name,
        value_type,
        optional: true,
    }
}

const fn coordinate(name: &'static str) -> Parameter {
    Parameter {
        name,
        value_type: Type::Number,
        optional: false,
    }
}

pub const TWEEN: Function = Function {
    name: "tween",
    parameters: &[
        optional("duration", Type::Number),
        optional("easing", Type::Easing),
    ],
    return_type: Type::Timing,
};

pub const SPRING: Function = Function {
    name: "spring",
    parameters: &[
        optional("stiffness", Type::Number),
        optional("damping", Type::Number),
        optional("mass", Type::Number),
    ],
    return_type: Type::Timing,
};

pub const CUBIC_BEZIER: Function = Function {
    name: "cubicBezier",
    parameters: &[
        coordinate("x1"),
        coordinate("y1"),
        coordinate("x2"),
        coordinate("y2"),
    ],
    return_type: Type::Easing,
};
