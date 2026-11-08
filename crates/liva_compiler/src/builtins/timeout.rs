use super::{Function, Parameter, Signature, Type};

pub const TIMEOUT: Function = Function {
    name: "timeout",
    signatures: &[Signature {
        parameters: &[
            Parameter {
                optional: false,
                name: "when",
                value_type: Type::Boolean,
            },
            Parameter {
                optional: false,
                name: "duration",
                value_type: Type::Number,
            },
        ],
        return_type: Type::Boolean,
    }],
};
