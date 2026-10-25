use crate::{Compilation, Mapping, compile};
use liva_syntax::{is_name, is_property, semantic_text};
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
pub enum Edit {
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
        let (parent, name) = path.rsplit_once('/').ok_or("Invalid field path")?;
        if !["timing", "value", "easing"].contains(&name) {
            return Err("Only timing, value, or easing declarations can be inserted".into());
        }
        result = insert(
            source,
            mapping(compiled, parent, "block")?,
            &format!("{name}: {}", value.trim()),
        )?;
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

pub fn apply_edits(source: &str, edits: &[Edit]) -> Result<EditResult, String> {
    if edits.len() > 100 {
        return Err("At most 100 edits per transaction".into());
    }
    let mut current = source.to_string();
    let mut compiled = compile(&current, true);
    check(&compiled)?;

    for edit in edits {
        current = match edit {
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
                    "{}% {{\n  value: {}{}\n}}",
                    offset * 100.0,
                    value,
                    easing
                        .as_ref()
                        .map_or(String::new(), |e| format!("\n  easing: {e}"))
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
                if mapping(&compiled, &property_path, "block").is_ok() {
                    set(
                        &current,
                        &compiled,
                        &format!("{property_path}/timing"),
                        timing,
                    )?
                } else {
                    let mut body = format!("{property} {{\n  timing: {timing}\n}}");
                    let parent = if mapping(&compiled, &target_path, "block").is_ok() {
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
                    let result = insert(&current, mapping(&compiled, &parent, "block")?, &body)?;
                    let updated = compile(&result, true);
                    check(&updated)?;
                    let field = mapping(&updated, &format!("{property_path}/timing"), "value")?;
                    if semantic_text(&result[field.range.start..field.range.end])
                        != semantic_text(timing)
                    {
                        return Err("Timing contains extra declarations".into());
                    }
                    result
                }
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
