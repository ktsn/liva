use crate::ir::LayoutAxes;

// One table owns aliases and physical [x, y, width, height] masks for compilation and completion.
pub(crate) const KEYWORDS: &[(&str, [bool; 4])] = &[
    ("none", [false, false, false, false]),
    ("position", [true, true, false, false]),
    ("size", [false, false, true, true]),
    ("x", [true, false, false, false]),
    ("y", [false, true, false, false]),
    ("width", [false, false, true, false]),
    ("height", [false, false, false, true]),
];

pub(crate) fn parse_selection(selection: &str) -> Result<LayoutAxes, &'static str> {
    let words: Vec<_> = selection.split_whitespace().collect();

    if words.is_empty() || (words.contains(&"none") && words.len() != 1) {
        return Err("$layout requires fixed axes or none by itself");
    }

    let mut axes = [false; 4];

    for word in words {
        let Some((_, selected)) = KEYWORDS.iter().find(|(name, _)| *name == word) else {
            return Err(
                "$layout accepts only position, size, x, y, width, height, or none; use layers/states for dynamic selection",
            );
        };

        for (axis, selected) in axes.iter_mut().zip(selected) {
            if *axis && *selected {
                return Err("Duplicate $layout axis, including overlapping aliases");
            }

            *axis |= selected;
        }
    }

    let [x, y, width, height] = axes;

    Ok(LayoutAxes {
        x,
        y,
        width,
        height,
    })
}
