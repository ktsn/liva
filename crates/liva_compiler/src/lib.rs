pub mod analysis;
pub mod builtins;
mod diagnostic_source;
pub mod edits;
pub mod expression;
pub mod ir;

use diagnostic_source::{SourceText, header_range, name_range, significant_range};
use expression::ExprExt;
use ir::*;
use liva_syntax::ast::expression::{Expr, from_container};
use liva_syntax::ast::{self as syn, AstNode, HasHeader, HasItems, HasValue};
use liva_syntax::{Diagnostic, Kind, Range, parse};
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
    name_range: Range,
}

struct Compiler {
    diagnostics: Vec<Diagnostic>,
    mappings: BTreeMap<String, Mapping>,
    sources: BTreeMap<String, liva_syntax::SyntaxNode>,
    timing_origins: BTreeMap<String, Range>,
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
                    let range = if let Some(reference) = &reference {
                        let source = type_annotation_source(reference);
                        let start = source.len() - source.trim_start().len();
                        let end = source.trim_end().len();
                        Range {
                            start: reference.range().start + start,
                            end: reference.range().start + end.max(start),
                        }
                    } else {
                        let end = name_range(&parameter).end;
                        Range { start: end, end }
                    };
                    self.error_range(
                        "semantic.type",
                        "Expected primitive type number, boolean, or string",
                        range,
                    );
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
                Some(initializer) => bindings.push(BindingView {
                    name,
                    initializer,
                    name_range: name_range(&binding),
                }),
                None => continue,
            }
        }

        bindings
    }

    fn css_template(
        &mut self,
        node: &impl HasValue,
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
        let mut ranges = BTreeMap::new();
        let mut names = BTreeMap::new();
        let mut origin = header_range(node);

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
            let value_node = declaration.value_node().unwrap();
            let source = SourceText::new(&value_node);
            let value = source.text.trim();
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
                ranges.clear();
                names.clear();
            }
            family = next_family.into();
            origin = name_range(&declaration);

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
                args.insert(field.into(), value.to_owned());
                ranges.insert(field.into(), source.range(value));
                names.insert(field.into(), origin.clone());
                self.mapping(
                    &format!("{path}/timing/{field}"),
                    &declaration.value_node().unwrap(),
                    "value",
                );
            } else if family == "tween" {
                let split = value.find(char::is_whitespace).unwrap_or(value.len());
                args.insert("duration".into(), value[..split].into());
                ranges.insert("duration".into(), source.range(&value[..split]));
                ranges.insert("easing".into(), source.range(value[split..].trim()));
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
                    let range = if values.len() > fields.len() {
                        let first = source.range(values[fields.len()]);
                        let last = source.range(values.last().unwrap());
                        Range {
                            start: first.start,
                            end: last.end,
                        }
                    } else {
                        source.range(value)
                    };
                    self.error_range("semantic.timing", "Invalid spring shorthand", range);
                }
                for (field, value) in fields.iter().zip(values) {
                    args.insert((*field).into(), value.into());
                    ranges.insert((*field).into(), source.range(value));
                    names.insert((*field).into(), origin.clone());
                }
            }
        }

        if family.is_empty() {
            return None;
        }

        self.timing_origins.insert(path.into(), origin.clone());
        self.timing(&family, &args, &ranges, &names, origin)
    }

    fn error(&mut self, code: &str, message: impl Into<String>, node: &impl AstNode) {
        let range = if code == "semantic.structure" {
            if node.syntax().kind() == Kind::Let {
                significant_range(node)
            } else {
                header_range(node)
            }
        } else {
            name_range(node)
        };
        self.error_range(code, message, range);
    }

    fn error_range(&mut self, code: &str, message: impl Into<String>, range: Range) {
        self.diagnostics
            .push(Diagnostic::error(code, message, range));
    }

    fn source_header(&self, path: &str) -> Range {
        header_range(&self.sources[path])
    }

    fn expression_error(&mut self, error: expression::TypeError) {
        self.diagnostics.push(Diagnostic::error(
            "semantic.expression",
            error.message,
            error.range,
        ));
    }

    fn mapping(&mut self, path: &str, node: &impl AstNode, kind: &str) {
        self.sources.insert(path.into(), node.syntax().clone());
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
                name_range(node),
            );
            diagnostic.related.push(previous.clone());
            self.diagnostics.push(diagnostic);
        } else {
            seen.insert(name.into(), name_range(node));
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

    fn timing(
        &mut self,
        name: &str,
        args: &BTreeMap<String, String>,
        ranges: &BTreeMap<String, Range>,
        names: &BTreeMap<String, Range>,
        origin: Range,
    ) -> Option<Timing> {
        let duration_mode = args.contains_key("duration") || args.contains_key("bounce");
        let allowed: &[&str] = match name {
            "tween" => &["duration", "easing"],
            "spring" if duration_mode => &["duration", "bounce"],
            "spring" => &["stiffness", "damping", "mass"],
            _ => {
                self.error_range(
                    "semantic.timing",
                    format!("Unknown timing family: {name}"),
                    origin.clone(),
                );
                return None;
            }
        };

        for key in args.keys() {
            if !allowed.contains(&key.as_str()) {
                self.error_range(
                    "semantic.argument",
                    format!("Unknown or mixed timing field: {key}"),
                    names.get(key).cloned().unwrap_or_else(|| origin.clone()),
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
                self.error_range(
                    "semantic.number",
                    format!(
                        "Invalid or missing {key}; expected {}.",
                        if time {
                            "finite time with ms or s units"
                        } else {
                            "finite number in range"
                        }
                    ),
                    ranges.get(key).cloned().unwrap_or_else(|| origin.clone()),
                );
                None
            }
        };

        match name {
            "tween" => {
                let duration_ms = number("duration", None, true, 0.0, true)?;
                let easing = args
                    .get("easing")
                    .cloned()
                    .unwrap_or_else(|| "linear".into());
                if easing.is_empty() {
                    self.error_range(
                        "semantic.easing",
                        "Easing must be nonempty CSS text",
                        ranges
                            .get("easing")
                            .cloned()
                            .unwrap_or_else(|| origin.clone()),
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
                    self.error_range(
                        "semantic.bounce",
                        "Bounce must be less than 1",
                        ranges
                            .get("bounce")
                            .cloned()
                            .unwrap_or_else(|| origin.clone()),
                    );
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

    fn transition(
        &mut self,
        node: &syn::Transition,
        path: &str,
        scope: &expression::Scope,
    ) -> Transition {
        let endpoint = match node.selector() {
            Some(syn::TransitionSelector::Enter | syn::TransitionSelector::EnterState(_)) => {
                Some(0.0)
            }
            Some(syn::TransitionSelector::Leave | syn::TransitionSelector::LeaveState(_)) => {
                Some(1.0)
            }
            _ => None,
        };
        self.mapping(path, node, "block");
        let timing = self.animation_declarations(node, path);
        let mut targets = vec![];
        let mut seen = BTreeMap::new();

        for target in node.targets() {
            let name = target.header().unwrap_or_default();
            self.unique(&mut seen, &name, &target);
            let target_path = format!("{path}/target/{name}");
            self.mapping(&target_path, &target, "block");
            if endpoint.is_none() {
                self.declarations(&target, Some(&[]), &target_path);
            } else {
                for binding in target.bindings() {
                    self.error(
                        "semantic.structure",
                        "Let declarations belong directly to a motion",
                        &binding,
                    );
                }
            }
            let mut properties = vec![];
            let mut property_names = BTreeMap::new();

            for item in target.animation_properties() {
                let property = match item {
                    syn::AnimationProperty::Keyframes(property) => property,
                    syn::AnimationProperty::Shorthand(property) => {
                        let Some(offset) = endpoint else { continue };
                        let name = property.header().unwrap_or_default();
                        self.unique(&mut property_names, &name, &property);
                        let property_path = format!("{target_path}/property/{name}");
                        self.mapping(&property_path, &property, "block");
                        if !liva_syntax::is_property(&name) || name.starts_with('@') {
                            self.error(
                                "semantic.declaration",
                                "Expected a CSS property",
                                &property,
                            );
                            continue;
                        }
                        let value = property.value_text().unwrap_or_default();
                        let value_node = property.value_node().unwrap();
                        if value.is_empty() {
                            self.error("semantic.value", "Value must not be empty", &value_node);
                        }
                        let frame_path = format!("{property_path}/frame/{offset}");
                        self.mapping(&frame_path, &property, "block");
                        self.mapping(&format!("{frame_path}/value"), &value_node, "value");
                        properties.push(PropertyTransition {
                            name,
                            timing: None,
                            keyframes: Some(vec![Frame {
                                offset,
                                value,
                                easing: None,
                                template: self.css_template(&property, scope),
                            }]),
                        });
                        continue;
                    }
                };
                let name = property.header().unwrap_or_default();
                self.unique(&mut property_names, &name, &property);
                let property_path = format!("{target_path}/property/{name}");
                self.mapping(&property_path, &property, "block");
                let timing = self.animation_declarations(&property, &property_path);
                let mut frames = vec![];
                let mut offsets = BTreeMap::new();

                for block in property.blocks() {
                    self.error(
                        "semantic.structure",
                        "Property tracks accept animation declarations and inline keyframes",
                        &block,
                    );
                }

                for frame in property.keyframes() {
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
                    let value_node = frame.value_node().unwrap();
                    let source = SourceText::new(&value_node);
                    let (value, easing) = split_frame(source.text.trim());

                    if value.is_empty() || easing.is_some_and(str::is_empty) {
                        self.error_range(
                            "semantic.frame",
                            "Frame requires a value and nonempty easing",
                            source.range(if value.is_empty() {
                                value
                            } else {
                                easing.unwrap()
                            }),
                        );
                    }

                    if endpoint.is_none() && value.contains("${") {
                        let interpolations: Vec<_> = value_node
                            .syntax()
                            .descendants()
                            .filter_map(syn::Interpolation::cast)
                            .collect();

                        if interpolations.is_empty() {
                            let start = value.find("${").unwrap();
                            self.error_range(
                                "semantic.frame-template",
                                "Runtime interpolation is supported only in state CSS values",
                                source.range(&value[start..]),
                            );
                        } else {
                            for interpolation in interpolations {
                                self.error_range(
                                    "semantic.frame-template",
                                    "Runtime interpolation is supported only in state CSS values",
                                    significant_range(&interpolation),
                                );
                            }
                        }
                    }
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
                    let mut template = endpoint.and_then(|_| self.css_template(&frame, scope));
                    if easing.is_some()
                        && let Some(expression::TemplatePart::Text(text)) =
                            template.as_mut().and_then(|parts| parts.last_mut())
                    {
                        *text = split_frame(text).0.trim_end().into();
                    }
                    frames.push(Frame {
                        template,
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
        let mut declared: BTreeMap<_, _> = node
            .parameters()
            .map(|parameter| {
                (
                    parameter.header().unwrap_or_default(),
                    name_range(&parameter),
                )
            })
            .collect();

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
                let mut diagnostic = Diagnostic::error(
                    "semantic.duplicate",
                    format!("Duplicate variable: {name}"),
                    name_range(&target),
                );
                diagnostic.related.extend(declared.get(&name).cloned());
                self.diagnostics.push(diagnostic);
            }
            declared.entry(name).or_insert_with(|| name_range(&target));
        }

        for binding in bindings {
            if scope.contains_key(&binding.name) {
                let mut diagnostic = Diagnostic::error(
                    "semantic.duplicate",
                    format!("Duplicate variable: {}", binding.name),
                    binding.name_range.clone(),
                );
                diagnostic
                    .related
                    .extend(declared.get(&binding.name).cloned());
                self.diagnostics.push(diagnostic);
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
            events: vec![],
            enter: None,
            leave: None,
            state_enters: vec![],
            state_leaves: vec![],
            states: vec![],
            general_transition: None,
            directional_transitions: vec![],
        };

        let mut events = BTreeMap::new();

        for event in node.events() {
            let event_name = event.header().unwrap_or_default();
            if !liva_syntax::is_name(&event_name) {
                self.error("semantic.event", "Expected an event name", &event);
            }
            self.unique(&mut events, &event_name, &event);

            if let Some(condition) = event.condition()
                && let Some(parsed) = self.expression_view(&condition)
            {
                match parsed.check(&scope).and_then(|ty| {
                    if ty == expression::Type::Boolean {
                        parsed.to_output()
                    } else {
                        Err(parsed.error("Event condition must be Boolean"))
                    }
                }) {
                    Ok(when) => definition.events.push(Event {
                        name: event_name,
                        when,
                    }),
                    Err(error) => self.expression_error(error),
                }
            }
        }

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
                        for block in target.blocks() {
                            self.error(
                                "semantic.structure",
                                "State targets contain declarations only",
                                &block,
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
                    Some(
                        selector @ (syn::TransitionSelector::Enter
                        | syn::TransitionSelector::Leave
                        | syn::TransitionSelector::EnterState(_)
                        | syn::TransitionSelector::LeaveState(_)),
                    ) => {
                        let phase = if matches!(
                            selector,
                            syn::TransitionSelector::Enter | syn::TransitionSelector::EnterState(_)
                        ) {
                            "enter"
                        } else {
                            "leave"
                        };
                        let state = transition.lifecycle_state();
                        let suffix = state
                            .as_ref()
                            .map_or_else(|| phase.to_string(), |state| format!("{phase}/{state}"));
                        self.unique(&mut transitions, &suffix, &transition);
                        let value =
                            self.transition(&transition, &format!("{name}/{suffix}"), &scope);
                        match (phase, state) {
                            ("enter", None) => definition.enter = Some(value),
                            (_, None) => definition.leave = Some(value),
                            ("enter", Some(state)) => {
                                definition.state_enters.push(StateTransition {
                                    state,
                                    transition: value,
                                })
                            }
                            (_, Some(state)) => definition.state_leaves.push(StateTransition {
                                state,
                                transition: value,
                            }),
                        }
                    }
                    Some(syn::TransitionSelector::General) => {
                        self.unique(&mut transitions, "general", &transition);
                        definition.general_transition = Some(self.transition(
                            &transition,
                            &format!("{name}/transition/general"),
                            &scope,
                        ));
                    }
                    Some(syn::TransitionSelector::Directional { from, to }) => {
                        self.unique(&mut transitions, &format!("{from}/{to}"), &transition);
                        let value = self.transition(
                            &transition,
                            &format!("{name}/transition/directional/{from}/{to}"),
                            &scope,
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
            let fallbacks: Vec<_> = node
                .states()
                .filter(|state| state.condition().is_none())
                .collect();
            let mut diagnostic = Diagnostic::error(
                "semantic.fallback",
                "Definition requires exactly one fallback state",
                fallbacks
                    .get(1)
                    .map_or_else(|| header_range(node), header_range),
            );
            diagnostic.related.extend(
                fallbacks
                    .first()
                    .filter(|_| fallbacks.len() > 1)
                    .map(header_range),
            );
            diagnostic
                .related
                .extend(fallbacks.iter().skip(2).map(header_range));
            self.diagnostics.push(diagnostic);
        }
        if let Some(fallback) = definition
            .states
            .iter()
            .find(|state| state.when.is_none())
            .cloned()
        {
            for state in &mut definition.states {
                if state.when.is_none() {
                    continue;
                }

                for target in &fallback.targets {
                    if let Some(existing) = state
                        .targets
                        .iter_mut()
                        .find(|item| item.name == target.name)
                    {
                        for property in &target.properties {
                            if !existing
                                .properties
                                .iter()
                                .any(|item| item.name == property.name)
                            {
                                existing.properties.push(property.clone());
                            }
                        }
                    } else {
                        state.targets.push(target.clone());
                    }
                }
            }
        }
        self.validate(&definition, node);
        for (default, overrides) in [
            (&definition.enter, &mut definition.state_enters),
            (&definition.leave, &mut definition.state_leaves),
        ] {
            for item in overrides {
                item.transition = merge_lifecycle(default.as_ref(), &item.transition);
            }
        }
        definition
    }

    fn validate(&mut self, def: &Definition, node: &syn::Motion) {
        if def.states.is_empty() {
            self.error_range(
                "semantic.states",
                "Definition needs at least one state",
                header_range(node),
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

        for (phase, default, overrides) in [
            ("enter", &def.enter, &def.state_enters),
            ("leave", &def.leave, &def.state_leaves),
        ] {
            for (state, specific) in default.iter().map(|animation| (None, animation)).chain(
                overrides
                    .iter()
                    .map(|item| (Some(item.state.as_str()), &item.transition)),
            ) {
                let base_path = format!("{}/{phase}", def.name);
                let path =
                    state.map_or_else(|| base_path.clone(), |state| format!("{base_path}/{state}"));
                if let Some(state) = state
                    && !def.states.iter().any(|item| item.name == state)
                {
                    let header = self.sources[&path].child::<syn::Header>().unwrap();
                    let source = SourceText::new(&header);
                    self.error_range(
                        "semantic.reference",
                        format!("Unknown state: {state}"),
                        source.range(source.text.split_whitespace().nth(1).unwrap()),
                    );
                }
                let animation = if state.is_some() {
                    merge_lifecycle(default.as_ref(), specific)
                } else {
                    specific.clone()
                };
                for target in &animation.targets {
                    let specific_target_path = format!("{path}/target/{}", target.name);
                    let target_path = if self.sources.contains_key(&specific_target_path) {
                        specific_target_path
                    } else {
                        format!("{base_path}/target/{}", target.name)
                    };
                    if !def
                        .states
                        .iter()
                        .any(|state| state.targets.iter().any(|item| item.name == target.name))
                    {
                        self.error_range(
                            "semantic.reference",
                            format!("Unknown lifecycle target: {}", target.name),
                            self.source_header(&target_path),
                        );
                    }
                    for property in &target.properties {
                        let specific_property_path =
                            format!("{path}/target/{}/property/{}", target.name, property.name);
                        let property_path = if self.sources.contains_key(&specific_property_path) {
                            specific_property_path
                        } else {
                            format!(
                                "{base_path}/target/{}/property/{}",
                                target.name, property.name
                            )
                        };
                        let timing = property.timing.as_ref().or(animation.timing.as_ref());
                        if timing.is_none() {
                            self.error_range(
                                "semantic.timing-missing",
                                "Lifecycle property requires timing",
                                self.source_header(&property_path),
                            );
                        }
                        if timing.is_some_and(|timing| !matches!(timing, Timing::Tween { .. }))
                            && property.keyframes.as_ref().is_some_and(|frames| {
                                frames.iter().any(|frame| {
                                    (frame.offset > 0.0 && frame.offset < 1.0)
                                        || frame.easing.is_some()
                                })
                            })
                        {
                            self.error_range(
                                "semantic.spring-keyframes",
                                "Spring tracks cannot contain intermediate frames or frame easing",
                                self.source_header(&property_path),
                            );
                        }
                    }
                }
            }
        }

        for direction in &def.directional_transitions {
            let path = format!(
                "{}/transition/directional/{}/{}",
                def.name, direction.from, direction.to
            );
            let header = self.sources[&path].child::<syn::Header>().unwrap();
            let source = SourceText::new(&header);
            let words: Vec<_> = source.text.split_whitespace().collect();

            for (index, name) in [(1, &direction.from), (3, &direction.to)] {
                if !def.states.iter().any(|s| &s.name == name) {
                    self.error_range(
                        "semantic.reference",
                        format!("Unknown state: {name}"),
                        source.range(words[index]),
                    );
                }
            }
        }

        for state in &def.states {
            for (target, property) in &pairs {
                if state.value(target, property).is_none() {
                    let state_path = format!("{}/state/{}", def.name, state.name);
                    let target_path = format!("{state_path}/target/{target}");
                    let path = if self.sources.contains_key(&target_path) {
                        &target_path
                    } else {
                        &state_path
                    };
                    self.error_range(
                        "semantic.completeness",
                        format!("MVP requires {target}.{property} in state {}", state.name),
                        self.source_header(path),
                    );
                }
            }
        }

        for from in &def.states {
            for to in &def.states {
                if from.name == to.name {
                    continue;
                }

                let general_path = format!("{}/transition/general", def.name);
                let directional_path = format!(
                    "{}/transition/directional/{}/{}",
                    def.name, from.name, to.name
                );
                let general = def.general_transition.as_ref();
                let directional = def
                    .directional_transitions
                    .iter()
                    .find(|t| t.from == from.name && t.to == to.name)
                    .map(|t| &t.transition);

                for (target, property) in &pairs {
                    let gp_path = format!("{general_path}/target/{target}/property/{property}");
                    let dp_path = format!("{directional_path}/target/{target}/property/{property}");
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
                        if to
                            .targets
                            .iter()
                            .find(|item| item.name == *target)
                            .and_then(|item| {
                                item.properties.iter().find(|item| item.name == *property)
                            })
                            .is_some_and(|item| item.template.is_some())
                        {
                            continue;
                        }
                        let state_path = format!("{}/state/{}", def.name, to.name);
                        let path = [&dp_path, &gp_path, &directional_path, &general_path]
                            .into_iter()
                            .find(|path| self.sources.contains_key(*path))
                            .unwrap_or(&state_path);
                        self.error_range(
                            "semantic.timing-missing",
                            format!(
                                "Missing timing for {target}.{property}: {} -> {}",
                                from.name, to.name
                            ),
                            self.source_header(path),
                        );
                        continue;
                    };

                    if let Some(frames) = frames {
                        let frame_track = if dp.is_some_and(|p| p.keyframes.is_some()) {
                            &dp_path
                        } else {
                            &gp_path
                        };
                        let timing_path = if dp.is_some_and(|p| p.timing.is_some()) {
                            &dp_path
                        } else if gp.is_some_and(|p| p.timing.is_some()) {
                            &gp_path
                        } else if directional.is_some_and(|t| t.timing.is_some()) {
                            &directional_path
                        } else {
                            &general_path
                        };

                        for frame in frames {
                            let frame_path = format!("{frame_track}/frame/{}", frame.offset);
                            let frame_node = &self.sources[&frame_path];
                            let value_node = frame_node.child::<syn::Value>().unwrap();
                            let source = SourceText::new(&value_node);
                            let (value, easing) = split_frame(source.text.trim());
                            let intermediate = frame.offset > 0.0 && frame.offset < 1.0;

                            if !matches!(timing, Timing::Tween { .. })
                                && (intermediate || easing.is_some())
                            {
                                let range = if intermediate {
                                    name_range(frame_node)
                                } else {
                                    source.range(easing.unwrap())
                                };
                                let mut diagnostic = Diagnostic::error(
                                    "semantic.spring-frames",
                                    format!(
                                        "Spring {target}.{property} cannot have intermediate frames or frame easing: {} -> {}",
                                        from.name, to.name
                                    ),
                                    range,
                                );
                                diagnostic
                                    .related
                                    .extend(self.timing_origins.get(timing_path).cloned());
                                self.diagnostics.push(diagnostic);
                            }

                            let endpoint_state = if frame.offset == 0.0 {
                                Some(from)
                            } else if frame.offset == 1.0 {
                                Some(to)
                            } else {
                                None
                            };
                            let endpoint =
                                endpoint_state.and_then(|state| state.value(target, property));
                            let mismatch = endpoint.is_some_and(|v| v != frame.value);

                            if mismatch || (frame.offset == 1.0 && easing.is_some()) {
                                let mut warning = Diagnostic::error(
                                    "semantic.endpoint",
                                    format!(
                                        "{target}.{property}: explicit endpoint differs from state or final easing has no interval"
                                    ),
                                    source.range(if mismatch { value } else { easing.unwrap() }),
                                );
                                warning.severity = "warning".into();

                                if mismatch {
                                    let state = endpoint_state.unwrap();
                                    let path = format!(
                                        "{}/state/{}/target/{target}/{property}",
                                        def.name, state.name
                                    );
                                    warning
                                        .related
                                        .extend(self.sources.get(&path).map(significant_range));
                                }
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
        sources: BTreeMap::new(),
        timing_origins: BTreeMap::new(),
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

/// Apply the same property-first timing precedence as directional transitions.
fn merge_lifecycle(default: Option<&Transition>, specific: &Transition) -> Transition {
    let mut result = specific.clone();
    result.timing = specific
        .timing
        .clone()
        .or_else(|| default.and_then(|item| item.timing.clone()));
    if let Some(default) = default {
        for target in &default.targets {
            if let Some(existing) = result
                .targets
                .iter_mut()
                .find(|item| item.name == target.name)
            {
                for property in &target.properties {
                    if let Some(overridden) = existing
                        .properties
                        .iter_mut()
                        .find(|item| item.name == property.name)
                    {
                        overridden.timing = overridden
                            .timing
                            .clone()
                            .or_else(|| property.timing.clone());
                        overridden.keyframes = overridden
                            .keyframes
                            .clone()
                            .or_else(|| property.keyframes.clone());
                    } else {
                        existing.properties.push(property.clone());
                    }
                }
            } else {
                result.targets.push(target.clone());
            }
        }
    }
    result
}
