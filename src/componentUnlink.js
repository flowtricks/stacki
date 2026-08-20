// Detaching one instance of a component, so the page holds its markup instead
// of its name.
//
// The inverse of extraction, and the harder direction. Extraction can refuse
// safely — the block either stands alone or it doesn't, and saying so costs the
// user a rename. Detaching goes wrong quietly: the markup arrives, the page
// still builds, and a value that used to come from a prop is now the word
// `undefined` in the middle of a paragraph. So everything the component was
// being given has to be resolved into the markup on the way in, and anything
// that can't be is refused by name before a single node moves.
//
// One level, deliberately. A component nested inside the one being detached
// stays a component — its tag comes across with its import re-aimed at the
// page. Flattening the whole tree would take away more than anyone asked for
// and leave nothing to point at afterwards.
//
// Nothing here touches a file. The component keeps its own .astro, every other
// page that uses it is untouched, and the whole operation is one edit to the
// page model — which is what makes it undo-able like any other edit.

import { readsVar, frontmatterBindings, codeInSubtree } from './componentExtract.js';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Substitute bare identifiers, but never inside a string.
 *
 * `{cond ? "title" : title}` holds the word twice and means it once. Rewriting
 * both produces `{cond ? ""Hi"" : "Hi"}`, which is not valid anything — so the
 * quotes are tracked and only what sits outside them is replaced. Template
 * literals count as quotes for the same reason; their `${…}` holes are code and
 * are entered.
 */
export function substituteOutsideStrings(text, values) {
  const src = String(text ?? '');
  const names = [...values.keys()];
  if (!names.length) return src;
  const re = new RegExp(`(^|[^\\w$.])(${names.map(escapeRe).join('|')})\\b`, 'g');

  let out = '';
  let i = 0;
  let quote = null; // "'" | '"' | '`'
  let start = 0;
  const flushCode = (end) => {
    out += src.slice(start, end).replace(re, (m, pre, name) => pre + values.get(name));
  };
  while (i < src.length) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === quote) {
        out += src.slice(start, i + 1);
        start = i + 1;
        quote = null;
      } else if (quote === '`' && ch === '$' && src[i + 1] === '{') {
        // A hole in a template literal is code again.
        out += src.slice(start, i + 2);
        const close = src.indexOf('}', i + 2);
        const end = close === -1 ? src.length : close;
        start = i + 2;
        flushCode(end);
        start = end;
        i = end;
        continue;
      }
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      flushCode(i);
      start = i;
      quote = ch;
    }
    i += 1;
  }
  if (quote) out += src.slice(start);
  else flushCode(src.length);
  return out;
}

// How the value an instance was given is written as an expression.
const exprForValue = (given, schema) => {
  if (given) {
    if (given.type === 'string') return JSON.stringify(given.value ?? '');
    // A bare attribute is the boolean shorthand: <Card featured />.
    if (given.type === 'bare') return 'true';
    // Parenthesised only where it could bind wrong. `title={post.title}` that
    // comes back as `{(post.title)}` is correct and reads like machinery.
    const raw = String(given.value ?? '').trim();
    return /^[A-Za-z_$][\w$.]*$/.test(raw) ? raw : `(${raw})`;
  }
  // Nothing was passed, so the component fell back to its own default — which
  // is what it must go on rendering. With no default that value really was
  // undefined, and writing it out keeps the page honest about that rather than
  // throwing a ReferenceError the component never had.
  if (schema && 'default' in schema && schema.default !== undefined) {
    return JSON.stringify(schema.default);
  }
  return 'undefined';
};

// A string that can be written as text rather than as `{"…"}`. Anything the
// serializer would read back as markup or as an expression stays an expression.
const plainEnough = (expr) => {
  if (!/^"(?:[^"\\]|\\.)*"$/.test(expr)) return null;
  let value;
  try {
    value = JSON.parse(expr);
  } catch {
    return null;
  }
  return /[<>{}]/.test(value) ? null : value;
};

/**
 * Everything the component's markup asks of the file it lives in and that
 * detaching cannot supply. Empty means it can be inlined.
 */
function unmetNeeds({ component, schema, instance }) {
  const problems = [];
  const propNames = new Set((schema || []).map((p) => p.name));
  const importNames = new Set((component.imports || []).map((i) => i.name));
  const code = component.nodes.map((n) => codeInSubtree(n)).join('\n');

  // A dynamic tag is a frontmatter binding used as an element, so it appears in
  // no expression and would slip past a reading of the code alone.
  const dynamic = new Set();
  const walk = (list) => {
    for (const n of list) {
      if (n.kind === 'component' && n.dynamicTag && n.name) dynamic.add(n.name);
      if (Array.isArray(n.children)) walk(n.children);
    }
  };
  walk(component.nodes);

  const supplied = frontmatterBindings(component.extraFrontmatter).filter(
    (name) =>
      !propNames.has(name) &&
      !importNames.has(name) &&
      (readsVar(code, name) || dynamic.has(name))
  );
  if (supplied.length) {
    problems.push(
      `its markup uses ${supplied.join(', ')}, which its frontmatter works out`
    );
  }
  if (/\bAstro\.props\b/.test(code)) {
    problems.push('its markup reads Astro.props directly');
  }
  if (/\bAstro\.slots\b/.test(component.extraFrontmatter || '') || /\bAstro\.slots\b/.test(code)) {
    problems.push('it asks Astro.slots what it was given');
  }
  const spread = Object.values(instance.props || {}).some((v) => v?.type === 'spread');
  if (spread) problems.push('this one is called with a spread, so its props aren’t all known here');
  return problems;
}

