//! Locate top-level SFC custom blocks without treating script strings as tags.
pub fn blocks(text: &str) -> Vec<std::ops::Range<usize>> {
    let mut blocks = vec![];
    let mut cursor = 0;
    let mut depth = 0usize;

    while let Some(relative) = text[cursor..].find('<') {
        let start = cursor + relative;

        if text[start..].starts_with("<!--") {
            cursor = text[start + 4..]
                .find("-->")
                .map_or(text.len(), |end| start + 4 + end + 3);
            continue;
        }

        let Some(end) = tag_end(text, start) else {
            break;
        };
        let tag = &text[start + 1..end];
        let closing = tag.starts_with('/');
        let name = tag
            .trim_start_matches('/')
            .split(|c: char| c.is_whitespace() || c == '/')
            .next()
            .unwrap_or("");
        cursor = end + 1;

        if closing {
            depth = depth.saturating_sub(1);
        } else if depth == 0 && matches!(name, "script" | "style" | "liva") && !tag.ends_with('/') {
            let closing = format!("</{name}>");
            let content_end = text[cursor..]
                .find(&closing)
                .map_or(text.len(), |relative| cursor + relative);

            if name == "liva" {
                blocks.push(cursor..content_end);
            }

            cursor = (content_end + closing.len()).min(text.len());
        } else if !tag.ends_with('/')
            && !matches!(
                name,
                "area"
                    | "base"
                    | "br"
                    | "col"
                    | "embed"
                    | "hr"
                    | "img"
                    | "input"
                    | "link"
                    | "meta"
                    | "param"
                    | "source"
                    | "track"
                    | "wbr"
            )
        {
            depth += 1;
        }
    }

    blocks
}

fn tag_end(text: &str, start: usize) -> Option<usize> {
    let mut quote = None;

    for (relative, c) in text[start + 1..].char_indices() {
        if let Some(current) = quote {
            if c == current {
                quote = None;
            }
        } else if matches!(c, '\'' | '"') {
            quote = Some(c);
        } else if c == '>' {
            return Some(start + 1 + relative);
        }
    }

    None
}
