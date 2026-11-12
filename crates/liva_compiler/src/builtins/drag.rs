use super::{Field, Function, Parameter, Signature, Type};

pub const DRAG: Function = Function {
    name: "drag",
    signatures: &[Signature {
        parameters: &[Parameter {
            fixed: false,
            optional: false,
            name: "target",
            value_type: Type::Target,
        }],
        return_type: Type::Record(&[
            Field {
                name: "active",
                value_type: Type::Boolean,
            },
            Field {
                name: "released",
                value_type: Type::Boolean,
            },
            Field {
                name: "offset",
                value_type: Type::Record(&[
                    Field {
                        name: "x",
                        value_type: Type::Number,
                    },
                    Field {
                        name: "y",
                        value_type: Type::Number,
                    },
                ]),
            },
            Field {
                name: "release",
                value_type: Type::Event,
            },
        ]),
    }],
};
