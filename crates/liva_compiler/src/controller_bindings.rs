use crate::expression::{Expression, ExpressionKind, Name, Type};
use crate::ir::LetBinding;
use liva_syntax::{Diagnostic, Range};
use std::collections::BTreeMap;

#[derive(PartialEq)]
struct AttachmentAddress {
    target: String,
    property: String,
}

// Declaration indices identify controller origins; aliases share their validation state.
enum Origin {
    Declaration(usize),
    Alias(String),
}

/// Owns lowered let declarations and their controller associations for one motion.
/// Register declarations before compiling styles, so aliases may refer forward.
/// Each controller must acquire one static target/property address; repeating that
/// address is allowed. Finish reports unmatched definitions at their originating initializer.
#[derive(Default)]
pub(crate) struct ControllerBindings {
    bindings: Vec<LetBinding>,
    origins: BTreeMap<String, Origin>,
    unmatched: BTreeMap<usize, Range>,
    addresses: BTreeMap<usize, AttachmentAddress>,
}

impl ControllerBindings {
    /// Keeps a lowered let and its inferred controller identity. The range identifies
    /// its initializer when an unmatched originating call must be diagnosed.
    pub(crate) fn declare(&mut self, binding: LetBinding, value_type: Option<&Type>, range: Range) {
        let mut binding = binding;
        if let Some(value_type) = value_type.filter(|_| {
            !self
                .bindings
                .iter()
                .any(|existing| existing.name == binding.name)
        }) {
            self.register(
                &binding.name,
                &mut binding.initializer,
                value_type,
                &range,
                true,
            );
        }
        self.bindings.push(binding);
    }

    // Lift controller calls to ordinary bindings so their lifetime and receiving
    // address use the existing runtime contract. Object aliases retain the same origin.
    fn register(
        &mut self,
        path: &str,
        expression: &mut Expression,
        value_type: &Type,
        range: &Range,
        root: bool,
    ) {
        if matches!(value_type, Type::Controller(_)) {
            let origin = match &expression.kind {
                ExpressionKind::Call { .. } => {
                    let index = self.bindings.len();
                    self.unmatched.insert(index, range.clone());
                    if !root {
                        let name = format!("$object_{path}");
                        let call = std::mem::replace(
                            expression,
                            Expression {
                                kind: ExpressionKind::Reference {
                                    path: vec![Name { text: name.clone() }],
                                },
                            },
                        );
                        self.origins
                            .insert(name.clone(), Origin::Declaration(index));
                        self.bindings.push(LetBinding {
                            name,
                            initializer: call,
                        });
                    }
                    Origin::Declaration(index)
                }
                ExpressionKind::Reference { path } => Origin::Alias(
                    path.iter()
                        .map(|name| name.text.as_str())
                        .collect::<Vec<_>>()
                        .join("."),
                ),
                _ => unreachable!("controller declaration must be a call or alias"),
            };
            self.origins.insert(path.into(), origin);
        } else if let Type::Object(fields) = value_type {
            match &mut expression.kind {
                ExpressionKind::Object { properties } => {
                    for property in properties {
                        if let Some(value_type) = fields.get(&property.name.text) {
                            self.register(
                                &format!("{path}.{}", property.name.text),
                                &mut property.value,
                                value_type,
                                range,
                                false,
                            );
                        }
                    }
                }
                ExpressionKind::Reference { path: reference } => {
                    for (name, value_type) in fields {
                        let mut reference = reference.clone();
                        reference.push(Name { text: name.clone() });
                        self.register(
                            &format!("{path}.{name}"),
                            &mut Expression {
                                kind: ExpressionKind::Reference { path: reference },
                            },
                            value_type,
                            range,
                            false,
                        );
                    }
                }
                _ => {}
            }
        }
    }

    /// Layer indices start at zero. State zero means common layer styles; one and
    /// above identify the layer's states in declaration order.
    pub(crate) fn scope(&mut self, layer: usize, state: usize) -> ControllerScope<'_> {
        ControllerScope {
            bindings: self,
            layer,
            state,
        }
    }

    fn origin(&mut self, name: &str) -> usize {
        let mut current = name.to_owned();
        let mut aliases = vec![];

        // The existing let inference rejects cycles and resolves forward references.
        // Cache every traversed alias, so later attachments do not repeat the chain.
        let origin = loop {
            match &self.origins[&current] {
                Origin::Declaration(index) => break *index,
                Origin::Alias(next) => {
                    let next = next.clone();
                    aliases.push(current);
                    current = next;
                }
            }
        };

        for alias in aliases {
            self.origins.insert(alias, Origin::Declaration(origin));
        }

        origin
    }

    /// Returns completed let IR and one diagnostic per unmatched originating call.
    pub(crate) fn finish(self) -> (Vec<LetBinding>, Vec<Diagnostic>) {
        let diagnostics = self
            .unmatched
            .into_values()
            .map(|range| {
                Diagnostic::error(
                    "semantic.controller",
                    "Controller is not bound to a property",
                    range,
                )
            })
            .collect();

        (self.bindings, diagnostics)
    }
}

/// Associates checked style bindings with their motion registry. Scope indices
/// preserve the stable synthetic names of independently owned inline controllers.
pub(crate) struct ControllerScope<'a> {
    bindings: &'a mut ControllerBindings,
    layer: usize,
    state: usize,
}

impl ControllerScope<'_> {
    /// Lowers a type-checked controller call or whole-value alias to a reference,
    /// assigning its originating call's address immediately. A second distinct
    /// address is rejected at the supplied style-declaration range.
    pub(crate) fn bind(
        &mut self,
        expression: Expression,
        target: &str,
        property: &str,
        range: Range,
    ) -> Result<Expression, Diagnostic> {
        let (origin, expression) = match &expression.kind {
            ExpressionKind::Reference { path } if path.len() == 1 => {
                (self.bindings.origin(&path[0].text), expression)
            }
            ExpressionKind::Reference { path } => {
                let name = path
                    .iter()
                    .map(|name| name.text.as_str())
                    .collect::<Vec<_>>()
                    .join(".");
                let origin = self.bindings.origin(&name);
                let name = self.bindings.bindings[origin].name.clone();
                (
                    origin,
                    Expression {
                        kind: ExpressionKind::Reference {
                            path: vec![Name { text: name }],
                        },
                    },
                )
            }
            ExpressionKind::Call { .. } => {
                let name = format!(
                    "$controller_{}_{}_{target}_{property}",
                    self.layer, self.state
                );
                let origin = self.bindings.bindings.len();
                self.bindings.bindings.push(LetBinding {
                    name: name.clone(),
                    initializer: expression,
                });

                (
                    origin,
                    Expression {
                        kind: ExpressionKind::Reference {
                            path: vec![Name { text: name }],
                        },
                    },
                )
            }
            // The caller has checked the expression's controller type before lowering it.
            _ => unreachable!("controller attachment must be a call or alias"),
        };

        let address = AttachmentAddress {
            target: target.into(),
            property: property.into(),
        };

        // Keep validation state at the originating declaration, so aliases share
        // one address without adding compiler bookkeeping to expression IR.
        if self
            .bindings
            .addresses
            .get(&origin)
            .is_some_and(|previous| previous != &address)
        {
            return Err(Diagnostic::error(
                "semantic.controller",
                "A controller may attach to exactly one target/property address",
                range,
            ));
        }

        self.bindings.addresses.insert(origin, address);
        self.bindings.unmatched.remove(&origin);

        Ok(expression)
    }
}
