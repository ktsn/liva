use crate::{Compilation, Mapping, compile};
use liva_syntax::ast::{AstNode, HasHeader, HasValue};
use liva_syntax::semantic_text;
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
pub enum Edit {
    Easing {
        path: String,
        value: Option<String>,
    },
    Timing {
        path: String,
        value: Option<String>,
    },
    Set {
        path: String,
        value: String,
    },
    RemoveFrame {
        path: String,
    },
    AddFrame {
        path: String,
        offset: f64,
        value: String,
        easing: Option<String>,
    },
}

#[derive(Debug, Serialize)]
pub struct EditResult {
    pub source: String,
    pub compilation: Compilation,
}

fn mapping<'a>(compiled: &'a Compilation, path: &str, kind: &str) -> Result<&'a Mapping, String> {
    compiled
        .mappings
        .as_ref()
        .and_then(|m| m.get(path))
        .filter(|m| m.kind == kind)
        .ok_or_else(|| format!("Unknown editable {kind}: {path}"))
}

fn check(compiled: &Compilation) -> Result<(), String> {
    if let Some(error) = compiled.diagnostics.iter().find(|d| d.severity == "error") {
        return Err(error.message.clone());
    }
    Ok(())
}

fn preserve_comments(text: &str) -> Result<(), String> {
    if liva_syntax::contains_comments(text) {
        return Err(
            "This field contains comments; edit it in source to preserve comment placement".into(),
        );
    }
    Ok(())
}

fn insert(source: &str, parent: &Mapping, body: &str) -> Result<String, String> {
    let end = parent
        .range
        .end
        .checked_sub(1)
        .ok_or("Incomplete parent block")?;
    if source.get(end..parent.range.end) != Some("}") {
        return Err("Incomplete parent block".into());
    }
    let line_start = source[..end].rfind('\n').map_or(0, |i| i + 1);
    let prefix = &source[line_start..end];
    let mut result = source.to_string();

    if prefix.chars().all(|c| c == ' ' || c == '\t') {
        let newline = if source.contains("\r\n") {
            "\r\n"
        } else {
            "\n"
        };
        let unit = if prefix.contains('\t') { "\t" } else { "  " };
        // Continuation lines may belong to quoted CSS values; preserve them verbatim.
        let inserted = format!("{prefix}{unit}{body}{newline}");
        result.insert_str(line_start, &inserted);
    } else {
        // Existing compact blocks stay compact. A newline terminates declarations
        // before the inserted block without rewriting existing separators.
        let newline = if source.contains("\r\n") {
            "\r\n"
        } else {
            "\n"
        };
        result.insert_str(end, &format!("{newline}{body}{newline}"));
    }

    Ok(result)
}

fn set(source: &str, compiled: &Compilation, path: &str, value: &str) -> Result<String, String> {
    preserve_comments(value)?;
    let mut result = source.to_string();

    if let Ok(field) = mapping(compiled, path, "value") {
        let old = &source[field.range.start..field.range.end];
        preserve_comments(old)?;
        let leading = old.len() - old.trim_start().len();
        let trailing = old.len() - old.trim_end().len();
        result.replace_range(
            field.range.start + leading..field.range.end - trailing,
            value.trim(),
        );
    } else {
        let frame_path = path
            .strip_suffix("/easing")
            .ok_or("Unknown editable field")?;
        let field = mapping(compiled, &format!("{frame_path}/value"), "value")?;
        preserve_comments(&source[field.range.start..field.range.end])?;
        preserve_comments(value)?;
        result.insert_str(field.range.end, &format!(" @{}", value.trim()));
    }

    let updated = compile(&result, true);
    check(&updated)?;
    let updated_path = if let Some(frame) = path.strip_suffix("/offset") {
        let (parent, _) = frame
            .rsplit_once("/frame/")
            .ok_or("Invalid frame offset path")?;
        let offset = value
            .trim()
            .strip_suffix('%')
            .and_then(|v| v.parse::<f64>().ok())
            .ok_or("Expected a percentage")?
            / 100.0;
        format!("{parent}/frame/{offset}/offset")
    } else {
        path.to_string()
    };
    let actual = mapping(&updated, &updated_path, "value")?;
    if semantic_text(&result[actual.range.start..actual.range.end]) != semantic_text(value) {
        return Err(
            "A field edit must contain exactly one value, not additional declarations".into(),
        );
    }
    Ok(result)
}

