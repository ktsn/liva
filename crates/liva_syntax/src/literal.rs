pub(crate) fn string_value(text: &str) -> Result<String, String> {
    if text.len() < 2 || !text.ends_with(text.chars().next().unwrap()) {
        return Err("Unclosed expression string".into());
    }
    let mut value = String::new();
    let mut chars = text[1..text.len() - 1].chars();

    while let Some(c) = chars.next() {
        value.push(if c == '\\' {
            match chars.next().ok_or("Invalid string escape")? {
                'n' => '\n',
                'r' => '\r',
                't' => '\t',
                '\\' => '\\',
                '\'' => '\'',
                '"' => '"',
                _ => return Err("Unsupported string escape".into()),
            }
        } else {
            c
        });
    }
    Ok(value)
}

// Return the end of a quoted spelling without interpreting its escapes.
pub(crate) fn quoted_end(text: &str) -> Option<usize> {
    let quote = text.chars().next()?;
    let mut chars = text.char_indices().skip(1);
    while let Some((offset, c)) = chars.next() {
        if c == '\\' {
            chars.next();
        } else if c == quote {
            return Some(offset + c.len_utf8());
        }
    }
    None
}

/// Encode a decoded value as a double-quoted Liva string spelling.
/// Uses only escapes accepted by the decoder; other characters are preserved
/// verbatim, including control characters for which Liva defines no escape syntax.
pub fn quote_string(value: &str) -> String {
    let mut result = String::from("\"");

    for character in value.chars() {
        match character {
            '\n' => result.push_str("\\n"),
            '\r' => result.push_str("\\r"),
            '\t' => result.push_str("\\t"),
            '\\' => result.push_str("\\\\"),
            '"' => result.push_str("\\\""),
            _ => result.push(character),
        }
    }

    result.push('"');

    result
}
