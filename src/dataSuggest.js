// Heuristic static analysis powering the loop "Data" suggestions: top-level
// frontmatter declarations and imports, ancestor loop variables, and — by
// reading object literals — the keys nested inside them, so `service`
// suggests `service.tags` without executing any code.

function skipString(code, i) {
  const q = code[i];
  i++;
  while (i < code.length && code[i] !== q) {
    if (code[i] === '\\') i++;
    i++;
  }
  return i;
}

// End index (exclusive) of an expression starting at `start`: stops at a
// top-level ';' or a newline not continued by a chained operator.
function scanValue(code, start) {
  let depth = 0;
  for (let i = start; i < code.length; i++) {
    const ch = code[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipString(code, i);
      continue;
    }
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) {
      depth--;
      if (depth < 0) return i;
    } else if (depth === 0 && ch === ';') return i;
    else if (depth === 0 && ch === '\n') {
      if (!/^\s*(\.|\)|\]|\}|,|\|\||&&|\?|:)/.test(code.slice(i))) return i;
    }
  }
  return code.length;
}

// Top-level const/let/var declarations: name -> value text.
export function parseDeclarations(code) {
  const out = new Map();
  const re = /(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*=\s*/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    const start = m.index + m[0].length;
    const end = scanValue(code, start);
    out.set(m[1], code.slice(start, end).trim());
    re.lastIndex = end;
  }
  return out;
}

// Locates one top-level declaration by name and reports where it sits, so a
// prop bound to `{rotatingWords}` can offer to edit the `const rotatingWords
// = […]` behind it. `start`/`end` bound the whole statement (its indentation
// stays outside the range, and a trailing ';' inside it).
export function findDeclaration(code, name) {
  const src = String(code || '');
  const ident = String(name || '');
  if (!/^[A-Za-z_$][\w$]*$/.test(ident)) return null;
  const re = new RegExp(
    `(?:^|\\n)([ \\t]*)((?:export\\s+)?(?:const|let|var)\\s+${ident.replace(/\$/g, '\\$')}\\s*=\\s*)`,
    'g'
  );
  const m = re.exec(src);
  if (!m) return null;
  const valueStart = m.index + m[0].length;
  const start = valueStart - m[2].length;
  const valueEnd = scanValue(src, valueStart);
  const end = src[valueEnd] === ';' ? valueEnd + 1 : valueEnd;
  return {
    name: ident,
    start,
    end,
    statement: src.slice(start, end),
    value: src.slice(valueStart, valueEnd).trim(),
  };
}

/**
 * The import that brings `name` into a file, as {name, spec}, or null.
 * Covers `import x from`, `import { a, b as c } from`, `import * as ns from`
 * and type-only imports — everything a page's frontmatter can carry.
 */
export function findImportOf(code, name) {
  const ident = String(name || '');
  if (!/^[A-Za-z_$][\w$]*$/.test(ident)) return null;
  const re = /import\s+(?:type\s+)?([\s\S]*?)\s+from\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(String(code || ''))) !== null) {
    const clause = m[1];
    const spec = m[2];
    // `* as ns` and a default binding are the whole name; a braced list needs
    // its entries split, honouring `a as b` (the local name is what's used).
    const braced = clause.match(/\{([\s\S]*)\}/);
    const names = [];
    const outside = clause.replace(/\{[\s\S]*\}/, '').replace(/\*\s+as\s+/, '');
    for (const part of outside.split(',')) {
      const t = part.trim();
      if (t) names.push(t);
    }
    if (braced) {
      for (const part of braced[1].split(',')) {
        const t = part.trim();
        if (!t) continue;
        const as = t.split(/\s+as\s+/);
        names.push((as[1] || as[0]).trim());
      }
    }
    if (names.includes(ident)) return { name: ident, spec };
  }
  return null;
}

