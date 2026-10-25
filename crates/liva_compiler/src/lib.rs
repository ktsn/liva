pub mod ir;

use ir::*;
use liva_syntax::{Ast, Diagnostic, Kind, Range, parse, semantic_text};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Compilation {
    pub schema_version: u32,
    pub definitions: Vec<Definition>,
    pub diagnostics: Vec<Diagnostic>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mappings: Option<BTreeMap<String, Mapping>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Mapping {
    pub range: Range,
    pub kind: String,
}

struct Compiler {
    diagnostics: Vec<Diagnostic>,
    mappings: BTreeMap<String, Mapping>,
}

impl Compiler {
    fn error(&mut self, code: &str, message: impl Into<String>, node: &Ast) {
        self.diagnostics
            .push(Diagnostic::error(code, message, node.range()));
    }

    fn mapping(&mut self, path: &str, node: &Ast, kind: &str) {
        self.mappings.insert(
            path.into(),
            Mapping {
                range: node.range(),
                kind: kind.into(),
            },
        );
    }

    fn unique(&mut self, seen: &mut BTreeMap<String, Range>, name: &str, node: &Ast) {
        if let Some(previous) = seen.get(name) {
            let mut diagnostic = Diagnostic::error(
                "semantic.duplicate",
                format!("Duplicate declaration: {name}"),
                node.range(),
            );
            diagnostic.related.push(previous.clone());
            self.diagnostics.push(diagnostic);
        } else {
            seen.insert(name.into(), node.range());
        }
    }

    fn declarations(
        &mut self,
        node: &Ast,
        allowed: Option<&[&str]>,
        path: &str,
    ) -> BTreeMap<String, Ast> {
        let mut seen = BTreeMap::new();
        let mut declarations = BTreeMap::new();

        for declaration in node.children(Kind::Declaration) {
            let name = declaration.header().unwrap_or_default();
            self.unique(&mut seen, &name, &declaration);

            if allowed.is_some_and(|a| !a.contains(&name.as_str())) {
                self.error(
                    "semantic.declaration",
                    format!("Unknown declaration: {name}"),
                    &declaration,
                );
            }

            if let Some(value) = declaration.child(Kind::Value) {
                self.mapping(&format!("{path}/{name}"), &value, "value");
                if semantic_text(&value.text()).is_empty() {
                    self.error("semantic.value", "Value must not be empty", &value);
                }
            }

            declarations.insert(name, declaration);
        }

        declarations
    }

    fn timing(&mut self, declaration: &Ast, path: &str) -> Option<Timing> {
        let value = declaration.child(Kind::Value)?;
        let Some(call) = value.child(Kind::Call) else {
            self.error("semantic.timing", "Expected a named timing call", &value);
            return None;
        };
        let remainder = value
            .0
            .children_with_tokens()
            .filter(|n| n.as_node().is_none_or(|n| n.kind() != Kind::Call))
            .map(|n| n.to_string())
            .collect::<String>();
        if !semantic_text(&remainder).is_empty() {
            self.error(
                "semantic.timing",
                "Unexpected text after timing call",
                &value,
            );
        }

        let name = call.header().unwrap_or_default();
        let mut args = BTreeMap::new();
        let mut seen = BTreeMap::new();

        for argument in call.children(Kind::Argument) {
            let key = argument.header().unwrap_or_default();
            self.unique(&mut seen, &key, &argument);
            if let Some(value) = argument.child(Kind::Value) {
                self.mapping(&format!("{path}/{key}"), &value, "value");
            }
            args.insert(key, argument.value().unwrap_or_default());
        }

        let duration_mode = args.contains_key("duration") || args.contains_key("bounce");
        let allowed: &[&str] = match name.as_str() {
            "tween" => &["duration", "easing"],
            "spring" if duration_mode => &["duration", "bounce"],
            "spring" => &["stiffness", "damping", "mass"],
            _ => {
                self.error(
                    "semantic.timing",
                    format!("Unknown timing function: {name}"),
                    &call,
                );
                return None;
            }
        };

        for key in args.keys() {
            if !allowed.contains(&key.as_str()) {
                self.error(
                    "semantic.argument",
                    format!("Unknown or mixed timing argument: {key}"),
                    &call,
                );
            }
        }

        let mut number = |key: &str,
                          default: Option<f64>,
                          time: bool,
                          min: f64,
                          inclusive: bool|
         -> Option<f64> {
            let parsed = if let Some(raw) = args.get(key) {
                if time {
                    raw.strip_suffix("ms")
                        .and_then(|v| v.trim().parse::<f64>().ok())
                        .or_else(|| {
                            raw.strip_suffix('s')
                                .and_then(|v| v.trim().parse::<f64>().ok())
                                .map(|v| v * 1000.0)
                        })
                } else {
                    raw.parse::<f64>().ok()
                }
            } else {
                default
            };

            if let Some(n) =
                parsed.filter(|n| n.is_finite() && if inclusive { *n >= min } else { *n > min })
            {
                Some(n)
            } else {
                self.error(
                    "semantic.number",
                    format!(
                        "Invalid or missing {key}; expected {}. Check commas between arguments.",
                        if time {
                            "finite time with ms or s units"
                        } else {
                            "finite number in range"
                        }
                    ),
                    &call,
                );
                None
            }
        };

        match name.as_str() {
            "tween" => {
                let duration_ms = number("duration", None, true, 0.0, true)?;
                let easing = args
                    .get("easing")
                    .cloned()
                    .unwrap_or_else(|| "linear".into());
                if easing.is_empty() {
                    self.error(
                        "semantic.easing",
                        "Easing must be nonempty CSS text; check argument separators",
                        &call,
                    );
                }
                Some(Timing::Tween {
                    duration_ms,
                    easing,
                })
            }
            "spring" if duration_mode => {
                let duration_ms = number("duration", None, true, 0.0, false)?;
                let bounce = number("bounce", Some(0.0), false, 0.0, true)?;
                if bounce >= 1.0 {
                    self.error("semantic.bounce", "Bounce must be less than 1", &call);
                }
                Some(Timing::SpringDuration {
                    duration_ms,
                    bounce,
                })
            }
            _ => Some(Timing::SpringPhysics {
                stiffness: number("stiffness", None, false, 0.0, false)?,
                damping: number("damping", None, false, 0.0, false)?,
                mass: number("mass", Some(1.0), false, 0.0, false)?,
            }),
        }
    }

    fn transition(&mut self, node: &Ast, path: &str) -> Transition {
        self.mapping(path, node, "block");
        let declarations = self.declarations(node, Some(&["timing"]), path);
        let timing = declarations
            .get("timing")
            .and_then(|n| self.timing(n, &format!("{path}/timing")));
        let mut targets = vec![];
        let mut seen = BTreeMap::new();

        for target in node.children(Kind::Block) {
            let name = target.header().unwrap_or_default();
            self.unique(&mut seen, &name, &target);
            let target_path = format!("{path}/target/{name}");
            self.mapping(&target_path, &target, "block");
            self.declarations(&target, Some(&[]), &target_path);
            let mut properties = vec![];
            let mut property_names = BTreeMap::new();

            for property in target.children(Kind::Block) {
                let name = property.header().unwrap_or_default();
                self.unique(&mut property_names, &name, &property);
                let property_path = format!("{target_path}/property/{name}");
                self.mapping(&property_path, &property, "block");
                let declarations = self.declarations(&property, Some(&["timing"]), &property_path);
                let timing = declarations
                    .get("timing")
                    .and_then(|n| self.timing(n, &format!("{property_path}/timing")));
                let mut frames = vec![];
                let mut offsets = BTreeMap::new();

                for frame in property.children(Kind::Block) {
                    let raw = frame.header().unwrap_or_default();
                    let offset = raw
                        .strip_suffix('%')
                        .and_then(|v| v.parse::<f64>().ok())
                        .map(|v| v / 100.0);
                    let Some(offset) = offset.filter(|v| v.is_finite() && (0.0..=1.0).contains(v))
                    else {
                        self.error(
                            "semantic.offset",
                            "Frame offset must be between 0% and 100%",
                            &frame,
                        );
                        continue;
                    };
                    let offset = if offset == 0.0 { 0.0 } else { offset };
                    self.unique(&mut offsets, &offset.to_string(), &frame);
                    let frame_path = format!("{property_path}/frame/{offset}");
                    self.mapping(&frame_path, &frame, "block");
                    if let Some(header) = frame.child(Kind::Header) {
                        self.mapping(&format!("{frame_path}/offset"), &header, "value");
                    }
                    let fields = self.declarations(&frame, Some(&["value", "easing"]), &frame_path);
                    let value = fields.get("value").and_then(Ast::value).unwrap_or_else(|| {
                        self.error("semantic.frame", "Frame requires value", &frame);
                        String::new()
                    });
                    let easing = fields.get("easing").and_then(Ast::value);
                    frames.push(Frame {
                        offset,
                        value,
                        easing,
                    });
                }

                frames.sort_by(|a, b| a.offset.total_cmp(&b.offset));
                properties.push(PropertyTransition {
                    name,
                    timing,
                    keyframes: if frames.is_empty() {
                        None
                    } else {
                        Some(frames)
                    },
                });
            }

            targets.push(Target { name, properties });
        }

        Transition { timing, targets }
    }

    fn definition(&mut self, node: &Ast) -> Definition {
        let name = node.header().unwrap_or_default();
        self.mapping(&name, node, "block");
        self.declarations(node, Some(&[]), &name);
        let mut definition = Definition {
            name: name.clone(),
            states: vec![],
            general_transition: None,
            directional_transitions: vec![],
        };
        let mut states = BTreeMap::new();
        let mut transitions = BTreeMap::new();

        for child in node.children(Kind::Block) {
            let header = child.header().unwrap_or_default();
            let words: Vec<_> = header.split_whitespace().collect();

            match words.as_slice() {
                ["state", state_name] => {
                    self.unique(&mut states, state_name, &child);
                    let state_path = format!("{name}/state/{state_name}");
                    self.mapping(&state_path, &child, "block");
                    self.declarations(&child, Some(&[]), &state_path);
                    let mut targets = vec![];
                    let mut target_names = BTreeMap::new();

                    for target in child.children(Kind::Block) {
                        let target_name = target.header().unwrap_or_default();
                        self.unique(&mut target_names, &target_name, &target);
                        let target_path = format!("{state_path}/target/{target_name}");
                        self.mapping(&target_path, &target, "block");
                        self.declarations(&target, None, &target_path);
                        if target.children(Kind::Block).next().is_some() {
                            self.error(
                                "semantic.structure",
                                "State targets contain declarations only",
                                &target,
                            );
                        }
                        let properties = target
                            .children(Kind::Declaration)
                            .map(|p| Property {
                                name: p.header().unwrap_or_default(),
                                value: p.value().unwrap_or_default(),
                            })
                            .collect();
                        targets.push(Target {
                            name: target_name,
                            properties,
                        });
                    }

                    definition.states.push(State {
                        name: (*state_name).into(),
                        targets,
                    });
                }
                ["transition"] => {
                    self.unique(&mut transitions, "general", &child);
                    definition.general_transition =
                        Some(self.transition(&child, &format!("{name}/transition/general")));
                }
                ["transition", from, "->", to] => {
                    self.unique(&mut transitions, &format!("{from}/{to}"), &child);
                    definition
                        .directional_transitions
                        .push(DirectionalTransition {
                            from: (*from).into(),
                            to: (*to).into(),
                            transition: self.transition(
                                &child,
                                &format!("{name}/transition/directional/{from}/{to}"),
                            ),
                        });
                }
                _ => self.error("semantic.structure", "Expected state or transition", &child),
            }
        }

        self.validate(&definition, node);
        definition
    }

    fn validate(&mut self, def: &Definition, node: &Ast) {
        if def.states.is_empty() {
            self.error(
                "semantic.states",
                "Definition needs at least one state",
                node,
            );
        }
        let mut pairs = BTreeSet::new();

        for state in &def.states {
            for target in &state.targets {
                for property in &target.properties {
                    pairs.insert((target.name.as_str(), property.name.as_str()));
                }
            }
        }

        for transition in def
            .general_transition
            .iter()
            .chain(def.directional_transitions.iter().map(|t| &t.transition))
        {
            for target in &transition.targets {
                for property in &target.properties {
                    pairs.insert((target.name.as_str(), property.name.as_str()));
                }
            }
        }

        for direction in &def.directional_transitions {
            for name in [&direction.from, &direction.to] {
                if !def.states.iter().any(|s| &s.name == name) {
                    self.error("semantic.reference", format!("Unknown state: {name}"), node);
                }
            }
        }

        for state in &def.states {
            for (target, property) in &pairs {
                if state.value(target, property).is_none() {
                    self.error(
                        "semantic.completeness",
                        format!("MVP requires {target}.{property} in state {}", state.name),
                        node,
                    );
                }
            }
        }

        for from in &def.states {
            for to in &def.states {
                if from.name == to.name {
                    continue;
                }

                let general = def.general_transition.as_ref();
                let directional = def
                    .directional_transitions
                    .iter()
                    .find(|t| t.from == from.name && t.to == to.name)
                    .map(|t| &t.transition);

                for (target, property) in &pairs {
                    let gp = general.and_then(|t| t.property(target, property));
                    let dp = directional.and_then(|t| t.property(target, property));
                    let frames = dp
                        .and_then(|p| p.keyframes.as_ref())
                        .or_else(|| gp.and_then(|p| p.keyframes.as_ref()));
                    let timing = dp
                        .and_then(|p| p.timing.as_ref())
                        .or_else(|| gp.and_then(|p| p.timing.as_ref()))
                        .or_else(|| directional.and_then(|t| t.timing.as_ref()))
                        .or_else(|| general.and_then(|t| t.timing.as_ref()));

                    if from.value(target, property) == to.value(target, property)
                        && frames.is_none()
                    {
                        continue;
                    }
                    let Some(timing) = timing else {
                        self.error(
                            "semantic.timing-missing",
                            format!(
                                "Missing timing for {target}.{property}: {} -> {}",
                                from.name, to.name
                            ),
                            node,
                        );
                        continue;
                    };

                    if let Some(frames) = frames {
                        if !matches!(timing, Timing::Tween { .. })
                            && frames
                                .iter()
                                .any(|f| (f.offset > 0.0 && f.offset < 1.0) || f.easing.is_some())
                        {
                            self.error("semantic.spring-frames", format!("Spring {target}.{property} cannot have intermediate frames or frame easing: {} -> {}", from.name, to.name), node);
                        }

                        for frame in frames {
                            let endpoint = if frame.offset == 0.0 {
                                from.value(target, property)
                            } else if frame.offset == 1.0 {
                                to.value(target, property)
                            } else {
                                None
                            };
                            if endpoint.is_some_and(|v| v != frame.value)
                                || (frame.offset == 1.0 && frame.easing.is_some())
                            {
                                let mut warning = Diagnostic::error(
                                    "semantic.endpoint",
                                    format!(
                                        "{target}.{property}: explicit endpoint differs from state or final easing has no interval"
                                    ),
                                    node.range(),
                                );
                                warning.severity = "warning".into();
                                self.diagnostics.push(warning);
                            }
                        }
                    }
                }
            }
        }
    }
}

pub fn compile(source: &str, development: bool) -> Compilation {
    let parsed = parse(source);
    let mut compiler = Compiler {
        diagnostics: parsed.diagnostics,
        mappings: BTreeMap::new(),
    };
    let mut definitions = vec![];
    let mut seen = BTreeMap::new();
    let mut duplicates = BTreeSet::new();
    compiler.declarations(&parsed.root, Some(&[]), "");

    for node in parsed.root.children(Kind::Block) {
        let name = node.header().unwrap_or_default();
        if seen.contains_key(&name) {
            duplicates.insert(name.clone());
        }
        compiler.unique(&mut seen, &name, &node);
        let before = compiler.diagnostics.len();
        let definition = compiler.definition(&node);
        let range = node.range();
        let syntax_error = compiler.diagnostics[..before].iter().any(|d| {
            d.severity == "error" && d.range.start >= range.start && d.range.start <= range.end
        });
        let semantic_error = compiler.diagnostics[before..]
            .iter()
            .any(|d| d.severity == "error");

        if !syntax_error && !semantic_error {
            definitions.push(definition);
        }
    }

    definitions.retain(|d| !duplicates.contains(&d.name));
    Compilation {
        schema_version: 1,
        definitions,
        diagnostics: compiler.diagnostics,
        mappings: development.then_some(compiler.mappings),
    }
}
