use super::{Function, Parameter, Signature, Type};

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
    signatures: &[Signature {
        parameters: &[
            optional("duration", Type::Number),
            optional("easing", Type::Easing),
        ],
        return_type: Type::Timing,
    }],
};

pub const SPRING: Function = Function {
    name: "spring",
    signatures: &[
        Signature {
            parameters: &[coordinate("duration"), optional("bounce", Type::Number)],
            return_type: Type::Timing,
        },
        Signature {
            parameters: &[
                optional("stiffness", Type::Number),
                optional("damping", Type::Number),
                optional("mass", Type::Number),
            ],
            return_type: Type::Timing,
        },
    ],
};

pub const CUBIC_BEZIER: Function = Function {
    name: "cubicBezier",
    signatures: &[Signature {
        parameters: &[
            coordinate("x1"),
            coordinate("y1"),
            coordinate("x2"),
            coordinate("y2"),
        ],
        return_type: Type::Easing,
    }],
};

pub const STEPS: Function = Function {
    name: "steps",
    signatures: &[Signature {
        parameters: &[coordinate("count"), optional("position", Type::String)],
        return_type: Type::Easing,
    }],
};