// The first '{…}' object inside an array literal (or the object itself).
export function firstObjectIn(text) {
  if (!text) return null;
  const t = text.trim();
  if (t.startsWith('{')) return t;
  if (!t.startsWith('[')) return null;
  let depth = 0;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipString(t, i);
      continue;
    }
    if (ch === '{' && depth === 1) {
      let d = 0;
      for (let j = i; j < t.length; j++) {
        const c = t[j];
        if (c === '"' || c === "'" || c === '`') {
          j = skipString(t, j);
          continue;
        }
        if (c === '{') d++;
        else if (c === '}') {
          d--;
          if (d === 0) return t.slice(i, j + 1);
        }
      }
      return null;
    }
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
  }
  return null;
}

// Top-level entries of an object literal: [{key, value}]. Shorthand keys
// ({ name, url }) yield empty value text.
export function objectEntries(text) {
  if (!text) return [];
  const t = text.trim();
  if (!t.startsWith('{')) return [];
  const entries = [];
  let depth = 0;
  let i = 0;
  while (i < t.length) {
    const ch = t[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipString(t, i) + 1;
      continue;
    }
    if ('([{'.includes(ch)) {
      depth++;
      i++;
      continue;
    }
    if (')]}'.includes(ch)) {
      depth--;
      i++;
      continue;
    }
    if (depth === 1 && /[,{\s]/.test(t[i - 1] || '{')) {
      const m = t.slice(i).match(/^([\w$]+)\s*(:)?/);
      if (m && (m[2] || /^[\w$]+\s*[,}]/.test(t.slice(i)))) {
        if (!m[2]) {
          entries.push({ key: m[1], value: '' });
          i += m[1].length;
          continue;
        }
        const vs = i + m[0].length;
        let d = depth;
        let j = vs;
        while (j < t.length) {
          const c = t[j];
          if (c === '"' || c === "'" || c === '`') {
            j = skipString(t, j) + 1;
            continue;
          }
          if ('([{'.includes(c)) d++;
          else if (')]}'.includes(c)) {
            d--;
            if (d === 0) break;
          } else if (c === ',' && d === 1) break;
          j++;
        }
        entries.push({ key: m[1], value: t.slice(vs, j).trim() });
        i = j;
        continue;
      }
    }
    i++;
  }
  return entries;
}

