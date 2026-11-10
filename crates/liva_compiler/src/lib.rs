pub mod analysis;
pub mod builtins;
mod controller_bindings;
mod diagnostic_source;
pub mod edits;
pub mod expression;
pub mod ir;
pub mod scope;
mod target;

use controller_bindings::{ControllerBindings, ControllerScope};
use diagnostic_source::{header_range, name_range, significant_range};
use expression::ExprExt;
use ir::*;
use liva_syntax::ast::expression::{Expr, from_container};
use liva_syntax::ast::{self as syn, AstNode, HasHeader, HasItems, HasValue};
use liva_syntax::{Diagnostic, Kind, Range, parse};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use target::{TargetId, TargetOrigin};

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
    sources: BTreeMap<String, liva_syntax::SyntaxNode>,
}

impl Compiler {
    fn parameters(&mut self, node: &syn::Motion) -> Vec<MotionParameter> {
        let mut parameters = vec![];

        for parameter in node.parameters() {
            let name = parameter.header().unwrap_or_default();

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

        for binding in node.bindings() {
            let name = binding.header().unwrap_or_default();

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

    fn decorator_expression(
        &mut self,
        node: &impl AstNode,
        scope: &expression::Scope,
        expected: expression::Type,
    ) -> Option<expression::Expression> {
        let mut decorators = node.decorators();
        let decorator = decorators.next()?;

        for duplicate in decorators {
            self.error(
                "semantic.decorator",
                "A declaration accepts one timing or easing decorator",
                &duplicate,
            );
        }

        if expected == expression::Type::Easing
            && liva_syntax::ast::Keyframe::cast(node.syntax().clone())
                .and_then(|frame| frame.header())
                .and_then(|header| header.trim_end_matches('%').parse::<f64>().ok())
                == Some(100.0)
        {
            let mut diagnostic = Diagnostic::error(
                "semantic.final-frame-easing",
                "The final 100% keyframe has no outgoing interval; remove its easing decorator",
                decorator.range(),
            );
            diagnostic.severity = "warning".into();
            self.diagnostics.push(diagnostic);
        }

        let text = decorator.expression_text();
        let source = text.as_str();

        let result = expression::parse_with_diagnostics(source).and_then(|parsed| {
            if parsed.check(scope)? != expected {
                return Err(parsed.error(format!("Decorator requires {:?}", expected)));
            }

            parsed.to_output()
        });

        match result {
            Ok(value) => Some(value),
            Err(mut error) => {
                error.range.start += decorator.range().start + 1;
                error.range.end += decorator.range().start + 1;
                self.expression_error(error);
                None
            }
        }
    }

    fn css_value(&mut self, node: &impl HasValue, scope: &expression::Scope) -> CssValue {
        match self.css_template(node, scope) {
            Some(parts) => CssValue::Template { parts },
            None => CssValue::Literal {
                value: node.value_text().unwrap_or_default(),
            },
        }
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
            if element.kind() == Kind::Decorator {
                continue;
            }
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

    fn animation_declarations(&mut self, node: &impl HasItems, path: &str) {
        for binding in node.bindings() {
            self.error(
                "semantic.structure",
                "Let declarations belong directly to a motion",
                &binding,
            );
        }

        for declaration in node.properties() {
            let name = declaration.header().unwrap_or_default();
            if name.ends_with('%') && path.contains("/property/") {
                continue;
            }
            self.error(
                "semantic.declaration",
                format!("Unexpected declaration: {name}"),
                &declaration,
            );
        }
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
        let mut range = node.range();

        if kind == "value"
            && let Some(decorator) = node.children::<syn::Decorator>().next()
        {
            range.end = decorator.range().start;
        }

        self.mappings.insert(
            path.into(),
            Mapping {
                range,
                kind: if kind == "implicitTarget" {
                    "block"
                } else {
                    kind
                }
                .into(),
            },
        );

        if kind == "block"
            && let Some(decorator) = node.decorators().next()
        {
            let field = if syn::Keyframe::cast(node.syntax().clone()).is_some() {
                "easing"
            } else {
                "timing"
            };
            self.mapping(&format!("{path}/{field}/decorator"), &decorator, "block");
            self.mappings.insert(
                format!("{path}/{field}"),
                Mapping {
                    range: decorator.expression_range(),
                    kind: "value".into(),
                },
            );
        }
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

    fn transition(
        &mut self,
        node: &syn::Transition,
        path: &str,
        scope: &expression::Scope,
    ) -> Transition {
        let endpoint = if matches!(node.selector(), Some(syn::TransitionSelector::Enter)) {
            0.0
        } else {
            1.0
        };
        self.mapping(path, node, "block");
        let timing_expression = self.decorator_expression(node, scope, expression::Type::Timing);
        let targets = self.compile_targets(node, path, scope, |compiler, target, path, _, seen| {
            compiler.transition_properties(target, path, scope, seen, endpoint)
        });

        Transition {
            timing: None,
            targets,
            timing_expression,
        }
    }

    fn transition_properties(
        &mut self,
        target: &syn::Block,
        target_path: &str,
        scope: &expression::Scope,
        property_names: &mut BTreeMap<String, Range>,
        endpoint: f64,
    ) -> Vec<PropertyTransition> {
        let mut properties = vec![];

        for item in syn::animation_properties(target) {
            let property = match item {
                syn::AnimationProperty::Keyframes(property) => property,
                syn::AnimationProperty::Shorthand(property) => {
                    if property.is_attachment() {
                        self.error(
                            "semantic.controller",
                            "Controller attachments belong to layer/state styles",
                            &property,
                        );
                        continue;
                    }

                    let offset = endpoint;
                    let name = property.header().unwrap_or_default();
                    self.unique(property_names, &name, &property);
                    let property_path = format!("{target_path}/property/{name}");
                    self.mapping(&property_path, &property, "block");
                    if !liva_syntax::is_property(&name) {
                        self.error("semantic.declaration", "Expected a CSS property", &property);
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
                        timing_expression: self.decorator_expression(
                            &property,
                            scope,
                            expression::Type::Timing,
                        ),
                        name,
                        timing: None,
                        keyframes: Some(vec![Frame {
                            easing_expression: None,
                            offset,
                            value: self.css_value(&property, scope),
                            easing: None,
                        }]),
                    });
                    continue;
                }
            };
            let name = property.header().unwrap_or_default();
            self.unique(property_names, &name, &property);
            let property_path = format!("{target_path}/property/{name}");
            self.mapping(&property_path, &property, "block");
            self.animation_declarations(&property, &property_path);
            let timing_expression =
                self.decorator_expression(&property, scope, expression::Type::Timing);
            let mut frames = vec![];
            let mut offsets = BTreeMap::new();

            for block in property.blocks() {
                self.error(
                    "semantic.structure",
                    "Property tracks contain inline keyframes",
                    &block,
                );
            }

            for frame in property.keyframes() {
                let invalid_attachment = self.reject_frame_attachment(&frame);
                let raw = frame.header().unwrap();
                let offset = raw.trim_end_matches('%').parse::<f64>().unwrap_or(f64::NAN) / 100.0;
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
                let value = frame.value_text().unwrap_or_default();

                if value.is_empty() {
                    self.error("semantic.frame", "Frame requires a value", &value_node);
                }

                self.mapping(&format!("{frame_path}/value"), &value_node, "value");
                let easing_expression =
                    self.decorator_expression(&frame, scope, expression::Type::Easing);

                if invalid_attachment {
                    continue;
                }

                frames.push(Frame {
                    easing_expression: easing_expression.clone(),
                    offset,
                    value: self.css_value(&frame, scope),
                    easing: None,
                });
            }

            frames.sort_by(|a, b| a.offset.total_cmp(&b.offset));
            properties.push(PropertyTransition {
                timing_expression,
                name,
                timing: None,
                keyframes: if frames.is_empty() {
                    None
                } else {
                    Some(frames)
                },
            });
        }

        properties
    }

    fn reject_frame_attachment(&mut self, frame: &syn::Keyframe) -> bool {
        // Keyframe is a specialized view of the same Declaration node as Property.
        let property =
            syn::Property::cast(frame.syntax().clone()).expect("keyframe is a declaration");

        if !property.is_attachment() {
            return false;
        }

        self.error(
            "semantic.controller",
            "Controller attachments belong to layer/state styles",
            frame,
        );

        true
    }

    fn style_properties(
        &mut self,
        target: &syn::Block,
        path: &str,
        scope: &expression::Scope,
        seen: &mut BTreeMap<String, Range>,
        target_name: &str,
        controllers: &mut ControllerScope<'_>,
    ) -> Vec<Property> {
        let mut properties = vec![];
        for item in syn::animation_properties(target) {
            match item {
                syn::AnimationProperty::Shorthand(property) => {
                    let name = property.header().unwrap_or_default();
                    self.unique(seen, &name, &property);

                    if !liva_syntax::is_property(&name) {
                        self.error("semantic.declaration", "Expected a CSS property", &property);
                        continue;
                    }

                    let property_path = format!("{path}/property/{name}");
                    self.mapping(&property_path, &property, "block");
                    if let Some(value) = property.value_node() {
                        self.mapping(&format!("{property_path}/value"), &value, "value");
                        if property.value_text().unwrap_or_default().is_empty() {
                            self.error("semantic.value", "Value must not be empty", &value);
                        }
                    }

                    let binding = property
                        .attachment()
                        .and_then(|expression| {
                            match expression.check(scope).and_then(|value_type| {
                                if matches!(value_type, expression::Type::Controller(_)) {
                                    expression.to_output()
                                } else {
                                    Err(expression.error(":= requires a property controller"))
                                }
                            }) {
                                Ok(output) => Some(output),
                                Err(error) => {
                                    self.expression_error(error);
                                    None
                                }
                            }
                        })
                        .and_then(|binding| {
                            match controllers.bind(binding, target_name, &name, property.range()) {
                                Ok(binding) => Some(binding),
                                Err(diagnostic) => {
                                    self.diagnostics.push(diagnostic);
                                    None
                                }
                            }
                        });

                    let value = if property.is_attachment() {
                        binding.map(|expression| PropertyValue::Binding { expression })
                    } else {
                        Some(self.css_value(&property, scope).into())
                    };
                    let timing_expression =
                        self.decorator_expression(&property, scope, expression::Type::Timing);

                    // Invalid attachments omit IR, but must not suppress independent diagnostics.
                    let Some(value) = value else { continue };

                    properties.push(Property {
                        name,
                        value,
                        timing_expression,
                    });
                }
                syn::AnimationProperty::Keyframes(track) => {
                    let name = track.header().unwrap_or_default();
                    self.unique(seen, &name, &track);
                    let timing_expression =
                        self.decorator_expression(&track, scope, expression::Type::Timing);
                    let track_path = format!("{path}/property/{name}");
                    self.mapping(&track_path, &track, "block");
                    for block in track.blocks() {
                        self.error(
                            "semantic.structure",
                            "Property tracks contain inline keyframes",
                            &block,
                        );
                    }

                    for binding in track.bindings() {
                        self.error(
                            "semantic.structure",
                            "Let declarations belong directly to a motion",
                            &binding,
                        );
                    }

                    self.animation_declarations(&track, &track_path);

                    let mut frames = vec![];
                    let mut offsets = BTreeMap::new();

                    for frame in track.keyframes() {
                        let invalid_attachment = self.reject_frame_attachment(&frame);
                        let offset = frame
                            .header()
                            .unwrap_or_default()
                            .trim_end_matches('%')
                            .parse::<f64>()
                            .unwrap_or(f64::NAN)
                            / 100.0;

                        if !offset.is_finite() || !(0.0..=1.0).contains(&offset) {
                            self.error(
                                "semantic.offset",
                                "Frame offset must be between 0% and 100%",
                                &frame,
                            );
                            continue;
                        }

                        self.unique(&mut offsets, &offset.to_string(), &frame);
                        let frame_path = format!("{track_path}/frame/{offset}");
                        self.mapping(&frame_path, &frame, "block");
                        self.mapping(
                            &format!("{frame_path}/offset"),
                            &frame.header_node().unwrap(),
                            "value",
                        );
                        self.mapping(
                            &format!("{frame_path}/value"),
                            &frame.value_node().unwrap(),
                            "value",
                        );
                        let value = frame.value_text().unwrap_or_default();

                        if value.is_empty() {
                            self.error("semantic.value", "Value must not be empty", &frame);
                        }

                        let easing_expression =
                            self.decorator_expression(&frame, scope, expression::Type::Easing);

                        if invalid_attachment {
                            continue;
                        }

                        frames.push(Frame {
                            offset,
                            value: self.css_value(&frame, scope),
                            easing_expression,
                            easing: None,
                        });
                    }

                    frames.sort_by(|a, b| a.offset.total_cmp(&b.offset));
                    if !frames.iter().any(|frame| frame.offset == 1.0) {
                        self.error("semantic.endpoint", "A style keyframe track requires a 100% destination; use a transition track for implicit destinations", &track);
                        continue;
                    }

                    properties.push(Property {
                        name,
                        value: PropertyValue::Keyframes { frames },
                        timing_expression,
                    });
                }
            }
        }

        properties
    }

    fn motion_scope(
        &mut self,
        node: &syn::Motion,
        parameters: &[MotionParameter],
        bindings: &[BindingView],
    ) -> expression::Scope {
        use expression::{SymbolKind, Type};
        let mut scope = expression::Scope::motion();
        let mut declarations = vec![];

        for parameter in node.parameters() {
            let name = parameter.header().unwrap_or_default();
            let kind = match parameters.iter().find(|item| item.name == name) {
                Some(metadata) => SymbolKind::Value(match metadata.value_type {
                    PrimitiveType::Number => Type::Number,
                    PrimitiveType::Boolean => Type::Boolean,
                    PrimitiveType::String => Type::String,
                }),
                // Invalid declarations still hide parent symbols while editing.
                None => SymbolKind::Pending,
            };
            declarations.push((name, kind, name_range(&parameter)));
        }

        let mut targets = BTreeMap::new();

        for layer in node.layers() {
            for target in layer.targets().chain(
                layer
                    .states()
                    .flat_map(|state| state.targets().collect::<Vec<_>>()),
            ) {
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

            // Root target blocks configure the built-in without declaring a variable.
            if !scope.is_reserved(&name) {
                declarations.push((name, SymbolKind::Value(Type::Target), name_range(&target)));
            }
        }

        declarations.extend(node.bindings().map(|binding| {
            (
                binding.header().unwrap_or_default(),
                SymbolKind::Pending,
                name_range(&binding),
            )
        }));
        declarations.sort_by_key(|(_, _, range)| range.start);

        for (name, kind, range) in declarations {
            if let Err(error) = scope.declare(name, kind, range.clone()) {
                let mut diagnostic = Diagnostic::error(
                    if error.previous.is_some() {
                        "semantic.duplicate"
                    } else {
                        "semantic.variable"
                    },
                    error.message,
                    range,
                );
                diagnostic.related.extend(error.previous);
                self.diagnostics.push(diagnostic);
            }
        }

        let mut by_name = BTreeMap::new();

        for binding in bindings {
            by_name
                .entry(binding.name.clone())
                .or_insert(&binding.initializer);
        }

        for binding in bindings {
            if !matches!(
                scope.local(&binding.name).map(|symbol| symbol.kind),
                Some(SymbolKind::Pending)
            ) {
                continue;
            }

            if let Err(error) =
                infer_let_type(&binding.name, &by_name, &mut scope, &mut BTreeSet::new())
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

    fn style_targets(
        &mut self,
        node: &impl AstNode,
        path: &str,
        scope: &expression::Scope,
        controllers: &mut ControllerScope<'_>,
    ) -> Vec<Target<Property>> {
        self.compile_targets(node, path, scope, |compiler, target, path, name, seen| {
            compiler.style_properties(target, path, scope, seen, name, controllers)
        })
    }

    fn compile_targets<P>(
        &mut self,
        node: &impl AstNode,
        path: &str,
        scope: &expression::Scope,
        mut compile_properties: impl FnMut(
            &mut Self,
            &syn::Block,
            &str,
            &str,
            &mut BTreeMap<String, Range>,
        ) -> Vec<P>,
    ) -> Vec<Target<P>> {
        let mut declarations = vec![];

        if syn::animation_properties(node).next().is_some() {
            declarations.push((
                TargetId::Root,
                TargetOrigin::Implicit,
                syn::Block::cast(node.syntax().clone()).unwrap(),
            ));
        }

        declarations.extend(node.syntax().children().filter_map(|child| {
            let target = syn::Target::cast(child.clone())?;

            Some((
                TargetId::from_name(target.header().unwrap_or_default()),
                TargetOrigin::Explicit,
                syn::Block::cast(child).unwrap(),
            ))
        }));

        let mut targets: Vec<Target<P>> = vec![];
        let mut target_names = BTreeMap::new();
        let mut root_properties = BTreeMap::new();

        for binding in node.children::<syn::LetBinding>() {
            self.error(
                "semantic.structure",
                "Let declarations belong directly to a motion",
                &binding,
            );
        }

        for (id, origin, source) in declarations {
            let name = id.name();

            let target_path = format!("{path}/target/{name}");
            self.mapping(&target_path, &source, origin.mapping_kind());

            let timing = match origin {
                TargetOrigin::Implicit => None,
                TargetOrigin::Explicit => {
                    self.unique(&mut target_names, name, &source);

                    for binding in source.bindings() {
                        self.error(
                            "semantic.structure",
                            "Let declarations belong directly to a motion",
                            &binding,
                        );
                    }

                    self.decorator_expression(&source, scope, expression::Type::Timing)
                }
            };

            let mut named_properties = BTreeMap::new();
            let seen = if id == TargetId::Root {
                &mut root_properties
            } else {
                &mut named_properties
            };
            let properties = compile_properties(self, &source, &target_path, name, seen);
            let timing_properties = if id == TargetId::Root && timing.is_some() {
                Some(
                    syn::animation_properties(&source)
                        .map(|property| match property {
                            syn::AnimationProperty::Shorthand(property) => {
                                property.header().unwrap_or_default()
                            }
                            syn::AnimationProperty::Keyframes(property) => {
                                property.header().unwrap_or_default()
                            }
                        })
                        .collect(),
                )
            } else {
                None
            };

            if id == TargetId::Root
                && let Some(target) = targets.iter_mut().find(|target| target.name == name)
            {
                target.properties.extend(properties);
                target.timing_expression = timing;
                target.timing_properties = timing_properties;
            } else {
                targets.push(Target {
                    name: name.into(),
                    timing_expression: timing,
                    timing_properties,
                    properties,
                });
            }
        }

        targets
    }

    fn definition(&mut self, node: &syn::Motion) -> Definition {
        let name = node.name().unwrap_or_default();
        self.mapping(&name, node, "block");
        self.declarations(node, Some(&[]), &name);
        let bindings = self.let_bindings(node);
        let parameters = self.parameters(node);
        let scope = self.motion_scope(node, &parameters, &bindings);
        let mut controllers = ControllerBindings::default();

        for binding in bindings {
            let value_type = scope.get(&binding.name).and_then(scope::Symbol::value_type);
            let range = binding.initializer.range();
            let initializer = binding
                .initializer
                .to_output()
                .expect("syntax-checked initializer");

            controllers.declare(
                LetBinding {
                    name: binding.name,
                    initializer,
                },
                value_type,
                range,
            );
        }

        let mut definition = Definition {
            name: name.clone(),
            let_bindings: vec![],
            parameters,
            events: vec![],
            enter: None,
            leave: None,
            layers: vec![],
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

        let mut layers = BTreeMap::new();
        let mut transitions = BTreeMap::new();

        for item in node.items() {
            match item {
                syn::MotionItem::Layer(layer) => {
                    let layer_name = layer.name().unwrap();
                    self.unique(&mut layers, &layer_name, &layer);
                    let layer_path = format!("{name}/layer/{layer_name}");
                    self.mapping(&layer_path, &layer, "block");

                    let layer_index = definition.layers.len();
                    let targets = self.style_targets(
                        &layer,
                        &layer_path,
                        &scope,
                        &mut controllers.scope(layer_index, 0),
                    );

                    let condition = layer.condition();
                    let when = condition.and_then(|condition| {
                        let parsed = self.expression_view(&condition)?;

                        match parsed.check(&scope).and_then(|value_type| {
                            if value_type == expression::Type::Boolean {
                                parsed.to_output()
                            } else {
                                Err(parsed.error("Layer condition must be Boolean"))
                            }
                        }) {
                            Ok(expr) => Some(expr),
                            Err(error) => {
                                self.expression_error(error);
                                None
                            }
                        }
                    });

                    let mut layer_states = vec![];
                    let mut state_names = BTreeMap::new();
                    let mut initial_states = vec![];

                    for state in layer.states() {
                        let state_name = state.name().unwrap_or_default();
                        self.unique(&mut state_names, &state_name, &state);
                        let state_path = format!("{layer_path}/state/{state_name}");
                        self.mapping(&state_path, &state, "block");

                        if state.condition().is_some() {
                            self.error(
                                "semantic.layer-state",
                                "Layer states use guarded transitions, not state when conditions",
                                &state,
                            );
                        }

                        if state.is_initial() {
                            initial_states.push(state_name.clone());
                        }

                        let timing_expression = self.decorator_expression(&state, &scope, expression::Type::Timing);
                        let targets = self.style_targets(
                            &state,
                            &state_path,
                            &scope,
                            &mut controllers.scope(layer_index, layer_states.len() + 1),
                        );

                        layer_states.push(State {
                            timing_expression,
                            name: state_name,
                            targets,
                        });
                    }

                    if !layer_states.is_empty() {
                        if layer.condition().is_some() {
                            self.error(
                                "semantic.layer-condition",
                                "Stateful layers are always active; remove when",
                                &layer,
                            );
                        }

                        if initial_states.len() != 1 {
                            self.error(
                                "semantic.initial-state",
                                "Stateful layers require exactly one state marked initial",
                                &layer,
                            );
                        }
                    }

                    // Check each header even when its block contains no transitions.
                    // Reuse the result so several transitions do not duplicate diagnostics.
                    let events: BTreeMap<_, _> = layer.event_blocks().filter_map(|block| {
                        let event = block.event_expression()?;
                        match event.check(&scope).and_then(|ty| {
                            if ty == expression::Type::Event {
                                event.to_output()
                            } else {
                                Err(event.error("on requires an event-typed expression"))
                            }
                        }) {
                            Ok(event) => Some((block.range().start, event)),

                            Err(error) => {
                                self.expression_error(error);

                                None
                            }
                        }
                    }).collect();
                    let mut guarded = vec![];

                    for transition in layer.transitions() {
                        let event = transition
                            .event_block()
                            .and_then(|block| events.get(&block.range().start).cloned());

                        let Some(syn::TransitionSelector::Directional { from, to }) =
                            transition.selector()
                        else {
                            self.error(
                                "semantic.layer-transition",
                                "Layer transitions require source and destination states",
                                &transition,
                            );
                            continue;
                        };

                        for state_name in [&from, &to] {
                            if !state_names.contains_key(state_name) {
                                self.error(
                                    "semantic.reference",
                                    format!("Unknown layer state: {state_name}"),
                                    &transition,
                                );
                            }
                        }

                        let when = if let Some(condition) = transition.condition() {
                            let Some(parsed) = self.expression_view(&condition) else {
                                continue;
                            };

                            match parsed.check(&scope).and_then(|ty| {
                                if ty == expression::Type::Boolean {
                                    parsed.to_output()
                                } else {
                                    Err(parsed.error("Transition guard must be Boolean"))
                                }
                            }) {
                                Ok(when) => when,

                                Err(error) => {
                                    self.expression_error(error);

                                    continue;
                                }
                            }
                        } else if event.is_some() {
                            expression::Expression {
                                kind: expression::ExpressionKind::Boolean { value: true },
                            }
                        } else {
                            self.error(
                                "semantic.layer-transition",
                                "Layer transitions require a Boolean when guard",
                                &transition,
                            );

                            continue;
                        };

                        let path = format!("{layer_path}/transition/{}", guarded.len());
                        let animation = self.transition(&transition, &path, &scope);

                        for target in &animation.targets {
                            for property in &target.properties {
                                let declared = targets
                                    .iter()
                                    .chain(layer_states.iter().flat_map(|state| &state.targets))
                                    .any(|styles| {
                                        styles.name == target.name
                                            && styles
                                                .properties
                                                .iter()
                                                .any(|style| style.name == property.name)
                                    });

                                if !declared {
                                    self.error(
                                        "semantic.reference",
                                        format!(
                                            "Unknown layer animation property: {}.{}",
                                            target.name, property.name
                                        ),
                                        &transition,
                                    );
                                }
                            }
                        }

                        guarded.push(GuardedTransition {
                            event,
                            from,
                            to,
                            when,
                            transition: animation,
                        });
                    }

                    definition.layers.push(Layer {
                        timing_expression: self.decorator_expression(&layer, &scope, expression::Type::Timing),
                        transitions: guarded,
                        states: layer_states,
                        initial_state: initial_states.into_iter().next(),
                        when,
                        name: layer_name,
                        targets,
                    });
                }
                syn::MotionItem::State(state) => {
                    self.error("semantic.state-scope", "Declare states inside a stateful layer, or use an ordinary layer for unconditional styles", &state);
                }
                syn::MotionItem::Transition(transition) => match transition.selector() {
                    Some(
                        selector
                        @ (syn::TransitionSelector::Enter | syn::TransitionSelector::Leave),
                    ) => {
                        let phase = if matches!(selector, syn::TransitionSelector::Enter) {
                            "enter"
                        } else {
                            "leave"
                        };

                        self.unique(&mut transitions, phase, &transition);
                        let value =
                            self.transition(&transition, &format!("{name}/{phase}"), &scope);

                        if phase == "enter" {
                            definition.enter = Some(value);
                        } else {
                            definition.leave = Some(value);
                        }
                    }
                    Some(syn::TransitionSelector::General | syn::TransitionSelector::Directional { .. }) => {
                        self.error("semantic.transition-scope", "Declare guarded transitions inside a stateful layer", &transition);
                    }
                    None => self.error(
                        "semantic.structure",
                        "Expected layer or lifecycle transition; lifecycle blocks use enter { ... } or leave { ... }",
                        &transition,
                    ),
                },
                syn::MotionItem::Invalid(block) => {
                    self.error("semantic.structure", "Expected layer or lifecycle transition", &block)
                }
            }
        }

        let (bindings, diagnostics) = controllers.finish();
        definition.let_bindings = bindings;
        self.diagnostics.extend(diagnostics);

        self.validate_event_structure(node);
        self.validate(&definition, node);
        definition
    }

    fn validate_event_structure(&mut self, node: &syn::Motion) {
        for event in node.syntax().descendants().filter_map(syn::OnBlock::cast) {
            let layer = event.syntax().parent().and_then(syn::Layer::cast);
            if layer.is_none_or(|layer| layer.states().next().is_none()) {
                self.error(
                    "semantic.event",
                    "on blocks belong directly inside a stateful layer",
                    &event,
                );
            }
            if event
                .syntax()
                .children()
                .any(|child| child.kind() != Kind::Header && syn::Transition::cast(child).is_none())
                || event.decorators().next().is_some()
            {
                self.error(
                    "semantic.event",
                    "on blocks contain only layer transitions and accept no decorator",
                    &event,
                );
            }
        }
    }

    fn validate(&mut self, def: &Definition, node: &syn::Motion) {
        if def.layers.is_empty() {
            self.error_range(
                "semantic.layers",
                "Definition needs at least one layer",
                header_range(node),
            );
        }

        for (phase, lifecycle) in [("enter", &def.enter), ("leave", &def.leave)] {
            if let Some(animation) = lifecycle {
                let path = format!("{}/{phase}", def.name);

                for target in &animation.targets {
                    let target_path = format!("{path}/target/{}", target.name);

                    if TargetId::from_name(target.name.clone()) != TargetId::Root
                        && !def
                            .layers
                            .iter()
                            .flat_map(|layer| {
                                layer
                                    .targets
                                    .iter()
                                    .chain(layer.states.iter().flat_map(|state| &state.targets))
                            })
                            .any(|item| item.name == target.name)
                    {
                        self.error_range(
                            "semantic.reference",
                            format!("Unknown lifecycle target: {}", target.name),
                            self.source_header(&target_path),
                        );
                    }
                    for property in &target.properties {
                        let property_path = format!("{target_path}/property/{}", property.name);
                        if property.timing_expression.is_none()
                            && target.timing_expression.is_none()
                            && animation.timing_expression.is_none()
                        {
                            self.error_range(
                                "semantic.timing-missing",
                                "Lifecycle property requires timing",
                                self.source_header(&property_path),
                            );
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
    if let Some(value_type) = scope.local(name).and_then(scope::Symbol::value_type) {
        return Ok(value_type);
    }

    visiting.insert(name.into());
    let binding = bindings[name];
    let result = (|| {
        for (dependency, range) in binding.dependencies() {
            if !bindings.contains_key(&dependency)
                || !matches!(
                    scope.local(&dependency).map(|symbol| symbol.kind),
                    Some(expression::SymbolKind::Pending)
                )
            {
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
        scope.resolve(name, value_type);
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
        schema_version: 2,
        definitions,
        diagnostics: compiler.diagnostics,
        mappings: development.then_some(compiler.mappings),
    }
}
