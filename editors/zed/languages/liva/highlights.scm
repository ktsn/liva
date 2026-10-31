(keyword) @keyword
["motion" "state" "when" "transition"] @keyword
(type) @type
(boolean) @boolean
(identifier) @variable
(property name: (identifier) @property)
(call function: (identifier) @function)
(selector_block name: (_) @type @selector.class)
(number) @number
(string) @string
(comment) @comment
(animation) @attribute
(operator) @operator
(punctuation) @punctuation.delimiter
(css_token) @string.special
(selector_block
  (block
    (selector_block name: (_) @property)))
["{" "}" "(" ")" "[" "]"] @punctuation.bracket
(interpolation ["${" "}"] @punctuation.special)
((punctuation) @attribute
  (#eq? @attribute "@"))