function kindOf(value) {
  if (!value) return '';
  const t = value.trim();
  if (t.startsWith('[')) return 'list';
  if (t.startsWith('{')) return 'object';
  if (/^['"`]/.test(t)) return 'text';
  if (/^-?\d/.test(t)) return 'number';
  if (/^(true|false)$/.test(t)) return 'boolean';
  return '';
}

const MAP_HEAD_RE = /^([\s\S]+?)\.map\(\s*\(\s*([\w$]+)\s*(?:,\s*([\w$]+)\s*)?\)\s*=>\s*\($/;

// Modules that can't be looped over, by what they are rather than by naming
// luck: markup, styles, and media. A PascalCase default import is Astro's
// component convention, which catches the rest.
const NON_DATA_EXT =
  /\.(astro|md|mdx|css|s[ac]ss|less|svg|png|jpe?g|gif|webp|avif|ico|bmp|mp4|webm|mov|woff2?|ttf|otf)(\?.*)?$/i;

function mayHoldData(imp) {
  const path = String(imp?.path || '');
  if (NON_DATA_EXT.test(path)) return false;
  return !/^[A-Z]/.test(String(imp?.name || ''));
}

// Follow a dotted path (['services'] or ['service','tags']) through value
// texts; stepping into an array uses its first object's shape.
function resolvePath(rootValue, parts) {
  let cur = rootValue;
  for (const part of parts) {
    const obj = cur && cur.trim().startsWith('[') ? firstObjectIn(cur) : cur;
    const entry = objectEntries(obj || '').find((e) => e.key === part);
    if (!entry) return null;
    cur = entry.value;
  }
  return cur;
}

// context: {frontmatter, imports: [{name}], ancestorHeads: [head, …]}
// query: the Data field's current text.
// Returns [{insert, label, hint}] — ONLY values that can actually be looped:
// known lists (including dotted paths like service.tags), plus names whose
// shape is unknown (imports, unresolvable loop items) which may be lists.
// Objects, strings, numbers, and index variables are never suggested.
export function dataSuggestions(context, query) {
  const decls = parseDeclarations(context.frontmatter || '');
  const out = [];
  const seen = new Set();
  const push = (insert, hint) => {
    if (!seen.has(insert)) {
      seen.add(insert);
      out.push({ insert, label: insert, hint });
    }
  };

  // Walk a known shape, collecting every dotted path that lands on a list.
  const addListPaths = (name, valueText, depth) => {
    const t = (valueText || '').trim();
    if (t.startsWith('[')) {
      push(name, 'list');
      return;
    }
    if (t.startsWith('{') && depth < 3) {
      for (const e of objectEntries(t)) {
        if (e.value) addListPaths(`${name}.${e.key}`, e.value, depth + 1);
      }
    }
  };

  for (const [name, value] of decls) addListPaths(name, value, 0);
  for (const imp of context.imports || []) {
    // An import's shape is unknown, so it may be a list — but a component,
    // layout, stylesheet or image never is, and those are the bulk of what a
    // page imports. Offering `Heading` as something to loop over is noise.
    if (!decls.has(imp.name) && mayHoldData(imp)) push(imp.name, 'import');
  }
  for (const head of context.ancestorHeads || []) {
    const m = String(head).trim().match(MAP_HEAD_RE);
    if (!m) continue;
    const dataExpr = m[1].trim();
    let shape = null;
    if (/^[\w$.]+$/.test(dataExpr)) {
      const [first, ...rest] = dataExpr.split('.');
      const rootVal = decls.get(first);
      const v = rootVal ? (rest.length ? resolvePath(rootVal, rest) : rootVal) : null;
      shape = v ? firstObjectIn(v) : null;
    }
    if (shape) addListPaths(m[2], shape, 0); // lists inside the item, e.g. service.tags
    else push(m[2], 'loop item'); // unknown shape — may itself be a list
    // index variables are numbers — never loopable, never suggested
  }

  const q = String(query || '').trim().toLowerCase();
  return out
    .filter((s) => !q || s.insert.toLowerCase().includes(q))
    .sort((a, b) => {
      const ap = a.insert.toLowerCase().startsWith(q) ? 0 : 1;
      const bp = b.insert.toLowerCase().startsWith(q) ? 0 : 1;
      return ap - bp || a.insert.length - b.insert.length;
    });
}

// Values that can go inside {} at the current selection: the item and index
// of every enclosing loop, the fields of those items when the data's shape is
// readable, and top-level frontmatter values that aren't lists. Used by the
// content editor's expression chips. Same context shape as dataSuggestions.
export function exprSuggestions(context) {
  const decls = parseDeclarations(context.frontmatter || '');
  const out = [];
  const seen = new Set();
  const push = (insert, hint) => {
    if (insert && !seen.has(insert)) {
      seen.add(insert);
      out.push({ insert, hint });
    }
  };

  // The object shape one element of `dataExpr` has, when it can be read.
  const shapeOf = (dataExpr) => {
    if (!/^[\w$.]+$/.test(dataExpr)) return null;
    const [first, ...rest] = dataExpr.split('.');
    const rootVal = decls.get(first);
    if (!rootVal) return null;
    const v = rest.length ? resolvePath(rootVal, rest) : rootVal;
    return v ? firstObjectIn(v) : null;
  };

  for (const head of context.ancestorHeads || []) {
    const m = String(head).trim().match(MAP_HEAD_RE);
    if (!m) continue;
    const item = m[2];
    const index = m[3];
    const shape = shapeOf(m[1].trim());
    if (shape) {
      // A bare `{service}` would print [object Object] — offer its fields.
      for (const e of objectEntries(shape)) push(`${item}.${e.key}`, kindOf(e.value) || 'field');
    } else {
      push(item, 'loop item'); // shape unknown (a list of strings, an import…)
    }
    if (index) push(index, 'number');
  }

  for (const [name, value] of decls) {
    const k = kindOf(value);
    if (k === 'text' || k === 'number' || k === 'boolean') push(name, k);
    else if (k === 'object') {
      for (const e of objectEntries(value)) push(`${name}.${e.key}`, kindOf(e.value) || 'field');
    }
  }
  return out;
}
