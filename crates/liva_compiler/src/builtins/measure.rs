use super::{Field, Function, Parameter, Signature, Type};

pub const MEASURE: Function = Function {
    name: "measure",
    signatures: &[Signature {
        parameters: &[
            Parameter {
                fixed: false,
                optional: false,
                name: "target",
                value_type: Type::Target,
            },
            Parameter {
                fixed: false,
                optional: true,
                name: "relativeTo",
                value_type: Type::Target,
            },
        ],
        return_type: Type::Record(&[
            Field {
                name: "x",
                value_type: Type::Number,
            },
            Field {
                name: "y",
                value_type: Type::Number,
            },
            Field {
                name: "width",
                value_type: Type::Number,
            },
            Field {
                name: "height",
                value_type: Type::Number,
            },
            Field {
                name: "attached",
                value_type: Type::Boolean,
            },
        ]),
    }],
};
