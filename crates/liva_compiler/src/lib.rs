pub mod analysis;
pub mod builtins;
pub mod edits;
pub mod expression;
pub mod ir;

use expression::ExprExt;
use ir::*;
use liva_syntax::ast::expression::{Expr, from_container};
use liva_syntax::ast::{self as syn, AstNode, HasHeader, HasItems, HasValue};
use liva_syntax::{Diagnostic, Kind, Range, parse, semantic_text};
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

struct BindingView {
    name: String,
    initializer: Expr,
}

struct Compiler {
    diagnostics: Vec<Diagnostic>,
    mappings: BTreeMap<String, Mapping>,
}

impl Compiler {
    fn parameters(&mut self, node: &syn::Motion) -> Vec<MotionParameter> {
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

            let reference = parameter.type_reference();
            let value_type = match reference.as_ref().map(AstNode::semantic_text).as_deref() {
                Some("number") => PrimitiveType::Number,
                Some("boolean") => PrimitiveType::Boolean,
                Some("string") => PrimitiveType::String,
                _ => {
                    let syntax = reference
                        .as_ref()
                        .map(AstNode::syntax)
                        .unwrap_or(parameter.syntax());
                    let source = type_annotation_source(syntax);
                    let start = source.len() - source.trim_start().len();
                    let end = source.trim_end().len();
                    self.diagnostics.push(Diagnostic::error(
                        "semantic.type",
                        "Expected primitive type number, boolean, or string",
                        Range {
                            start: syntax.range().start + start,
                            end: syntax.range().start + end.max(start),
                        },
                    ));
                    continue;
                }
            };

            parameters.push(MotionParameter { name, value_type });
        }

