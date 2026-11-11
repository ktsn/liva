use super::{Field, Function, Parameter, Signature, Type};

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
                    optional: false,
                    name: "input",
                    value_type: Type::Number,
                },
                Parameter {
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
                    optional: false,
                    name: "input",
                    value_type: Type::Number,
                },
                Parameter {
                    optional: false,
                    name: "component",
                    value_type: Type::String,
                },
                Parameter {
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
                    optional: false,
                    name: "input",
                    value_type: Type::Record(XY),
                },
                Parameter {
                    optional: true,
                    name: "sensitivity",
                    value_type: Type::Number,
                },
            ],
            return_type: Type::Controller(VECTOR),
        },
    ],
};
