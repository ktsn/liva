(keyword) @keyword
["motion" "layer" "state" "initial" "when" "transition"] @keyword
(type) @type
(boolean) @boolean
(identifier) @variable
((identifier) @variable.builtin
  (#eq? @variable.builtin "self"))
(property name: (identifier) @property)
(property_track name: (_) @property)
["~>" ":="] @operator
(call function: (identifier) @function)
(selector_block name: (_) @type @selector.class)
(number) @number
(string) @string
(comment) @comment
(animation) @attribute
(operator) @operator
(punctuation) @punctuation.delimiter
(css_token) @string.special
["{" "}" "(" ")" "[" "]"] @punctuation.bracket
(interpolation ["${" "}"] @punctuation.special)
((punctuation) @attribute
  (#eq? @attribute "@"))

(selector_block name: (identifier) @variable.builtin
  (#eq? @variable.builtin "self"))
