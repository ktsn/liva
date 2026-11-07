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
