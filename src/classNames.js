// The class names an element carries, for labelling it in the UI.
//
// `class="a b"` is readable straight from the source, but Astro also has
// `class:list={[...]}` — an array with one entry per class, where entries can be
// conditional (`gap !== "8" && \`gap-${gap}\``), interpolated, or a prop passed
// in from outside. Only the plain string literals name a class that every
// instance gets; the rest depend on how the component was called, so they can't
// be resolved from source alone.
//
// (The style panel shows the dynamic ones too — it merges in the classes the
// preview reports for the selected element. The navigator labels every node in
// the tree, most of which were never rendered as the selection, so it has no
// DOM to ask and stays with what the source guarantees.)

const QUOTED = /^(['"])(.*)\1$/s;

// Splits an array literal's body on top-level commas — an entry can itself
// contain commas inside a call or a nested array.
function topLevelParts(body) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let cur = '';
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (quote) {
      cur += ch;
      if (ch === '\\') {
        cur += body[i + 1] ?? '';
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      cur += ch;
    } else if (ch === '(' || ch === '[' || ch === '{') {
      depth += 1;
      cur += ch;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
      cur += ch;
    } else if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  parts.push(cur);
  return parts;
}

// Class names from a `class:list` (or expression `class`) value. An entry counts
// only when the WHOLE entry is a quoted string — that rules out a literal that's
// merely part of a condition, like the `"8"` in `gap !== "8" && ...`.
function fromExpression(expr) {
  const trimmed = String(expr || '').trim();
  const body = trimmed.startsWith('[') && trimmed.endsWith(']')
    ? trimmed.slice(1, -1)
    : trimmed;
  const out = [];
  for (const part of topLevelParts(body)) {
    const m = QUOTED.exec(part.trim());
    // Unescape: the capture is the raw source between the quotes, so `\"` in
    // the literal would otherwise reach the label with its backslash.
    if (m) out.push(...m[2].replace(/\\(.)/g, '$1').split(/\s+/).filter(Boolean));
  }
  return out;
}

/** Static class names on a node, in source order. Empty when it has none. */
export function elementClasses(node) {
  const props = node?.props || {};
  const cls = props.class;
  if (cls && cls.type === 'string') {
    return cls.value.trim().split(/\s+/).filter(Boolean);
  }
  const list = props['class:list'];
  if (list && list.type === 'expr') return fromExpression(list.value);
  if (cls && cls.type === 'expr') return fromExpression(cls.value);
  return [];
}

/**
 * The name to label an element with: a named slot's name, then its first
 * class, then its tag. Every slot is spelled `slot`, so the name is the only
 * thing that tells one from another.
 */
export function elementLabel(node) {
  if (node?.name === 'slot') {
    const named = node.props?.name;
    if (named && named.type === 'string' && named.value.trim()) return named.value.trim();
  }
  return elementClasses(node)[0] || node?.name || '';
}
