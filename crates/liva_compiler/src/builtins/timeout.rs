use super::{Function, Parameter, Signature, Type};

pub const TIMEOUT: Function = Function {
    name: "timeout",
    signatures: &[Signature {
        parameters: &[
            Parameter {
                fixed: false,
                optional: false,
                name: "when",
                value_type: Type::Boolean,
            },
            Parameter {
                fixed: false,
                optional: false,
                name: "duration",
                value_type: Type::Number,
            },
        ],
        return_type: Type::Boolean,
    }],
};