fn typed_destination(compiled: &Compilation, path: &str) -> Result<(String, String), String> {
    let parts: Vec<_> = path.split('/').collect();

    if let [
        name,
        phase @ ("enter" | "leave"),
        "target",
        target,
        "property",
        property,
    ] = parts.as_slice()
    {
        let definition = compiled
            .definitions
            .iter()
            .find(|item| item.name == *name)
            .ok_or("Unknown motion")?;
        let declared = definition
            .layers
            .iter()
            .flat_map(|layer| {
                layer
                    .targets
                    .iter()
                    .chain(layer.states.iter().flat_map(|state| &state.targets))
            })
            .any(|item| {
                item.name == *target && item.properties.iter().any(|item| item.name == *property)
            });

        if !declared {
            return Err("Cannot add an undeclared CSS property".into());
        }

        return Ok((format!("{name}/{phase}"), (*target).into()));
    }

    let (definition_name, layer_name, transition_index, target_name, property_name) =
        match parts.as_slice() {
            [
                definition,
                "layer",
                layer,
                "transition",
                index,
                "target",
                target,
                "property",
                property,
            ] => (*definition, *layer, *index, *target, *property),
            _ => return Err("Select an existing layer transition for this property".into()),
        };
    let definition = compiled
        .definitions
        .iter()
        .find(|item| item.name == definition_name)
        .ok_or("Unknown motion")?;
    let layer = definition
        .layers
        .iter()
        .find(|item| item.name == layer_name)
        .ok_or("Unknown layer")?;
    let index: usize = transition_index
        .parse()
        .map_err(|_| "Invalid transition declaration identity")?;
    layer
        .transitions
        .get(index)
        .ok_or("Unknown transition declaration identity")?;
    let declared = layer
        .targets
        .iter()
        .chain(layer.states.iter().flat_map(|state| &state.targets))
        .any(|target| {
            target.name == target_name
                && target
                    .properties
                    .iter()
                    .any(|property| property.name == property_name)
        });

    if !declared {
        return Err("Cannot add an undeclared CSS property".into());
    }

    Ok((
        format!("{definition_name}/layer/{layer_name}/transition/{index}"),
        target_name.into(),
    ))
}

fn ensure_typed_property(
    source: &str,
    compiled: &Compilation,
    path: &str,
) -> Result<String, String> {
    if mapping(compiled, path, "block").is_ok() {
        return Ok(source.into());
    }

    let (transition_path, target_name) = typed_destination(compiled, path)?;
    let (target_path, property_name) = path
        .rsplit_once("/property/")
        .ok_or("Invalid property path")?;
    let property = format!("{property_name} ~> {{}}");

    if let Ok(target) = mapping(compiled, target_path, "block") {
        return insert(source, target, &property);
    }

    let target = match crate::target::TargetId::from_name(target_name) {
        crate::target::TargetId::Root => property,
        crate::target::TargetId::Named(name) => format!("{name} {{ {property} }}"),
    };

    if mapping(compiled, &transition_path, "block").is_err() {
        let (name, phase) = transition_path
            .split_once('/')
            .ok_or("Invalid lifecycle path")?;
        return insert(
            source,
            mapping(compiled, name, "block")?,
            &format!("{phase} {{ {target} }}"),
        );
    }

    let transition = mapping(compiled, &transition_path, "block")?;

    if source[transition.range.start..transition.range.end]
        .trim_end()
        .ends_with('}')
    {
        insert(source, transition, &target)
    } else {
        let mut result = source.to_string();
        result.insert_str(transition.range.end, &format!(" {{ {target} }}"));
        Ok(result)
    }
}

fn property_syntax(source: &str, field: &Mapping) -> Result<liva_syntax::SyntaxNode, String> {
    liva_syntax::parse(source)
        .root
        .syntax()
        .descendants()
        .find(|node| node.range() == field.range)
        .ok_or_else(|| "Unknown property declaration".into())
}

