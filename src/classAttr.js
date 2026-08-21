// Putting a class on an element whose classes are not a plain string.
//
// Typing `.hero` in the style panel writes a rule for `.hero`, and a rule for a
// class the element does not carry never applies — so the class goes on the
// element too. `class="a b"` is easy. The elements worth styling often aren't
// that: a component that takes a `class` prop writes
//
//   class:list={["section", padClass("top", paddingTop), …, className]}
//
// and the app used to leave those alone, silently. Nothing appeared in the
// class attribute and nothing said why.
//
// A class:list is a list, so a class is appended to it — the same edit a person
// would make, in the same place. A `class` written as a template literal grows
// by one word inside the quotes. Anything else is a value whose meaning this
// cannot know (`class={cx(a, b)}`), and it says so rather than guessing.

const LIST = 'class:list';

const quoted = (name) => `"${name}"`;

/** Every class name the attribute mentions literally. */
export function namesIn(prop) {
  if (!prop) return [];
  if (prop.type === 'string') return String(prop.value).trim().split(/\s+/).filter(Boolean);
  const text = String(prop.value || '');
  // Quoted strings in an expression, plus the words inside a template literal —
  // the literal parts only, since `${theme}` is not a name until it runs.
  const out = [];
  for (const m of text.matchAll(/"([^"]*)"|'([^']*)'|`([^`]*)`/g)) {
    const inner = m[1] ?? m[2] ?? m[3] ?? '';
    for (const word of inner.split(/\$\{[^}]*\}|\s+/)) if (word) out.push(word);
  }
  return out;
}

/** Whether the element already carries `name`, however its classes are written. */
export function hasClass(props, name) {
  const clean = String(name || '').trim();
  if (!clean) return true;
  return ['class', LIST].some((key) => namesIn(props?.[key]).includes(clean));
}

/**
 * The single prop to write so the element carries `name`, as
 * `{ key, value }` — or null when its classes are code that cannot be
 * extended without guessing at what it means.
 *
 * Returns null for "already there" as well: the caller has `hasClass` for
 * telling those apart, and neither is an edit.
 */
export function withClass(props, name) {
  const clean = String(name || '').trim();
  if (!clean || /\s/.test(clean)) return null;
  if (hasClass(props, clean)) return null;

  const list = props?.[LIST];
  if (list) {
    if (list.type !== 'expr') return null;
    const text = String(list.value || '').trim();
    const at = text.lastIndexOf(']');
    if (!text.startsWith('[') || at < 0) {
      // A list that isn't written as one — `class:list={props.classes}`. It
      // still takes an array, so wrap it in the one being added to.
      return { key: LIST, value: { type: 'expr', value: `[${text}, ${quoted(clean)}]` } };
    }
    const head = text.slice(0, at);
    const tail = text.slice(at);
    // Keep the shape it was written in: a list broken over lines gets its own
    // line, indented like the entry above it, trailing comma and all.
    const lines = head.split('\n');
    const last = lines[lines.length - 1];
    if (lines.length > 1) {
      const indent = (head.match(/\n([ \t]*)\S/) || [, '  '])[1];
      const comma = /,\s*$/.test(head) ? '' : ',';
      const gap = /\n\s*$/.test(head) ? '' : '\n';
      return {
        key: LIST,
        value: { type: 'expr', value: `${head.replace(/\s+$/, '')}${comma}\n${indent}${quoted(clean)},\n${last.match(/^[ \t]*/)[0]}${tail}` },
      };
    }
    const comma = /\[\s*$/.test(head) ? '' : ', ';
    return { key: LIST, value: { type: 'expr', value: `${head}${comma}${quoted(clean)}${tail}` } };
  }

  const cls = props?.class;
  if (!cls) return { key: 'class', value: { type: 'string', value: clean } };
  if (cls.type === 'string') {
    const words = namesIn(cls);
    return { key: 'class', value: { type: 'string', value: [...words, clean].join(' ') } };
  }
  if (cls.type === 'expr') {
    const text = String(cls.value || '').trim();
    // A template literal is a string being built: one more word in it is one
    // more class, wherever the holes happen to be.
    if (text.startsWith('`') && text.endsWith('`') && text.length > 1) {
      return { key: 'class', value: { type: 'expr', value: `${text.slice(0, -1)} ${clean}\`` } };
    }
  }
  return null;
}

export default withClass;
