use crate::expression::Expression;
use crate::ir::{Property, PropertyTransition};

/// Compiler identity; the serialized IR continues to use target names.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum TargetId {
    Root,
    Named(String),
}

impl TargetId {
    pub(crate) fn from_name(name: String) -> Self {
        match name.as_str() {
            "self" => Self::Root,
            _ => Self::Named(name),
        }
    }

    pub(crate) fn name(&self) -> &str {
        match self {
            Self::Root => "self",
            Self::Named(name) => name,
        }
    }
}

/// Source provenance is independent of the destination target.
pub(crate) enum TargetOrigin {
    Implicit,
    Explicit,
}

impl TargetOrigin {
    pub(crate) fn mapping_kind(&self) -> &str {
        match self {
            Self::Implicit => "implicitTarget",
            Self::Explicit => "block",
        }
    }
}

pub(crate) trait TimedProperty {
    fn inherit_timing(&mut self, timing: &Option<Expression>);
}

impl TimedProperty for Property {
    fn inherit_timing(&mut self, timing: &Option<Expression>) {
        if self.timing_expression.is_none() {
            self.timing_expression = timing.clone();
        }
    }
}

impl TimedProperty for PropertyTransition {
    fn inherit_timing(&mut self, timing: &Option<Expression>) {
        if self.timing_expression.is_none() {
            self.timing_expression = timing.clone();
        }
    }
}
