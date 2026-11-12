use super::{Field, Function, Parameter, Signature, Type};
use std::borrow::Cow;

pub const XY: &[Field] = &[
    Field {
        name: "x",
        value_type: Type::Number,
    },
    Field {
        name: "y",
        value_type: Type::Number,
    },
];
pub const XYZ: &[Field] = &[
    Field {
        name: "x",
        value_type: Type::Number,
    },
    Field {
        name: "y",
        value_type: Type::Number,
    },
    Field {
        name: "z",
        value_type: Type::Number,
    },
];
const SCALAR: &[Field] = &[
    Field {
        name: "value",
        value_type: Type::Number,
    },
    Field {
        name: "velocity",
        value_type: Type::Number,
    },
    Field {
        name: "attached",
        value_type: Type::Boolean,
    },
];
const VECTOR: &[Field] = &[
    Field {
        name: "value",
        value_type: Type::Record(XYZ),
    },
    Field {
        name: "velocity",
        value_type: Type::Record(XYZ),
    },
    Field {
        name: "attached",
        value_type: Type::Boolean,
    },
];

pub const LINK: Function = Function {
    name: "link",
    signatures: &[
        Signature {
            parameters: &[
                Parameter {
                    fixed: false,
                    optional: false,
                    name: "input",
                    value_type: Type::Number,
                },
                Parameter {
                    fixed: false,
                    optional: true,
                    name: "sensitivity",
                    value_type: Type::Number,
                },
            ],
            return_type: Type::Controller(SCALAR),
        },
        Signature {
            parameters: &[
                Parameter {
                    fixed: false,
                    optional: false,
                    name: "input",
                    value_type: Type::Number,
                },
                Parameter {
                    fixed: true,
                    optional: false,
                    name: "component",
                    value_type: Type::StringUnion(Cow::Borrowed(&[
                        Cow::Borrowed("x"),
                        Cow::Borrowed("y"),
                    ])),
                },
                Parameter {
                    fixed: false,
                    optional: true,
                    name: "sensitivity",
                    value_type: Type::Number,
                },
            ],
            return_type: Type::Controller(VECTOR),
        },
        Signature {
            parameters: &[
                Parameter {
                    fixed: false,
                    optional: false,
                    name: "input",
                    value_type: Type::Record(XY),
                },
                Parameter {
                    fixed: false,
                    optional: true,
                    name: "sensitivity",
                    value_type: Type::Number,
                },
            ],
            return_type: Type::Controller(VECTOR),
        },
    ],
};
