pub(crate) const ROOT_TARGET: &str = "self";

/// Compiler identity; the serialized IR continues to use target names.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum TargetId {
    Root,
    Named(String),
}

impl TargetId {
    pub(crate) fn from_name(name: String) -> Self {
        match name.as_str() {
            ROOT_TARGET => Self::Root,
            _ => Self::Named(name),
        }
    }

    pub(crate) fn name(&self) -> &str {
        match self {
            Self::Root => ROOT_TARGET,
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

/// Block defaults are lowered to properties when several source blocks share a target.
/// This preserves the existing unique-target IR without creating a cascade layer.
pub(crate) trait TimedProperty {
    fn name(&self) -> &str;
    fn inherit_timing(&mut self, timing: Option<&crate::expression::Expression>) -> bool;
}

impl TimedProperty for crate::ir::Declaration {
    fn name(&self) -> &str {
        self.name()
    }
    fn inherit_timing(&mut self, timing: Option<&crate::expression::Expression>) -> bool {
        let slot = match self {
            Self::Css(property) => &mut property.timing_expression,
            Self::Layout(property) => &mut property.timing_expression,
        };
        if slot.is_none() && timing.is_some() {
            *slot = timing.cloned();
            true
        } else {
            false
        }
    }
}

impl TimedProperty for crate::ir::PropertyTransition {
    fn name(&self) -> &str {
        &self.name
    }
    fn inherit_timing(&mut self, timing: Option<&crate::expression::Expression>) -> bool {
        if self.timing_expression.is_none() && timing.is_some() {
            self.timing_expression = timing.cloned();
            true
        } else {
            false
        }
    }
}