/**
 * What detaching `instance` would put on the page.
 *
 *   { problems }                     — nothing moves; each string says why
 *   { nodes, imports, styleCount }   — the markup, the imports it still needs,
 *                                      and how many <style> blocks came with it
 *
 * `keepStyles: false` drops those blocks. They are the component's own scoped
 * rules: left behind they stay in a file this page no longer imports, and the
 * markup lands unstyled — so the caller asks, rather than choosing.
 */
export function planUnlink({ instance, component, schema = [], newId, keepStyles = true }) {
  const problems = unmetNeeds({ component, schema, instance });
  if (problems.length) return { problems };

  const values = new Map();
  for (const prop of schema) {
    values.set(prop.name, exprForValue(instance.props?.[prop.name], prop));
  }

  const clone = (n) => ({ ...structuredClone(n), id: newId() });

  // The component's own markup, with every prop resolved to what this instance
  // was given. Done before the slots are filled: what comes in through a slot
  // is the PAGE's content and is already in the page's scope — substituting
  // there would rewrite the caller's own expressions with the callee's values.
  const resolve = (node) => {
    const out = clone(node);
    if (out.kind === 'expr' || out.kind === 'raw-line') {
      out.value = substituteOutsideStrings(out.value, values);
    }
    if (out.kind === 'map') out.head = substituteOutsideStrings(out.head, values);
    if (out.kind === 'cond') out.test = substituteOutsideStrings(out.test, values);
    if (out.props) {
      out.props = { ...out.props };
      for (const [key, v] of Object.entries(out.props)) {
        if (!v || (v.type !== 'expr' && v.type !== 'spread')) continue;
        const next = substituteOutsideStrings(v.value, values);
        // `class={tone}` where tone was "wide" reads better as class="wide"
        // than as class={"wide"} — it is what someone would have typed.
        const plain = v.type === 'expr' ? plainEnough(next) : null;
        out.props[key] = plain === null ? { ...v, value: next } : { type: 'string', value: plain };
      }
    }
    if (Array.isArray(node.children)) out.children = node.children.map(resolve);
    return out;
  };

  let markup = component.nodes.map(resolve);

  // An expression that is now only a string is text. `<h1>{"Our team"}</h1>`
  // renders the same as `<h1>Our team</h1>` and reads like a mistake.
  const flattenExprs = (list) =>
    list.map((n) => {
      if (Array.isArray(n.children)) n.children = flattenExprs(n.children);
      if (n.kind !== 'expr') return n;
      const inner = String(n.value || '').replace(/^\{|\}$/g, '').trim();
      const plain = plainEnough(inner);
      return plain === null ? n : { id: n.id, kind: 'text', value: plain };
    });
  markup = flattenExprs(markup);

  // What the instance was wrapping goes where the component put its <slot />.
  const given = Array.isArray(instance.children) ? instance.children : [];
  const bySlot = new Map();
  for (const child of given) {
    const named = child.props?.slot;
    const key = named && named.type === 'string' ? named.value : '';
    if (!bySlot.has(key)) bySlot.set(key, []);
    // The `slot` attribute named a hole that no longer exists.
    const copy = structuredClone(child);
    if (copy.props?.slot) delete copy.props.slot;
    bySlot.get(key).push(copy);
  }

  const fillSlots = (list) => {
    const out = [];
    for (const node of list) {
      if (node.kind === 'element' && node.name === 'slot') {
        const named = node.props?.name;
        const key = named && named.type === 'string' ? named.value : '';
        const content = bySlot.get(key);
        // Nothing was passed for this hole, so the component's own fallback
        // stands — which is exactly what it rendered before.
        out.push(...(content?.length ? content : fillSlots(node.children || [])));
        continue;
      }
      if (Array.isArray(node.children)) node.children = fillSlots(node.children);
      out.push(node);
    }
    return out;
  };
  markup = fillSlots(markup);

  // The component's scoped rules, which only mean anything where its markup is.
  let styleCount = 0;
  const countStyles = (list) =>
    list.filter((n) => {
      if (n.kind === 'raw' && n.name === 'style') {
        styleCount += 1;
        return keepStyles;
      }
      if (Array.isArray(n.children)) n.children = countStyles(n.children);
      return true;
    });
  markup = countStyles(markup);

  // Only the imports the markup that landed still uses.
  const placed = new Set();
  const collect = (list) => {
    for (const n of list) {
      if (n.kind === 'component' && n.name && !n.dynamicTag) placed.add(n.name);
      if (Array.isArray(n.children)) collect(n.children);
    }
  };
  collect(markup);
  const landedCode = markup.map((n) => codeInSubtree(n)).join('\n');
  const imports = (component.imports || []).filter(
    (i) => placed.has(i.name) || readsVar(landedCode, i.name)
  );

  return { nodes: markup, imports, styleCount };
}