fn structural_decorator(source: &str, offset: usize, expression: &str) -> String {
    let newline = if source.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let line_start = source[..offset].rfind('\n').map_or(0, |index| index + 1);
    let preceding = &source[line_start..offset];
    let indentation: String = preceding
        .chars()
        .take_while(|character| matches!(character, ' ' | '\t'))
        .collect();

    let leading = if preceding.trim().is_empty() {
        String::new()
    } else {
        format!("{newline}{indentation}")
    };

    format!("{leading}@{}{newline}{indentation}", expression.trim())
}

fn edit_typed_timing(
    source: &str,
    compiled: &Compilation,
    path: &str,
    value: Option<&str>,
) -> Result<String, String> {
    if !path.contains("/property/") || path.contains("/frame/") {
        return Err("Timing overrides belong to a property".into());
    }

    let prepared = if value.is_some() {
        ensure_typed_property(source, compiled, path)?
    } else {
        source.into()
    };
    let current = compile(&prepared, true);
    let field = mapping(&current, path, "block")?;
    let node = property_syntax(&prepared, field)?;

    if liva_syntax::ast::Property::cast(node.clone())
        .is_some_and(|property| property.is_attachment())
    {
        return Err("Controller attachments are source-owned expressions".into());
    }
    let mut result = prepared.clone();

    let decorator = node.decorators().next();

    match (decorator, value) {
        (Some(decorator), Some(value)) => {
            preserve_comments(&decorator.text())?;
            preserve_comments(value)?;
            let range = decorator.expression_range();
            result.replace_range(range.start..range.end, value.trim());
        }
        (Some(decorator), None) => {
            preserve_comments(&decorator.text())?;
            let range = decorator.range();
            result.replace_range(range.start..range.end, "");
        }
        (None, Some(value)) => {
            preserve_comments(value)?;
            if let Some(property) = liva_syntax::ast::Property::cast(node.clone()) {
                let boundary = property
                    .value_node()
                    .ok_or("Missing property value")?
                    .range();
                let end = boundary.end
                    - (prepared[boundary.start..boundary.end].len()
                        - prepared[boundary.start..boundary.end].trim_end().len());
                result.insert_str(end, &format!(" @{}", value.trim()));
            } else {
                result.insert_str(
                    field.range.start,
                    &structural_decorator(&prepared, field.range.start, value),
                );
            }
        }
        (None, None) => return Err("This property has no local timing override".into()),
    }

    let updated = compile(&result, true);
    check(&updated)?;

    if let Some(value) = value {
        let actual = mapping(&updated, &format!("{path}/timing"), "value")?;
        if semantic_text(&result[actual.range.start..actual.range.end]) != semantic_text(value) {
            return Err("A timing edit must contain one expression".into());
        }
    }

    Ok(result)
}

fn prepare_typed_track(source: &str, compiled: &Compilation, path: &str) -> Result<String, String> {
    let prepared = ensure_typed_property(source, compiled, path)?;
    let current = compile(&prepared, true);
    check(&current)?;
    let field = mapping(&current, path, "block")?;
    let node = property_syntax(&prepared, field)?;

    if liva_syntax::ast::Property::cast(node.clone())
        .is_some_and(|property| property.is_attachment())
    {
        return Err("Controller attachments are source-owned expressions".into());
    }

    if node.kind() == liva_syntax::Kind::Block {
        return Ok(prepared);
    }

    if path.contains("/state/") {
        return Err(
            "Select an existing transition instead of converting a state declaration to a track"
                .into(),
        );
    }

    preserve_comments(&node.text().to_string())?;
    let property =
        liva_syntax::ast::Property::cast(node).ok_or("Expected a property declaration")?;
    let name = property.header().ok_or("Missing property name")?;
    let value = property.value_text().ok_or("Missing property value")?;
    let timing = property
        .decorators()
        .next()
        .map(|decorator| {
            structural_decorator(&prepared, field.range.start, &decorator.expression_text())
        })
        .unwrap_or_default();
    let endpoint = if path.contains("/enter/") { 0 } else { 100 };
    let body = format!("{timing}{name} ~> {{ {endpoint}%: {value} }}");
    let mut result = prepared;
    result.replace_range(field.range.start..field.range.end, &body);
    Ok(result)
}

