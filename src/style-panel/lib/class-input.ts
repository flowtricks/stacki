// What a name typed into the selector box means.
//
// In Webflow the field is a class field: type `hero` and you get `.hero`. Here the
// same box also takes real selectors (`.card:hover`, `ul > li`), so a bare word is
// ambiguous — `section` is the tag, `u-section` is a class nobody wrote a dot in
// front of. The rule: a bare word is a class unless it is an HTML tag. Anything
// with a dot, colon, bracket, combinator or space is already a selector and is
// left exactly as typed.

const HTML_TAGS: ReadonlySet<string> = new Set([
  'a', 'abbr', 'address', 'article', 'aside', 'audio', 'b', 'blockquote', 'body', 'br', 'button',
  'canvas', 'caption', 'code', 'dd', 'details', 'div', 'dl', 'dt', 'em', 'fieldset',
  'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header',
  'hr', 'html', 'i', 'iframe', 'img', 'input', 'label', 'legend', 'li', 'main', 'mark', 'nav',
  'ol', 'optgroup', 'option', 'p', 'picture', 'pre', 'section', 'select', 'small', 'span',
  'strong', 'sub', 'summary', 'sup', 'svg', 'table', 'tbody', 'td', 'textarea', 'tfoot', 'th',
  'thead', 'time', 'tr', 'u', 'ul', 'video',
])

/** Every HTML tag the selector box offers, in alphabetical order. */
export const HTML_TAG_NAMES: readonly string[] = [...HTML_TAGS].sort()

/** Whether `text` is nothing but an HTML tag name — `h2`, `section`. */
export function isTagSelector(text: string): boolean {
  return HTML_TAGS.has(text.trim().toLowerCase()) && /^[A-Za-z][A-Za-z0-9]*$/.test(text.trim())
}

const BARE_WORD = /^[A-Za-z_][\w-]*$/

/** The selector to use for what was typed: a bare non-tag word becomes a class. */
export function selectorFromTyped(input: string): string {
  const text = input.trim()
  if (BARE_WORD.test(text) && !HTML_TAGS.has(text.toLowerCase())) {
    return `.${text}`
  }
  return text
}
