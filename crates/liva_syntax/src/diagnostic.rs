use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Range {
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Diagnostic {
    pub code: String,
    pub severity: String,
    pub message: String,
    pub range: Range,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub related: Vec<Range>,
}

impl Diagnostic {
    pub fn error(code: &str, message: impl Into<String>, range: Range) -> Self {
        Self {
            code: code.into(),
            severity: "error".into(),
            message: message.into(),
            range,
            related: vec![],
        }
    }
}