        parameters
    }

    fn let_bindings(&mut self, node: &syn::Motion) -> Vec<BindingView> {
        let mut bindings = vec![];
        let mut seen = BTreeMap::new();

        for binding in node.bindings() {
            let name = binding.header().unwrap_or_default();
            self.unique(&mut seen, &name, &binding);

            if !expression::identifier(&name) || matches!(name.as_str(), "true" | "false") {
                self.error("semantic.binding", "Invalid let identifier", &binding);
            }

            let Some(value) = binding.value_node() else {
                continue;
            };
            let result = self.expression_view(&value);

            match result {
                Some(initializer) => bindings.push(BindingView { name, initializer }),
                None => continue,
            }
        }

        bindings
    }

    fn css_template(
        &mut self,
        node: &syn::Property,
        scope: &expression::Scope,
    ) -> Option<Vec<expression::TemplatePart>> {
        let value = node.value_text().unwrap_or_default();
        if !value.contains("${") {
            return None;
        }
        let syntax = node.value_node().unwrap();
        let mut parts = vec![];
        let mut text = String::new();

        for element in syntax.syntax().children_with_tokens() {
            if let Some(interpolation) = element
                .as_node()
                .filter(|n| n.kind() == Kind::Interpolation)
            {
                if !text.is_empty() {
                    parts.push(expression::TemplatePart::Text(std::mem::take(&mut text)));
                }
                let expr = self.expression_view(interpolation)?;
                match expr.check(scope).and_then(|value_type| {
                    if value_type.is_scalar() {
                        expr.to_output()
                    } else {
                        Err(expr.error("CSS templates require scalar values"))
                    }
                }) {
                    Ok(output) => parts.push(expression::TemplatePart::Expression(output)),
                    Err(error) => {
                        self.expression_error(error);
                        return None;
                    }
                }
            } else if let Some(token) = element.as_token() {
                if token.kind() == Kind::Trivia
                    && (token.text().starts_with("/*") || token.text().starts_with("//"))
                {
                    text.push(' ');
                } else {
                    text.push_str(token.text());
                }
            } else {
                text.push_str(&element.to_string());
            }
        }
        if !text.is_empty() {
            parts.push(expression::TemplatePart::Text(text));
        }
        if let Some(expression::TemplatePart::Text(text)) = parts.first_mut() {
            *text = text.trim_start().into();
        }
        if let Some(expression::TemplatePart::Text(text)) = parts.last_mut() {
            *text = text.trim_end().into();
        }
        parts.retain(
            |part| !matches!(part, expression::TemplatePart::Text(text) if text.is_empty()),
        );
        Some(parts)
    }

    fn expression_view(&self, node: &impl AstNode) -> Option<Expr> {
        let range = node.range();
        if self.diagnostics.iter().any(|diagnostic| {
            diagnostic.code == "semantic.expression"
                && diagnostic.range.start >= range.start
                && diagnostic.range.end <= range.end
        }) {
            return None;
        }
        from_container(node)
    }

    fn animation_declarations(&mut self, node: &impl HasItems, path: &str) -> Option<Timing> {
        let mut family = String::new();
        let mut args: BTreeMap<String, String> = BTreeMap::new();
        let mut call_timing = None;

        for binding in node.bindings() {
            self.error(
                "semantic.structure",
                "Let declarations belong directly to a motion",
                &binding,
            );
        }

        for declaration in node.properties() {
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
                    &declaration.value_node().unwrap(),
                    "value",
                );
                call_timing = self.timing(&declaration, &format!("{path}/timing"));
                continue;
            }
            let value = declaration.value_text().unwrap_or_default();
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
                    &declaration.value_node().unwrap(),
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
            .child::<syn::Block>()?
            .child::<syn::Block>()?
            .child::<syn::Property>()?;
        let mut validator = Compiler {
            diagnostics: parsed
                .diagnostics
                .into_iter()
                .map(|mut diagnostic| {
                    if diagnostic.code == "syntax.expression" {
                        diagnostic.code = "semantic.expression".into();
                    }
                    diagnostic
                })
                .collect(),
            mappings: BTreeMap::new(),
        };
        let timing = validator.timing(&declaration, "");
        for diagnostic in validator.diagnostics {
            self.error(&diagnostic.code, diagnostic.message, node);
        }
        timing
    }

    fn error(&mut self, code: &str, message: impl Into<String>, node: &impl AstNode) {
        self.diagnostics
            .push(Diagnostic::error(code, message, node.range()));
    }

    fn expression_error(&mut self, error: expression::TypeError) {
        self.diagnostics.push(Diagnostic::error(
            "semantic.expression",
            error.message,
            error.range,
        ));
    }

    fn mapping(&mut self, path: &str, node: &impl AstNode, kind: &str) {
        self.mappings.insert(
            path.into(),
            Mapping {
                range: node.range(),
                kind: kind.into(),
            },
        );
    }

    fn unique(&mut self, seen: &mut BTreeMap<String, Range>, name: &str, node: &impl AstNode) {
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
        node: &impl HasItems,
        allowed: Option<&[&str]>,
        path: &str,
    ) -> BTreeMap<String, syn::Property> {
        let mut seen = BTreeMap::new();
        let mut declarations = BTreeMap::new();

        if path.is_empty() || path.contains('/') {
            for binding in node.bindings() {
                self.error(
                    "semantic.structure",
                    "Let declarations belong directly to a motion",
                    &binding,
                );
            }
        }

        for declaration in node.properties() {
            let name = declaration.header().unwrap_or_default();
            self.unique(&mut seen, &name, &declaration);

            if allowed.is_some_and(|a| !a.contains(&name.as_str())) {
                self.error(
                    "semantic.declaration",
                    format!("Unknown declaration: {name}"),
                    &declaration,
                );
            }

            if let Some(value) = declaration.value_node() {
                self.mapping(&format!("{path}/{name}"), &value, "value");
                if value.semantic_text().is_empty() {
                    self.error("semantic.value", "Value must not be empty", &value);
                }
            }

            declarations.insert(name, declaration);
        }

        declarations
    }

    fn timing(&mut self, declaration: &syn::Property, path: &str) -> Option<Timing> {
        let value = declaration.value_node()?;
        let Some(call) = value.timing_call() else {
            self.error("semantic.timing", "Expected a named timing call", &value);
            return None;
        };
        let remainder = value
            .syntax()
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

        for argument in call.arguments() {
            let key = argument.header().unwrap_or_default();
            self.unique(&mut seen, &key, &argument);
            if let Some(value) = argument.value_node() {
                self.mapping(&format!("{path}/{key}"), &value, "value");
            }
            args.insert(key, argument.value_text().unwrap_or_default());
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

    fn transition(&mut self, node: &syn::Transition, path: &str) -> Transition {
        self.mapping(path, node, "block");
        let timing = self.animation_declarations(node, path);
        let mut targets = vec![];
        let mut seen = BTreeMap::new();

        for target in node.targets() {
            let name = target.header().unwrap_or_default();
            self.unique(&mut seen, &name, &target);
            let target_path = format!("{path}/target/{name}");
            self.mapping(&target_path, &target, "block");
            self.declarations(&target, Some(&[]), &target_path);
            let mut properties = vec![];
            let mut property_names = BTreeMap::new();

            for property in target.property_blocks() {
                let name = property.header().unwrap_or_default();
                self.unique(&mut property_names, &name, &property);
                let property_path = format!("{target_path}/property/{name}");
                self.mapping(&property_path, &property, "block");
                let timing = self.animation_declarations(&property, &property_path);
                let mut frames = vec![];
                let mut offsets = BTreeMap::new();

                for frame in property.keyframes() {
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
                    if let Some(header) = frame.header_node() {
                        self.mapping(&format!("{frame_path}/offset"), &header, "value");
                    }
                    let fields = self.declarations(&frame, Some(&["value", "easing"]), &frame_path);
                    let value = fields
                        .get("value")
                        .and_then(HasValue::value_text)
                        .unwrap_or_else(|| {
                            self.error("semantic.frame", "Frame requires value", &frame);
                            String::new()
                        });
                    let easing = fields.get("easing").and_then(HasValue::value_text);
                    frames.push(Frame {
                        offset,
                        value,
                        easing,
                    });
                }

                for frame in property
                    .properties()
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
                        &frame.header_node().unwrap(),
                        "value",
                    );
                    let raw = frame.value_text().unwrap_or_default();
                    let (value, easing) = split_frame(&raw);
                    if value.is_empty() || easing.is_some_and(str::is_empty) {
                        self.error(
                            "semantic.frame",
                            "Frame requires a value and nonempty easing",
                            &frame,
                        );
                    }
                    let value_node = frame.value_node().unwrap();
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

    fn motion_scope(
        &mut self,
        node: &syn::Motion,
        parameters: &[MotionParameter],
        bindings: &[BindingView],
    ) -> expression::Scope {
        use expression::Type;
        let mut scope = expression::Scope::new();

        for parameter in parameters {
            let value_type = match parameter.value_type {
                PrimitiveType::Number => Type::Number,
                PrimitiveType::Boolean => Type::Boolean,
                PrimitiveType::String => Type::String,
            };
            scope.insert(parameter.name.clone(), value_type);
        }

        let mut targets = BTreeMap::new();

        for state in node.states() {
            for target in state.targets() {
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

        for binding in bindings {
            if scope.contains_key(&binding.name) {
                self.error(
                    "semantic.duplicate",
                    format!("Duplicate variable: {}", binding.name),
                    node,
                );
            }
        }

        let initial_scope = scope.clone();
        let by_name: BTreeMap<_, _> = bindings
            .iter()
            .map(|binding| (binding.name.clone(), &binding.initializer))
            .collect();

        for binding in bindings {
            let name = &binding.name;
            if initial_scope.contains_key(name) {
                continue;
            }

            if let Err(error) = infer_let_type(name, &by_name, &mut scope, &mut BTreeSet::new())
                && !self.diagnostics.iter().any(|diagnostic| {
                    diagnostic.code == "semantic.expression"
                        && diagnostic.range == error.range
                        && diagnostic.message == error.message
                })
            {
                self.expression_error(error);
            }
        }

        scope
    }

    fn definition(&mut self, node: &syn::Motion) -> Definition {
        let name = node.name().unwrap_or_default();
        self.mapping(&name, node, "block");
        self.declarations(node, Some(&[]), &name);
        let bindings = self.let_bindings(node);
        let parameters = self.parameters(node);
        let scope = self.motion_scope(node, &parameters, &bindings);
        let mut definition = Definition {
            name: name.clone(),
            let_bindings: bindings
                .into_iter()
                .map(|binding| LetBinding {
                    name: binding.name,
                    initializer: binding
                        .initializer
                        .to_output()
                        .expect("syntax-checked initializer"),
                })
                .collect(),
            parameters,
            states: vec![],
            general_transition: None,
            directional_transitions: vec![],
        };

        let mut states = BTreeMap::new();
        let mut fallback_count = 0;
        let mut transitions = BTreeMap::new();

        for item in node.items() {
            match item {
                syn::MotionItem::State(state) => {
                    let state_name = state.name().unwrap();
                    self.unique(&mut states, &state_name, &state);
                    let state_path = format!("{name}/state/{state_name}");
                    self.mapping(&state_path, &state, "block");
                    self.declarations(&state, Some(&[]), &state_path);
                    let mut targets = vec![];
                    let mut target_names = BTreeMap::new();

                    for target in state.targets() {
                        let target_name = target.header().unwrap_or_default();
                        self.unique(&mut target_names, &target_name, &target);
                        let target_path = format!("{state_path}/target/{target_name}");
                        self.mapping(&target_path, &target, "block");
                        self.declarations(&target, None, &target_path);
                        if target.blocks().next().is_some() {
                            self.error(
                                "semantic.structure",
                                "State targets contain declarations only",
                                &target,
                            );
                        }
                        let properties = target
                            .properties()
                            .map(|p| Property {
                                name: p.header().unwrap_or_default(),
                                template: self.css_template(&p, &scope),
                                value: p.value_text().unwrap_or_default(),
                            })
                            .collect();
                        targets.push(Target {
                            name: target_name,
                            properties,
                        });
                    }

                    let condition = state.condition();
                    if condition.is_none() {
                        fallback_count += 1;
                    }
                    let when = condition.and_then(|condition| {
                        let parsed = self.expression_view(&condition)?;
                        match parsed.check(&scope).and_then(|value_type| {
                            if value_type == expression::Type::Boolean {
                                parsed.to_output()
                            } else {
                                Err(parsed.error("State condition must be Boolean"))
                            }
                        }) {
                            Ok(expr) => Some(expr),
                            Err(error) => {
                                self.expression_error(error);
                                None
                            }
                        }
                    });
                    definition.states.push(State {
                        when,
                        name: state_name,
                        targets,
                    });
                }
                syn::MotionItem::Transition(transition) => match transition.selector() {
                    Some(syn::TransitionSelector::General) => {
                        self.unique(&mut transitions, "general", &transition);
                        definition.general_transition = Some(
                            self.transition(&transition, &format!("{name}/transition/general")),
                        );
                    }
                    Some(syn::TransitionSelector::Directional { from, to }) => {
                        self.unique(&mut transitions, &format!("{from}/{to}"), &transition);
                        let value = self.transition(
                            &transition,
                            &format!("{name}/transition/directional/{from}/{to}"),
                        );
                        definition
                            .directional_transitions
                            .push(DirectionalTransition {
                                from,
                                to,
                                transition: value,
                            });
                    }
                    None => self.error(
                        "semantic.structure",
                        "Expected state or transition",
                        &transition,
                    ),
                },
                syn::MotionItem::Invalid(block) => {
                    self.error("semantic.structure", "Expected state or transition", &block)
                }
            }
        }

        if fallback_count != 1 {
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

    fn validate(&mut self, def: &Definition, node: &syn::Motion) {
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

// Preserve byte positions when locating a type annotation inside surrounding comments.
fn type_annotation_source(node: &impl AstNode) -> String {
    node.syntax()
        .descendants_with_tokens()
        .filter_map(|element| element.into_token())
        .map(|token| {
            let text = token.text();
            if token.kind() == Kind::Trivia && (text.starts_with("/*") || text.starts_with("//")) {
                text.bytes()
                    .map(|byte| {
                        if matches!(byte, b'\n' | b'\r') {
                            byte as char
                        } else {
                            ' '
                        }
                    })
                    .collect::<String>()
            } else {
                text.to_owned()
            }
        })
        .collect()
}

fn infer_let_type(
    name: &str,
    bindings: &BTreeMap<String, &Expr>,
    scope: &mut expression::Scope,
    visiting: &mut BTreeSet<String>,
) -> Result<expression::Type, expression::TypeError> {
    if let Some(value_type) = scope.get(name) {
        return Ok(*value_type);
    }

    visiting.insert(name.into());
    let binding = bindings[name];
    let result = (|| {
        for (dependency, range) in binding.dependencies() {
            if !bindings.contains_key(&dependency) || scope.contains_key(&dependency) {
                continue;
            }
            if visiting.contains(&dependency) {
                return Err(expression::TypeError {
                    message: format!("Cyclic let binding dependency: {dependency}"),
                    range,
                });
            }

            infer_let_type(&dependency, bindings, scope, visiting)?;
        }

        let value_type = binding.check(scope)?;
        scope.insert(name.into(), value_type);
        Ok(value_type)
    })();
    visiting.remove(name);

    result
}

pub fn compile(source: &str, development: bool) -> Compilation {
    let parsed = parse(source);
    let mut compiler = Compiler {
        diagnostics: parsed
            .diagnostics
            .into_iter()
            .map(|mut diagnostic| {
                if diagnostic.code == "syntax.expression" {
                    diagnostic.code = "semantic.expression".into();
                }
                diagnostic
            })
            .collect(),
        mappings: BTreeMap::new(),
    };
    let mut definitions = vec![];
    let mut seen = BTreeMap::new();
    let mut duplicates = BTreeSet::new();
    compiler.declarations(&parsed.root, Some(&[]), "");

    for node in parsed.root.motions() {
        let name = node.name().unwrap_or_default();
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
