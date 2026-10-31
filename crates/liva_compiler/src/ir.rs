use crate::expression::{Expression, TemplatePart};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Definition {
    pub name: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sources: Vec<Source>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub parameters: Vec<MotionParameter>,
    pub states: Vec<State>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub general_transition: Option<Transition>,
    pub directional_transitions: Vec<DirectionalTransition>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct State {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub when: Option<Expression>,
    pub targets: Vec<Target<Property>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Target<T> {
    pub name: String,
    pub properties: Vec<T>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Property {
    pub name: String,
    pub value: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub template: Option<Vec<TemplatePart>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Transition {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timing: Option<Timing>,
    pub targets: Vec<Target<PropertyTransition>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DirectionalTransition {
    pub from: String,
    pub to: String,
    pub transition: Transition,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PropertyTransition {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timing: Option<Timing>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub keyframes: Option<Vec<Frame>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Frame {
    pub offset: f64,
    pub value: String,
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
    pub fn value(&self, target: &str, property: &str) -> Option<&str> {
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
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Source {
    Drag { name: String, target: String },
}

impl Source {
    pub fn name(&self) -> &str {
        match self {
            Self::Drag { name, .. } => name,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MotionParameter {
    pub name: String,
    #[serde(rename = "type")]
    pub value_type: PrimitiveType,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum PrimitiveType {
    Number,
    Boolean,
    String,
}