pub fn apply_edits(source: &str, edits: &[Edit]) -> Result<EditResult, String> {
    if edits.len() > 100 {
        return Err("At most 100 edits per transaction".into());
    }
    let mut current = source.to_string();
    let mut compiled = compile(&current, true);
    check(&compiled)?;

    for edit in edits {
        let frame_path = match edit {
            Edit::Set { path, .. } | Edit::Easing { path, .. } | Edit::RemoveFrame { path } => {
                path.rsplit_once("/frame/").map(|(track, _)| track)
            }
            _ => None,
        };

        if let Some(path) = frame_path {
            current = prepare_typed_track(&current, &compiled, path)?;
            compiled = compile(&current, true);
            check(&compiled)?;
        }

        current = match edit {
            Edit::Easing { path, value } => {
                let frame = mapping(&compiled, path, "block")?;
                if !path.contains("/frame/")
                    || property_syntax(&current, frame)?.kind() != liva_syntax::Kind::Declaration
                {
                    return Err("Segment easing belongs to a keyframe".into());
                }

                if let Some(value) = value {
                    set(&current, &compiled, &format!("{path}/easing"), value)?
                } else if let Ok(decorator) =
                    mapping(&compiled, &format!("{path}/easing/decorator"), "block")
                {
                    preserve_comments(&current[decorator.range.start..decorator.range.end])?;
                    let mut result = current.clone();
                    result.replace_range(decorator.range.start..decorator.range.end, "");
                    result
                } else {
                    current.clone()
                }
            }
            Edit::Timing { path, value } => {
                edit_typed_timing(&current, &compiled, path, value.as_deref())?
            }
            Edit::Set { path, value } => set(&current, &compiled, path, value)?,
            Edit::RemoveFrame { path } => {
                if path
                    .rsplit_once("/frame/")
                    .is_none_or(|(_, offset)| offset.contains('/'))
                {
                    return Err("Only whole keyframes can be removed".into());
                }
                let frame = mapping(&compiled, path, "block")?;
                preserve_comments(&current[frame.range.start..frame.range.end])?;
                let mut result = current.clone();
                result.replace_range(frame.range.start..frame.range.end, "");
                result
            }
            Edit::AddFrame {
                path,
                offset,
                value,
                easing,
            } => {
                preserve_comments(value)?;
                if let Some(easing) = easing {
                    preserve_comments(easing)?;
                }
                if !offset.is_finite() || !(0.0..=1.0).contains(offset) {
                    return Err("Offset must be between 0 and 1".into());
                }
                if !path.contains("/property/") || path.contains("/frame/") {
                    return Err("Frames must belong to a property track".into());
                }
                let body = format!(
                    "{}%: {}{}",
                    offset * 100.0,
                    value,
                    easing.as_ref().map_or(String::new(), |e| format!(" @{e}"))
                );
                let prepared = prepare_typed_track(&current, &compiled, path)?;
                let prepared_compilation = compile(&prepared, true);
                check(&prepared_compilation)?;
                let result = insert(
                    &prepared,
                    mapping(&prepared_compilation, path, "block")?,
                    &body,
                )?;
                let updated = compile(&result, true);
                check(&updated)?;
                let normalized = (offset * 100.0) / 100.0;
                let frame_path = format!("{path}/frame/{normalized}");
                let field = mapping(&updated, &format!("{frame_path}/value"), "value")?;
                if semantic_text(&result[field.range.start..field.range.end])
                    != semantic_text(value)
                {
                    return Err("Frame value contains extra declarations".into());
                }
                if let Some(easing) = easing {
                    let field = mapping(&updated, &format!("{frame_path}/easing"), "value")?;
                    if semantic_text(&result[field.range.start..field.range.end])
                        != semantic_text(easing)
                    {
                        return Err("Frame easing contains extra declarations".into());
                    }
                }
                result
            }
        };
        compiled = compile(&current, true);
        check(&compiled)?;
    }

    Ok(EditResult {
        source: current,
        compilation: compiled,
    })
}
