/* eslint-disable no-underscore-dangle -- Tree-sitter uses leading underscores for hidden rules. */

module.exports = grammar({
  name: 'liva',
  extras: ($) => [/\s/, $.comment],
  word: ($) => $.identifier,
  rules: {
    source_file: ($) => repeat($._item),
    _item: ($) =>
      choice($.motion, $.layer, $.state, $.transition, $.selector_block, $.block, $._header_item),
    _header_item: ($) =>
      choice(
        $.call,
        $.parenthesized,
        $.bracketed,
        $.interpolation,
        $.keyword,
        $.type,
        $.boolean,
        $.property,
        $.identifier,
        $.number,
        $.string,
        $.animation,
        $.operator,
        $.punctuation,
        $.css_token,
      ),
    motion: ($) => seq('motion', field('name', $.identifier), optional($.parenthesized), $.block),
    state: ($) =>
      seq(
        'state',
        field('name', $.identifier),
        optional('initial'),
        optional(seq('when', repeat1($._header_item))),
        $.block,
      ),
    layer: ($) =>
      seq(
        'layer',
        field('name', $.identifier),
        optional(seq('when', repeat1($._header_item))),
        $.block,
      ),
    transition: ($) =>
      prec.right(
        seq(
          'transition',
          optional(seq($.identifier, '->', $.identifier)),
          optional(seq('when', repeat1($._header_item))),
          optional($.block),
        ),
      ),
    selector_block: ($) =>
      prec(
        1,
        seq(field('name', choice($.identifier, $.css_token)), optional($.decorator), $.block),
      ),
    call: ($) => prec(1, seq(field('function', $.identifier), $.parenthesized)),
    block: ($) => seq('{', repeat($._item), '}'),
    parenthesized: ($) => seq('(', repeat($._item), ')'),
    bracketed: ($) => seq('[', repeat($._item), ']'),
    interpolation: ($) => seq('${', repeat($._item), '}'),
    decorator: ($) => seq($.animation, optional($.parenthesized)),
    keyword: () => choice('let', 'event', 'when', 'enter', 'leave'),
    type: () => choice('number', 'boolean', 'string', 'timing', 'easing'),
    boolean: () => choice('true', 'false'),
    property: ($) => prec(1, seq(field('name', $.identifier), ':')),
    identifier: () => /[A-Za-z_][A-Za-z0-9_-]*/,
    number: () => /([0-9]+(\.[0-9]+)?|\.[0-9]+)(ms|s|px|deg|%)?/,
    string: () => choice(/"([^"\\]|\\.)*"/, /'([^'\\]|\\.)*'/),
    animation: () => /@[A-Za-z_-][A-Za-z0-9_-]*/,
    operator: () =>
      choice(
        '->',
        '===',
        '!==',
        '==',
        '!=',
        '<=',
        '>=',
        '&&',
        '||',
        '+',
        '-',
        '*',
        '/',
        '%',
        '!',
        '<',
        '>',
        '=',
      ),
    punctuation: () => choice(':', ';', ',', '.', '@'),
    css_token: () => choice(/#[A-Za-z0-9]+/, /--[A-Za-z0-9_-]+/),
    comment: () => token(choice(/\/\/[^\n\r]*/, /\/\*[^*]*\*+([^/*][^*]*\*+)*\//)),
  },
})
