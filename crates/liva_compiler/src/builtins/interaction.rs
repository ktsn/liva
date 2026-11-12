use super::{Field, Function, Parameter, Signature, Type};

pub const INTERACTION: Function = Function {
    name: "interaction",
    signatures: &[Signature {
        parameters: &[Parameter {
            fixed: false,
            optional: false,
            name: "target",
            value_type: Type::Target,
        }],
        return_type: Type::Record(&[
            Field {
                name: "hover",
                value_type: Type::Boolean,
            },
            Field {
                name: "active",
                value_type: Type::Boolean,
            },
            Field {
                name: "focus",
                value_type: Type::Boolean,
            },
            Field {
                name: "focusVisible",
                value_type: Type::Boolean,
            },
            Field {
                name: "focusWithin",
                value_type: Type::Boolean,
            },
        ]),
    }],
};
