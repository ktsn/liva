use crate::expression::{Expression, TemplatePart};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Definition {
    pub name: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub let_bindings: Vec<LetBinding>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub parameters: Vec<MotionParameter>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub events: Vec<Event>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enter: Option<Transition>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub leave: Option<Transition>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub layers: Vec<Layer>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Event {
    pub name: String,
    pub when: Expression,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Layer {
    #[serde(rename = "timingExpression", skip_serializing_if = "Option::is_none")]
    pub timing_expression: Option<Expression>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub transitions: Vec<GuardedTransition>,
    pub name: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub states: Vec<State>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub initial_state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub when: Option<Expression>,
    pub targets: Vec<Target<Property>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GuardedTransition {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event: Option<Expression>,
    pub from: String,
    pub to: String,
    pub when: Expression,
    pub transition: Transition,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct State {
    #[serde(rename = "timingExpression", skip_serializing_if = "Option::is_none")]
    pub timing_expression: Option<Expression>,
    pub name: String,
    pub targets: Vec<Target<Property>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Target<T> {
    /// Restricts shared timing to declarations inside a merged explicit target block.
    #[serde(rename = "timingProperties", skip_serializing_if = "Option::is_none")]
    pub timing_properties: Option<Vec<String>>,
    #[serde(rename = "timingExpression", skip_serializing_if = "Option::is_none")]
    pub timing_expression: Option<Expression>,
    pub name: String,
    pub properties: Vec<T>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Property {
    #[serde(rename = "timingExpression", skip_serializing_if = "Option::is_none")]
    pub timing_expression: Option<Expression>,
    pub name: String,
    pub value: PropertyValue,
}

/// One CSS endpoint: opaque text or structured text/expression interpolation parts.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum CssValue {
    Literal { value: String },
    Template { parts: Vec<TemplatePart> },
}

/// Mutually exclusive declaration sources, with no duplicate raw template or endpoint text.
/// Keyframe arrays are sorted by offset and include a required 100% destination.
/// Frame values support only literal CSS and interpolation, excluding controllers and tracks.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum PropertyValue {
    Literal { value: String },
    Template { parts: Vec<TemplatePart> },
    Binding { expression: Expression },
    Keyframes { frames: Vec<Frame> },
}

impl From<CssValue> for PropertyValue {
    fn from(value: CssValue) -> Self {
        match value {
            CssValue::Literal { value } => Self::Literal { value },
            CssValue::Template { parts } => Self::Template { parts },
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Transition {
    #[serde(rename = "timingExpression", skip_serializing_if = "Option::is_none")]
    pub timing_expression: Option<Expression>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timing: Option<Timing>,
    pub targets: Vec<Target<PropertyTransition>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PropertyTransition {
    #[serde(rename = "timingExpression", skip_serializing_if = "Option::is_none")]
    pub timing_expression: Option<Expression>,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timing: Option<Timing>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub keyframes: Option<Vec<Frame>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Frame {
    #[serde(rename = "easingExpression", skip_serializing_if = "Option::is_none")]
    pub easing_expression: Option<Expression>,
    pub offset: f64,
    pub value: CssValue,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub easing: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind")]
pub enum Timing {
    #[serde(rename = "tween")]
    Tween {
        #[serde(rename = "durationMs")]
        duration_ms: f64,
        easing: String,
    },
    #[serde(rename = "spring-duration")]
    SpringDuration {
        #[serde(rename = "durationMs")]
        duration_ms: f64,
        bounce: f64,
    },
    #[serde(rename = "spring-physics")]
    SpringPhysics {
        stiffness: f64,
        damping: f64,
        mass: f64,
    },
}

impl Transition {
    pub fn property(&self, target: &str, property: &str) -> Option<&PropertyTransition> {
        self.targets
            .iter()
            .find(|t| t.name == target)?
            .properties
            .iter()
            .find(|p| p.name == property)
    }
}

impl State {
    /// Returns the authored declaration source, without evaluating expressions or tracks.
    pub fn value(&self, target: &str, property: &str) -> Option<&PropertyValue> {
        Some(
            &self
                .targets
                .iter()
                .find(|t| t.name == target)?
                .properties
                .iter()
                .find(|p| p.name == property)?
                .value,
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LetBinding {
    pub name: String,
    pub initializer: Expression,
}

impl LetBinding {
    pub fn name(&self) -> &str {
        &self.name
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MotionParameter {
    pub name: String,
    #[serde(rename = "type")]
    pub value_type: ParameterType,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum PrimitiveType {
    Number,
    Boolean,
    String,
}

/// Motion input descriptors retain primitive string encodings and add an explicit
/// finite-string descriptor, which older runtimes reject rather than silently widen.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum ParameterType {
    Primitive(PrimitiveType),
    Constrained(StringConstraint),
}

/// Decoded candidate sets. The compiler emits nonempty, sorted unique members;
/// runtime validation also accepts duplicate/reordered members as the same set.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum StringConstraint {
    StringUnion { values: Vec<String> },
}

impl ParameterType {
    /// Build an owned compile-time type from compiler-emitted parameter metadata.
    /// Candidate sets contain at least one unique decoded value; individual strings
    /// may be empty. Copying their data lets the scope own its type independently
    /// of the serialized output IR.
    pub(crate) fn expression_type(&self) -> crate::expression::Type {
        use crate::expression::Type;

        match self {
            Self::Primitive(PrimitiveType::Number) => Type::Number,
            Self::Primitive(PrimitiveType::Boolean) => Type::Boolean,
            Self::Primitive(PrimitiveType::String) => Type::String,
            Self::Constrained(StringConstraint::StringUnion { values }) => {
                if values.len() == 1 {
                    Type::StringLiteral(values[0].clone().into())
                } else {
                    Type::StringUnion(
                        values
                            .iter()
                            .cloned()
                            .map(Into::into)
                            .collect::<Vec<_>>()
                            .into(),
                    )
                }
            }
        }
    }
}
