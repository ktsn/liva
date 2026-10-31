pub mod builtins;
pub mod edits;
pub mod expression;
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
    fn parameters(&mut self, node: &Ast) -> Vec<MotionParameter> {
        let mut parameters = vec![];
        let mut seen = BTreeMap::new();

        for parameter in node.parameters() {
            let name = parameter.header().unwrap_or_default();
            self.unique(&mut seen, &name, &parameter);

            if !expression::identifier(&name) || matches!(name.as_str(), "true" | "false") {
                self.error(
                    "semantic.parameter",
                    "Invalid parameter identifier",
                    &parameter,
                );
            }

            let reference = parameter.child(Kind::TypeReference);
            let value_type = match reference
                .as_ref()
                .map(|n| semantic_text(&n.text()))
                .as_deref()
            {
                Some("number") => PrimitiveType::Number,
                Some("boolean") => PrimitiveType::Boolean,
                Some("string") => PrimitiveType::String,
                _ => {
                    self.error(
                        "semantic.type",
                        "Expected primitive type number, boolean, or string",
                        reference.as_ref().unwrap_or(&parameter),
                    );
                    continue;
                }
            };

            parameters.push(MotionParameter { name, value_type });
        }

        parameters
    }

    fn let_bindings(&mut self, node: &Ast) -> Vec<LetBinding> {
        let mut bindings = vec![];
        let mut seen = BTreeMap::new();

        for binding in node.children(Kind::Let) {
            let name = binding.header().unwrap_or_default();
            self.unique(&mut seen, &name, &binding);

            if !expression::identifier(&name) || matches!(name.as_str(), "true" | "false") {
                self.error("semantic.binding", "Invalid let identifier", &binding);
            }

            let result = expression::parse(&binding.value().unwrap_or_default());

            match result {
                Ok(initializer) => bindings.push(LetBinding { name, initializer }),
                Err(message) => self.error("semantic.expression", message, &binding),
            }
        }

        bindings
    }

    fn css_template(
        &mut self,
        node: &Ast,
        scope: &expression::Scope,
    ) -> Option<Vec<expression::TemplatePart>> {
        let value = node.value().unwrap_or_default();
        if !value.contains("${") {
            return None;
        }
        match expression::template(&value).and_then(|parts| {
            for part in &parts {
                if let expression::TemplatePart::Expression(expr) = part
                    && !expression::check(expr, scope)?.is_scalar()
                {
                    return Err("CSS templates require scalar values".into());
                }
            }
            Ok(parts)
        }) {
            Ok(parts) => Some(parts),
            Err(message) => {
                self.error("semantic.expression", message, node);
                None
            }
        }
    }

    fn animation_declarations(&mut self, node: &Ast, path: &str) -> Option<Timing> {
        let mut family = String::new();
        let mut args: BTreeMap<String, String> = BTreeMap::new();
        let mut call_timing = None;

        for binding in node.children(Kind::Let) {
            self.error(
                "semantic.structure",
                "Let declarations belong directly to a motion",
                &binding,
            );
        }

        for declaration in node.children(Kind::Declaration) {
            let name = declaration.header().unwrap_or_default();
            if name.ends_with('%') {
                if !path.contains("/property/") {
                    self.error(
                        "semantic.structure",
                        "Keyframes belong to property tracks",
                        &declaration,
                    );
                }
                continue;
            }
            if name == "timing" {
                family.clear();
                args.clear();
                self.mapping(
                    &format!("{path}/timing"),
                    &declaration.child(Kind::Value).unwrap(),
                    "value",
                );
                call_timing = self.timing(&declaration, &format!("{path}/timing"));
                continue;
            }
            let value = declaration.value().unwrap_or_default();
            let (next_family, field) = if name == "@tween" {
                ("tween", None)
            } else if name == "@spring" {
                ("spring", None)
            } else if let Some(field) = name.strip_prefix("@tween-") {
                ("tween", Some(field))
            } else if let Some(field) = name.strip_prefix("@spring-") {
                ("spring", Some(field))
            } else {
                self.error(
                    "semantic.declaration",
                    format!("Unknown animation declaration: {name}"),
                    &declaration,
                );
                continue;
            };

            if family != next_family || field.is_none() {
                args.clear();
            }
            family = next_family.into();
            call_timing = None;

            if let Some(field) = field {
                let allowed = if family == "tween" {
                    &["duration", "easing"][..]
                } else {
                    &["duration", "bounce", "stiffness", "damping", "mass"][..]
                };
                if !allowed.contains(&field) {
                    self.error(
                        "semantic.declaration",
                        format!("Unknown animation declaration: {name}"),
                        &declaration,
                    );
                    continue;
                }
                args.insert(field.into(), value);
                self.mapping(
                    &format!("{path}/timing/{field}"),
                    &declaration.child(Kind::Value).unwrap(),
                    "value",
                );
            } else if family == "tween" {
                let split = value.find(char::is_whitespace).unwrap_or(value.len());
                args.insert("duration".into(), value[..split].into());
                args.insert(
                    "easing".into(),
                    if value[split..].trim().is_empty() {
                        "linear".into()
                    } else {
                        value[split..].trim().into()
                    },
                );
            } else {
                let values: Vec<_> = value.split_whitespace().collect();
                let duration = values.first().is_some_and(|v| v.ends_with('s'));
                let fields = if duration {
                    &["duration", "bounce"][..]
                } else {
                    &["stiffness", "damping", "mass"][..]
                };
                if values.is_empty() || values.len() > fields.len() {
                    self.error("semantic.timing", "Invalid spring shorthand", &declaration);
                }
                for (field, value) in fields.iter().zip(values) {
                    args.insert((*field).into(), value.into());
                }
            }
        }

        if family.is_empty() {
            return call_timing;
        }
        let text = format!(
            "motion a {{ transition {{ timing: {family}({}) }} }}",
            args.iter()
                .map(|(k, v)| format!("{k}: {v}"))
                .collect::<Vec<_>>()
                .join(", ")
        );
        let parsed = parse(&text);
        let declaration = parsed
            .root
            .child(Kind::Block)?
            .child(Kind::Block)?
            .child(Kind::Declaration)?;
        let mut validator = Compiler {
            diagnostics: parsed.diagnostics,
            mappings: BTreeMap::new(),
        };
        let timing = validator.timing(&declaration, "");
        for diagnostic in validator.diagnostics {
            self.error(&diagnostic.code, diagnostic.message, node);
        }
        timing
    }

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

        if path.is_empty() || path.contains('/') {
            for binding in node.children(Kind::Let) {
                self.error(
                    "semantic.structure",
                    "Let declarations belong directly to a motion",
                    &binding,
                );
            }
        }

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
        let timing = self.animation_declarations(node, path);
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
                let timing = self.animation_declarations(&property, &property_path);
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

                for frame in property
                    .children(Kind::Declaration)
                    .filter(|n| n.header().is_some_and(|h| h.ends_with('%')))
                {
                    let raw = frame.header().unwrap();
                    let offset =
                        raw.trim_end_matches('%').parse::<f64>().unwrap_or(f64::NAN) / 100.0;
                    if !offset.is_finite() || !(0.0..=1.0).contains(&offset) {
                        self.error(
                            "semantic.offset",
                            "Frame offset must be between 0% and 100%",
                            &frame,
                        );
                        continue;
                    }
                    self.unique(&mut offsets, &offset.to_string(), &frame);
                    let frame_path = format!("{property_path}/frame/{offset}");
                    self.mapping(&frame_path, &frame, "block");
                    self.mapping(
                        &format!("{frame_path}/offset"),
                        &frame.child(Kind::Header).unwrap(),
                        "value",
                    );
                    let raw = frame.value().unwrap_or_default();
                    let (value, easing) = split_frame(&raw);
                    if value.is_empty() || easing.is_some_and(str::is_empty) {
                        self.error(
                            "semantic.frame",
                            "Frame requires a value and nonempty easing",
                            &frame,
                        );
                    }
                    let value_node = frame.child(Kind::Value).unwrap();
                    let text = value_node.text();
                    let leading = text.len() - text.trim_start().len();
                    let base = value_node.range().start + leading;
                    self.mappings.insert(
                        format!("{frame_path}/value"),
                        Mapping {
                            range: Range {
                                start: base,
                                end: base + value.len(),
                            },
                            kind: "value".into(),
                        },
                    );
                    if let Some(easing) = easing {
                        let end = value_node.range().end - (text.len() - text.trim_end().len());
                        self.mappings.insert(
                            format!("{frame_path}/easing"),
                            Mapping {
                                range: Range {
                                    start: end - easing.len(),
                                    end,
                                },
                                kind: "value".into(),
                            },
                        );
                    }
                    if liva_syntax::contains_comments(&text) {
                        self.mapping(&format!("{frame_path}/value"), &value_node, "value");
                        if easing.is_some() {
                            self.mapping(&format!("{frame_path}/easing"), &value_node, "value");
                        }
                    }
                    frames.push(Frame {
                        offset,
                        value: value.into(),
                        easing: easing.map(str::to_string),
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

    fn motion_scope(&mut self, node: &Ast, definition: &Definition) -> expression::Scope {
        use expression::Type;
        let mut scope = expression::Scope::new();

        for parameter in &definition.parameters {
            let value_type = match parameter.value_type {
                PrimitiveType::Number => Type::Number,
                PrimitiveType::Boolean => Type::Boolean,
                PrimitiveType::String => Type::String,
            };
            scope.insert(parameter.name.clone(), value_type);
        }

        let mut targets = BTreeMap::new();

        for state in node.children(Kind::Block).filter(|block| {
            block
                .header()
                .is_some_and(|header| header.split_whitespace().next() == Some("state"))
        }) {
            for target in state.children(Kind::Block) {
                targets
                    .entry(target.header().unwrap_or_default())
                    .or_insert(target);
            }
        }

        for (name, target) in targets {
            if !expression::identifier(&name) || matches!(name.as_str(), "true" | "false") {
                self.error(
                    "semantic.variable",
                    "Target variables require expression identifiers",
                    &target,
                );
            }

            if scope.insert(name.clone(), Type::Target).is_some() {
                self.error(
                    "semantic.duplicate",
                    format!("Duplicate variable: {name}"),
                    &target,
                );
            }
        }

        for binding in &definition.let_bindings {
            if scope.contains_key(&binding.name) {
                self.error(
                    "semantic.duplicate",
                    format!("Duplicate variable: {}", binding.name),
                    node,
                );
            }
        }

        let initial_scope = scope.clone();

        for syntax in node.children(Kind::Let) {
            if let Some(binding) = definition
                .let_bindings
                .iter()
                .find(|binding| Some(&binding.name) == syntax.header().as_ref())
            {
                if initial_scope.contains_key(&binding.name) {
                    continue;
                }

                if let Err(message) = infer_let_type(
                    &binding.name,
                    &definition.let_bindings,
                    &mut scope,
                    &mut BTreeSet::new(),
                ) {
                    self.error("semantic.expression", message, &syntax);
                }
            }
        }

        scope
    }

    fn definition(&mut self, node: &Ast) -> Definition {
        let name = node.motion_name().unwrap_or_default();
        self.mapping(&name, node, "block");
        self.declarations(node, Some(&[]), &name);
        let mut definition = Definition {
            name: name.clone(),
            let_bindings: self.let_bindings(node),
            parameters: self.parameters(node),
            states: vec![],
            general_transition: None,
            directional_transitions: vec![],
        };
        let scope = self.motion_scope(node, &definition);

        let mut states = BTreeMap::new();
        let mut transitions = BTreeMap::new();

        for child in node.children(Kind::Block) {
            let header = child.header().unwrap_or_default();
            let words: Vec<_> = header.split_whitespace().collect();

            match words.as_slice() {
                ["state", state_name, ..] => {
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
                                template: self.css_template(&p, &scope),
                                value: p.value().unwrap_or_default(),
                            })
                            .collect();
                        targets.push(Target {
                            name: target_name,
                            properties,
                        });
                    }

                    let when = header
                        .strip_prefix("state")
                        .and_then(|text| text.trim_start().strip_prefix(state_name))
                        .and_then(|text| text.trim_start().strip_prefix("when"))
                        .and_then(|text| {
                            match expression::parse(text).and_then(|expr| {
                                if expression::check(&expr, &scope)? != expression::Type::Boolean {
                                    return Err("State condition must be Boolean".into());
                                }
                                Ok(expr)
                            }) {
                                Ok(expr) => Some(expr),
                                Err(message) => {
                                    self.error("semantic.expression", message, &child);
                                    None
                                }
                            }
                        });
                    definition.states.push(State {
                        when,
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

        if definition
            .states
            .iter()
            .filter(|s| s.when.is_none())
            .count()
            != 1
        {
            self.error(
                "semantic.fallback",
                "Definition requires exactly one fallback state",
                node,
            );
        }
        for transition in definition.general_transition.iter().chain(
            definition
                .directional_transitions
                .iter()
                .map(|t| &t.transition),
        ) {
            for target in &transition.targets {
                for property in &target.properties {
                    if property
                        .keyframes
                        .iter()
                        .flatten()
                        .any(|frame| frame.value.contains("${"))
                    {
                        self.error(
                            "semantic.frame-template",
                            "Runtime interpolation is supported only in state CSS values",
                            node,
                        );
                    }
                }
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

fn infer_let_type(
    name: &str,
    bindings: &[LetBinding],
    scope: &mut expression::Scope,
    visiting: &mut BTreeSet<String>,
) -> Result<expression::Type, String> {
    if let Some(value_type) = scope.get(name) {
        return Ok(*value_type);
    }

    if !visiting.insert(name.into()) {
        return Err(format!("Cyclic let binding dependency: {name}"));
    }

    let result = (|| {
        let binding = bindings
            .iter()
            .find(|binding| binding.name == name)
            .ok_or_else(|| format!("Unknown variable: {name}"))?;

        for dependency in expression::dependencies(&binding.initializer) {
            if bindings.iter().any(|binding| binding.name == dependency) {
                infer_let_type(&dependency, bindings, scope, visiting)?;
            }
        }

        let value_type = expression::check(&binding.initializer, scope)?;
        scope.insert(name.into(), value_type);
        Ok(value_type)
    })();
    visiting.remove(name);

    result
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
        let name = node.motion_name().unwrap_or_default();
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

fn split_frame(text: &str) -> (&str, Option<&str>) {
    let mut depth = 0usize;
    let mut quote = None;
    let mut escaped = false;

    for (i, c) in text.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if c == '\\' {
            escaped = true;
            continue;
        }
        if let Some(q) = quote {
            if c == q {
                quote = None;
            }
            continue;
        }
        match c {
            '\'' | '"' => quote = Some(c),
            '(' | '[' | '{' => depth += 1,
            ')' | ']' | '}' => depth = depth.saturating_sub(1),
            '@' if depth == 0 => return (text[..i].trim(), Some(text[i + 1..].trim())),
            _ => {}
        }
    }

    (text.trim(), None)
}
