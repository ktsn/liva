use crate::{Compilation, Mapping, compile};
use liva_syntax::ast::{AstNode, HasItems, HasValue};
use liva_syntax::{is_name, is_property, semantic_text};
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
pub enum Edit {
    Track {
        path: String,
        timing: Option<String>,
        frames: Option<Vec<FrameEdit>>,
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
    Override {
        definition: String,
        from: String,
        to: String,
        target: String,
        property: String,
        timing: String,
    },
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FrameEdit {
    pub offset: f64,
    pub value: String,
    pub easing: Option<String>,
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
        let inserted = body
            .lines()
            .map(|line| format!("{prefix}{unit}{line}{newline}"))
            .collect::<String>();
        result.insert_str(line_start, &inserted);
    } else {
        // Existing compact blocks stay compact. A newline terminates declarations
        // before the inserted block without rewriting existing separators.
        let newline = if source.contains("\r\n") {
            "\r\n"
        } else {
            "\n"
        };
        let body = body.replace("\r\n", "\n").replace('\n', newline);
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
        result.insert_str(field.range.end, &format!(" @ {}", value.trim()));
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

fn safe_value(value: &str) -> Result<(), String> {
    preserve_comments(value)?;
    let parsed = liva_syntax::parse(&format!("motion t {{ value: {value}\n}}"));
    let block = parsed.root.motions().next().ok_or("Invalid field value")?;
    let fields: Vec<_> = block.properties().collect();
    if !parsed.diagnostics.is_empty()
        || parsed.root.syntax().children().count() != 1
        || block.blocks().next().is_some()
        || fields.len() != 1
        || fields[0].value_text().as_deref() != Some(semantic_text(value).as_str())
        || semantic_text(value).is_empty()
    {
        return Err("Track fields must contain exactly one value".into());
    }
    Ok(())
}

fn animation_shorthand(timing: &str) -> Result<(&str, &str), String> {
    preserve_comments(timing)?;
    let (name, value) = timing
        .split_once(':')
        .ok_or("Expected animation declaration")?;

    if !["@tween", "@spring"].contains(&name) {
        return Err("Expected tween or spring shorthand".into());
    }

    safe_value(value)?;
    Ok((name, value.trim()))
}

// Track replacement is atomic: changing timing and frames together may have an
// invalid intermediate state (for example, switching a keyed tween to a spring).
fn replace_track(
    source: &str,
    compiled: &Compilation,
    path: &str,
    timing: &Option<String>,
    frames: &Option<Vec<FrameEdit>>,
) -> Result<String, String> {
    let parts: Vec<_> = path.split('/').collect();
    let (definition, transition, target, property) = match parts.as_slice() {
        [d, "transition", "general", "target", t, "property", p] => {
            (*d, "transition".to_string(), *t, *p)
        }
        [
            d,
            "transition",
            "directional",
            from,
            to,
            "target",
            t,
            "property",
            p,
        ] if is_name(from) && is_name(to) => (*d, format!("transition {from} -> {to}"), *t, *p),
        [d, phase, "target", t, "property", p] if matches!(*phase, "enter" | "leave") => {
            (*d, phase.to_string(), *t, *p)
        }
        [d, phase, state, "target", t, "property", p]
            if matches!(*phase, "enter" | "leave") && is_name(state) =>
        {
            (*d, format!("{phase} {state}"), *t, *p)
        }
        _ => return Err("Invalid property track path".into()),
    };

    if !is_name(definition) || !is_name(target) || !is_property(property) {
        return Err("Invalid track identifiers".into());
    }

    let mut prefix = "__LIVA_TRACK_VALUE_".to_string();
    let inputs: Vec<&str> =
        timing
            .iter()
            .map(String::as_str)
            .chain(frames.iter().flatten().flat_map(|frame| {
                std::iter::once(frame.value.as_str()).chain(frame.easing.as_deref())
            }))
            .collect();
    while source.contains(&prefix) || inputs.iter().any(|value| value.contains(&prefix)) {
        prefix.push('_');
    }
    let mut values = Vec::new();
    let mut placeholder = |value: &str| {
        let token = format!("{prefix}{}__", values.len());
        values.push((token.clone(), value.to_string()));
        token
    };
    let mut declarations = Vec::new();

    if let Some(timing) = timing {
        let (name, value) = animation_shorthand(timing)?;
        declarations.push(format!("{name}: {}", placeholder(value)));
    }

    if let Some(frames) = frames {
        if frames.len() > 100 {
            return Err("At most 100 keyframes per track".into());
        }
        for frame in frames {
            if !frame.offset.is_finite() || !(0.0..=1.0).contains(&frame.offset) {
                return Err("Offset must be between 0 and 1".into());
            }
            safe_value(&frame.value)?;
            let easing = if let Some(easing) = &frame.easing {
                safe_value(easing)?;
                format!(" @ {}", placeholder(easing))
            } else {
                String::new()
            };
            declarations.push(format!(
                "{}%: {}{easing}",
                frame.offset * 100.0,
                placeholder(&frame.value)
            ));
        }
    }

    let restore_values = |mut result: String| {
        let newline = if source.contains("\r\n") {
            "\r\n"
        } else {
            "\n"
        };
        for (token, value) in &values {
            result = result.replace(token, &value.replace("\r\n", "\n").replace('\n', newline));
        }
        result
    };
    let body = format!("{property} {{\n{}\n}}", indent(&declarations.join("\n")));
    if let Ok(existing) = mapping(compiled, path, "block") {
        preserve_comments(&source[existing.range.start..existing.range.end])?;
        let mut result = source.to_string();
        let line = source[..existing.range.start]
            .rsplit('\n')
            .next()
            .unwrap_or("");
        let prefix: String = line
            .chars()
            .take_while(|c| *c == ' ' || *c == '\t')
            .collect();
        let newline = if source.contains("\r\n") {
            "\r\n"
        } else {
            "\n"
        };
        let replacement = if declarations.is_empty() {
            String::new()
        } else {
            body.replace('\n', &format!("{newline}{prefix}"))
        };
        result.replace_range(existing.range.start..existing.range.end, &replacement);
        return Ok(restore_values(result));
    }

    if declarations.is_empty() {
        return Ok(source.to_string());
    }
    let (target_path, _) = path.rsplit_once("/property/").unwrap();
    let (transition_path, _) = target_path.rsplit_once("/target/").unwrap();
    let (parent, body) = if mapping(compiled, target_path, "block").is_ok() {
        (target_path, body)
    } else {
        let body = format!("{target} {{\n{}\n}}", indent(&body));
        if mapping(compiled, transition_path, "block").is_ok() {
            (transition_path, body)
        } else {
            (
                definition,
                format!("{transition} {{\n{}\n}}", indent(&body)),
            )
        }
    };
    insert(source, mapping(compiled, parent, "block")?, &body).map(restore_values)
}

pub fn apply_edits(source: &str, edits: &[Edit]) -> Result<EditResult, String> {
    if edits.len() > 100 {
        return Err("At most 100 edits per transaction".into());
    }
    let mut current = source.to_string();
    let mut compiled = compile(&current, true);
    check(&compiled)?;

    for edit in edits {
        current = match edit {
            Edit::Track {
                path,
                timing,
                frames,
            } => replace_track(&current, &compiled, path, timing, frames)?,
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
                    easing.as_ref().map_or(String::new(), |e| format!(" @ {e}"))
                );
                let result = insert(&current, mapping(&compiled, path, "block")?, &body)?;
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
            Edit::Override {
                definition,
                from,
                to,
                target,
                property,
                timing,
            } => {
                preserve_comments(timing)?;
                if ![definition, from, to, target]
                    .iter()
                    .all(|name| is_name(name))
                    || !is_property(property)
                {
                    return Err("Invalid override identifiers".into());
                }
                let direction = format!("{definition}/transition/directional/{from}/{to}");
                let target_path = format!("{direction}/target/{target}");
                let property_path = format!("{target_path}/property/{property}");
                let (name, value) = animation_shorthand(timing)?;
                let declaration = format!("{name}: {value}");
                let mut body = format!("{property} {{\n  {declaration}\n}}");
                let parent = if mapping(&compiled, &property_path, "block").is_ok() {
                    body = declaration;
                    property_path
                } else if mapping(&compiled, &target_path, "block").is_ok() {
                    target_path
                } else {
                    body = format!("{target} {{\n{}\n}}", indent(&body));

                    if mapping(&compiled, &direction, "block").is_ok() {
                        direction
                    } else {
                        body = format!("transition {from} -> {to} {{\n{}\n}}", indent(&body));
                        definition.clone()
                    }
                };

                insert(&current, mapping(&compiled, &parent, "block")?, &body)?
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

fn indent(text: &str) -> String {
    text.lines()
        .map(|line| format!("  {line}"))
        .collect::<Vec<_>>()
        .join("\n")
}
