// Parses .astro pages into an editable tree model and serializes the model
// back to clean .astro source.
//
// Node kinds:
//   component — <Hero .../> or <Section>...</Section> (capitalized)
//   element   — <div>, <img/>, any lowercase tag
//   text      — text content between tags (may contain {expressions})
//   comment   — <!-- ... -->
//   raw       — <style>/<script> blocks whose inner content is kept verbatim
//
// children: null = self-closing, [] = paired-but-empty, [nodes] otherwise.
//
// Pages whose template can't be represented (stray '<', unclosed tags,
// fragments) are reported as not editable so the UI falls back to code view.

const fs = require('fs');
const path = require('path');

const IMPORT_RE = /import\s+(\w+)\s+from\s+['"]([^'"]+)['"];?/g;
// `import { Image, Picture } from 'astro:assets'` — Astro's own components come
// in this way, so without it <Image> looks like an unimported capitalized tag
// (a dynamic `const Tag = …`) rather than the component it is.
const NAMED_IMPORT_RE = /import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"];?/g;
const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);
const RAW_ELEMENTS = new Set(['style', 'script']);

let nextId = 1;
const makeId = () => `n${nextId++}`;

// ---------------------------------------------------------------------------
// Attribute (prop) parsing
// ---------------------------------------------------------------------------

// Values: {type:'string'|'expr'|'bare'|'spread', value}
// Expression values may contain one level of nested braces (attrs={{ a: 1 }}).
//
// `{...rest}` is matched first and kept as its own kind. Without that the name
// pattern claims `...rest` as a bare attribute — `.` is a legal attribute
// character — and it is written back WITHOUT its braces, turning
// `<Foo {...rest} />` into `<Foo ...rest />`, which does not compile. Spreads
// are everywhere in Astro, so this corrupts real components.
function parseAttrs(attrString) {
  const props = {};
  // The spread body takes one level of nested braces, the same depth the
  // value form below allows — `{...cond ? { href } : { type: "button" }}` is
  // ordinary Astro, and stopping at the first inner brace would truncate it.
  const re =
    /\{\s*\.\.\.((?:[^{}]|\{[^{}]*\})*)\}|([\w@:.-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|\{((?:[^{}]|\{[^{}]*\})*)\}))?/g;
  let m;
  while ((m = re.exec(attrString)) !== null) {
    if (!m[0].trim()) continue;
    if (m[1] !== undefined) {
      // Keyed by the spread's own text, so two different spreads on one tag
      // stay separate and the order round-trips.
      const expr = m[1].trim();
      props[`...${expr}`] = { type: 'spread', value: expr };
      continue;
    }
    const name = m[2];
    if (m[3] !== undefined) props[name] = { type: 'string', value: m[3] };
    else if (m[4] !== undefined) props[name] = { type: 'string', value: m[4] };
    else if (m[5] !== undefined) props[name] = { type: 'expr', value: m[5].trim() };
    else props[name] = { type: 'bare' };
  }
  return props;
}

function serializeAttrs(props) {
  const parts = [];
  for (const [name, v] of Object.entries(props || {})) {
    if (v?.type === 'spread') {
      parts.push(`{...${v.value}}`);
    } else if (v == null || v.type === 'bare') {
      parts.push(name);
    } else if (v.type === 'expr') {
      parts.push(`${name}={${v.value}}`);
    } else {
      parts.push(`${name}="${String(v.value).replace(/"/g, '&quot;')}"`);
    }
  }
  return parts.length ? ' ' + parts.join(' ') : '';
}

// ---------------------------------------------------------------------------
// Template parsing
// ---------------------------------------------------------------------------

const TAG_RE = /<([A-Za-z][\w.-]*)((?:[^>"'{]|"[^"]*"|'[^']*'|\{(?:[^{}]|\{[^{}]*\})*\})*?)(\/?)>/y;

// Index just past the string/comment starting at `i`, or `i` itself when
// nothing starts there. Comments matter as much as strings: `{/* the button's
// background */}` is an ordinary JSX comment, and without this the apostrophe
// opens a "string" that never closes, so the scan runs off the end of the file
// and the whole page is declared unrepresentable.
function skipStringOrComment(str, i) {
  const ch = str[i];
  if (ch === '"' || ch === "'" || ch === '`') {
    i++;
    while (i < str.length && str[i] !== ch) {
      if (str[i] === '\\') i++;
      i++;
    }
    return i + 1;
  }
  if (ch === '/' && str[i + 1] === '/') {
    const nl = str.indexOf('\n', i + 2);
    return nl === -1 ? str.length : nl; // leave the newline itself unconsumed
  }
  if (ch === '/' && str[i + 1] === '*') {
    const end = str.indexOf('*/', i + 2);
    return end === -1 ? str.length : end + 2;
  }
  return i;
}

// Finds the index of the '}' matching the '{' at `start`, skipping strings,
// template literals, and comments so quotes/braces inside them don't confuse
// counting.
function findMatchingBrace(str, start) {
  let depth = 0;
  for (let i = start; i < str.length; i++) {
    const skipped = skipStringOrComment(str, i);
    if (skipped !== i) {
      i = skipped - 1;
      continue;
    }
    const ch = str[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// Finds the index of the ')' matching the '(' at `start`, skipping strings and
// comments.
function findMatchingParen(str, start) {
  let depth = 0;
  for (let i = start; i < str.length; i++) {
    const skipped = skipStringOrComment(str, i);
    if (skipped !== i) {
      i = skipped - 1;
      continue;
    }
    const ch = str[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// Recognizes {items.map((item) => ( <JSX/> ))} and turns it into a 'map'
// node whose JSX body is a parsed child tree (editable in the navigator).
// Returns null when the expression doesn't fit the pattern.
// The head as one line, for the Loop panel's field and for comparing an edited
// head against the source it came from.
const normalizeHead = (text) => text.replace(/\s+/g, ' ').trim();

// The head's own lines with their shared indentation removed, so the serializer
// can lay them back out under whatever indent the node ends up at.
function dedentHead(text) {
  const lines = text.split('\n');
  while (lines.length && !lines[0].trim()) lines.shift();
  if (lines.length < 2) return normalizeHead(text);
  const indents = lines.filter((l) => l.trim()).map((l) => l.match(/^[ \t]*/)[0].length);
  const common = Math.min(...indents);
  return lines.map((l) => (l.trim() ? l.slice(common) : '')).join('\n').trimEnd();
}

// Splits a statement block on the semicolons that actually end statements —
// not the ones inside strings, template literals, parens, braces or brackets.
function topLevelStatements(src) {
  const out = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ';' && depth === 0) {
      out.push(src.slice(start, i));
      start = i + 1;
    } else if (c === '\n' && depth === 0) {
      // Semicolons are optional. A newline ends the statement when what
      // follows starts a new one — the same call JavaScript's own insertion
      // makes, without pretending to be a parser.
      if (/^\s*(const|let|return)\b/.test(src.slice(i))) {
        out.push(src.slice(start, i));
        start = i + 1;
      }
    }
  }
  const tail = src.slice(start);
  if (tail.trim()) out.push(tail);
  return out;
}

// `(item) => { const x = …; return ( <jsx/> ); }` — the block form of a loop
// body. It's a loop like any other as long as the statements before the
// `return` are plain declarations: they're kept verbatim on the node and
// written back out, while the returned markup becomes the loop's children.
// Anything else in there (an if, a side effect, more than one return) can't be
// represented, so the whole expression stays code.
// Returns { body: string[], markup: string } or null.
function splitBlockLoopBody(block) {
  const statements = topLevelStatements(block);
  if (!statements.length) return null;
  const body = [];
  for (let i = 0; i < statements.length; i++) {
    const text = statements[i].trim();
    if (!text) continue;
    if (/^return\b/.test(text)) {
      // The return must be the last thing in the block.
      if (statements.slice(i + 1).some((rest) => rest.trim())) return null;
      let markup = text.slice('return'.length).trim();
      while (markup.startsWith('(') && findMatchingParen(markup, 0) === markup.length - 1) {
        markup = markup.slice(1, -1).trim();
      }
      if (!markup.startsWith('<')) return null;
      return { body, markup };
    }
    if (!/^(const|let)\s/.test(text)) return null;
    body.push(text.replace(/;*$/, ';'));
  }
  return null; // no return statement — nothing is rendered
}

// `data.map((i) => (` → `data.map((i) => {`, for writing a loop that carries
// declarations back out in the shape it was written in.
const blockHead = (head) => head.replace(/\($/, '{');

function tryParseMap(exprText) {
  const inner = exprText.slice(1, -1); // strip the outer { }
  // Both forms are tried: the concise matcher's lazy prefix can run past a
  // block body's `=> {` and match a NESTED `.map((t) => (` in its markup, so
  // its failure says nothing about whether this is a block-bodied loop.
  return tryParseConciseMap(inner) || tryParseBlockMap(inner);
}

function tryParseConciseMap(inner) {
  // The callback's parameter list may be parenthesized — `(post)`, `(post, i)`,
  // `([k, v])` — or a bare name, which is how many people write a one-argument
  // arrow. Both are the same loop; only the first used to be recognized.
  const arrow = inner.match(
    /^([\s\S]*?\.map\(\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\()/
  );
  if (!arrow) return null;
  const headRaw = arrow[1];
  const openIdx = arrow[0].length - 1; // the arrow-body '('
  const closeIdx = findMatchingParen(inner, openIdx);
  if (closeIdx === -1) return null;
  // After the body must come only the .map() close paren.
  if (!/^\s*\)\s*$/.test(inner.slice(closeIdx + 1))) return null;
  const body = inner.slice(openIdx + 1, closeIdx);
  const parsed = parseTemplate(body);
  if (!parsed.clean) return null;
  return {
    id: makeId(),
    kind: 'map',
    head: normalizeHead(headRaw), // e.g. "stats.map((stat) => ("
    // A chain written across several lines — `posts` / `.sort(…)` / `.map(…)` —
    // is one line once normalized, and writing that back would flatten how the
    // page was written. Keep the original layout to re-emit while the head
    // still says the same thing; see serializeNode's 'map' case.
    headSource: dedentHead(headRaw),
    children: parsed.nodes,
  };
}

// The same loop, written with a statement body. Normalized to the same node
// the concise form produces — head ending in `=> (` so the Loop editor reads
// it unchanged — with the declarations parked in `body` for serializing back.
function tryParseBlockMap(inner) {
  const arrow = inner.match(
    /^([\s\S]*?\.map\(\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*)\{/
  );
  if (!arrow) return null;
  const headRaw = arrow[1];
  const openIdx = arrow[0].length - 1; // the arrow-body '{'
  const closeIdx = findMatchingBrace(inner, openIdx);
  if (closeIdx === -1) return null;
  // After the block must come only the .map() close paren.
  if (!/^\s*\)\s*$/.test(inner.slice(closeIdx + 1))) return null;
  const split = splitBlockLoopBody(inner.slice(openIdx + 1, closeIdx));
  if (!split) return null;
  const parsed = parseTemplate(split.markup);
  if (!parsed.clean) return null;
  return {
    id: makeId(),
    kind: 'map',
    head: normalizeHead(headRaw + '('),
    body: split.body,
    children: parsed.nodes,
  };
}

// ---------------------------------------------------------------------------
// Conditional markup
// ---------------------------------------------------------------------------

// Top-level `?`, `:` and `&&` in a JS expression — the ones that actually
// split it, not the ones nested in a call, an object, a string, or a JSX tag.
// `?.` and `??` are single tokens, and `client:load` is an attribute name, so
// none of those count.
function topLevelOps(src) {
  const out = [];
  let depth = 0;
  for (let i = 0; i < src.length; i++) {
    const skipped = skipStringOrComment(src, i);
    if (skipped !== i) {
      i = skipped - 1;
      continue;
    }
    const ch = src[i];
    if (ch === '(' || ch === '[' || ch === '{') {
      depth++;
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      continue;
    }
    // A JSX tag's own attributes are not part of the expression around it.
    if (ch === '<' && /[A-Za-z/]/.test(src[i + 1] || '')) {
      let j = i + 1;
      while (j < src.length) {
        const s = skipStringOrComment(src, j);
        if (s !== j) {
          j = s;
          continue;
        }
        if (src[j] === '>') break;
        j++;
      }
      i = j;
      continue;
    }
    if (depth !== 0) continue;
    if (ch === '?') {
      if (src[i + 1] === '?' || src[i + 1] === '.') i++; // ?? and ?. aren't ternaries
      else out.push({ op: '?', at: i });
    } else if (ch === ':') {
      out.push({ op: ':', at: i });
    } else if (ch === '&' && src[i + 1] === '&') {
      out.push({ op: '&&', at: i });
      i++;
    }
  }
  return out;
}

// One side of a conditional, as child nodes. `null` means "this isn't markup",
// which sends the whole expression back to being opaque code.
function branchNodes(raw) {
  let t = String(raw).trim();
  // Peel the wrapping parens the JSX convention adds: `? ( <img/> ) :`.
  while (t.startsWith('(') && findMatchingParen(t, 0) === t.length - 1) {
    t = t.slice(1, -1).trim();
  }
  // The ways of writing "render nothing here".
  if (t === '' || /^(null|undefined|false|''|"")$/.test(t)) return [];
  if (t.startsWith('<')) {
    // A failed probe must not claim the page's bail message — the caller
    // falls back to an expression node and the page still parses.
    const saved = lastBail;
    const parsed = parseTemplate(t);
    if (parsed.clean) return parsed.nodes;
    lastBail = saved;
    return null;
  }
  // `a ? (…) : b ? (…) : (…)` — an else-if chain, which reads as a condition
  // nested in the else branch.
  const nested = parseCondSource(t);
  return nested ? [nested] : null;
}

function makeBranch(name, children) {
  return { id: makeId(), kind: 'branch', name, children };
}

// `test ? ( … ) : ( … )` and `test && ( … )` as a structural node. Returns null
// for anything whose branches aren't markup (a ternary picking between two
// strings, say) — those stay code.
function parseCondSource(src) {
  const text = String(src).trim();
  if (!text) return null;
  const ops = topLevelOps(text);
  const ternary = ops.find((o) => o.op === '?');
  if (ternary) {
    const colon = ops.find((o) => o.op === ':' && o.at > ternary.at);
    if (!colon) return null;
    const test = text.slice(0, ternary.at).trim();
    if (!test) return null;
    const thenKids = branchNodes(text.slice(ternary.at + 1, colon.at));
    const elseKids = branchNodes(text.slice(colon.at + 1));
    if (!thenKids || !elseKids) return null;
    return {
      id: makeId(),
      kind: 'cond',
      op: '?',
      test,
      children: [makeBranch('then', thenKids), makeBranch('else', elseKids)],
    };
  }
  // `a && b && (<x/>)`: everything up to the LAST && is the test.
  const ands = ops.filter((o) => o.op === '&&');
  const and = ands[ands.length - 1];
  if (!and) return null;
  const test = text.slice(0, and.at).trim();
  if (!test) return null;
  const kids = branchNodes(text.slice(and.at + 2));
  if (!kids || !kids.length) return null; // `x && null` is not worth a node
  return {
    id: makeId(),
    kind: 'cond',
    op: '&&',
    test,
    children: [makeBranch('then', kids)],
  };
}

// Recognizes conditional markup — {cond ? ( … ) : ( … )}, {cond && ( … )} —
// and turns it into a 'cond' node whose branches are parsed child trees, so
// each side is navigable and editable instead of a wall of code.
function tryParseCond(exprText) {
  return parseCondSource(exprText.slice(1, -1));
}

// What made the last parse give up, so the code-view banner can name the
// construct and point at it instead of listing everything it might have been.
// parseTemplate recurses into children, and the innermost frame is the one that
// actually found the problem — so only the first bail of a run is kept, and
// parsePage clears it before starting.
let lastBail = null;
function bail(nodes, str, at, what) {
  if (!lastBail) lastBail = { what, near: str.slice(at, at + 60) };
  return { nodes, clean: false };
}

// Parses a template string into a node tree.
// Returns {nodes, clean}; clean=false means unrepresentable content was found.
function parseTemplate(str) {
  const nodes = [];
  let pos = 0;

  while (pos < str.length) {
    const lt = str.indexOf('<', pos);
    const br = str.indexOf('{', pos);
    const next =
      lt === -1 ? br : br === -1 ? lt : Math.min(lt, br);

    // Trailing / inter-tag text. Boundary whitespace collapses to a single
    // space rather than vanishing — "people <strong>" must keep its space
    // (HTML renders a newline+indent boundary as one space too).
    const textEnd = next === -1 ? str.length : next;
    const text = str.slice(pos, textEnd);
    if (text.trim()) {
      const value =
        (/^\s/.test(text) ? ' ' : '') +
        collapseWhitespace(text) +
        (/\s$/.test(text) ? ' ' : '');
      nodes.push({ id: makeId(), kind: 'text', value });
    }
    if (next === -1) break;

    // {expression} — a recognized .map() becomes a structural loop node and a
    // recognized ternary/&& becomes a condition; anything else is kept
    // verbatim as an opaque node (may contain JSX).
    if (next === br && (lt === -1 || br < lt)) {
      const close = findMatchingBrace(str, br);
      if (close === -1) return bail(nodes, str, br, 'an unclosed { … } expression');
      const exprText = str.slice(br, close + 1);
      const structural = tryParseMap(exprText) || tryParseCond(exprText);
      nodes.push(structural || { id: makeId(), kind: 'expr', value: exprText });
      pos = close + 1;
      continue;
    }

    // Comment
    if (str.startsWith('<!--', lt)) {
      const end = str.indexOf('-->', lt + 4);
      if (end === -1) return bail(nodes, str, lt, 'an unclosed <!-- comment');
      nodes.push({ id: makeId(), kind: 'comment', value: str.slice(lt + 4, end) });
      pos = end + 3;
      continue;
    }

    // Doctype
    if (/^<!doctype/i.test(str.slice(lt))) {
      const end = str.indexOf('>', lt);
      if (end === -1) return bail(nodes, str, lt, 'an unclosed <!doctype>');
      nodes.push({ id: makeId(), kind: 'raw-line', value: str.slice(lt, end + 1) });
      pos = end + 1;
      continue;
    }

    TAG_RE.lastIndex = lt;
    const m = TAG_RE.exec(str);
    if (!m) return bail(nodes, str, lt, 'a stray < or a <> fragment');

    const [full, name, attrs, selfClose] = m;
    // One level of nested braces in an attribute ({{ a: 1 }}) is supported;
    // anything deeper would be corrupted by the attr parser — bail to code
    // view instead.
    if (/=\s*\{[^{}]*\{[^{}]*\{/.test(attrs) || /\{\s*\.\.\.[^{}]*\{[^{}]*\{/.test(attrs)) {
      return bail(nodes, str, lt, 'an attribute with deeply nested { } braces');
    }
    const isComponent = /^[A-Z]/.test(name);
    const kind = isComponent ? 'component' : 'element';
    const afterOpen = lt + full.length;

    if (selfClose === '/' || (!isComponent && VOID_ELEMENTS.has(name.toLowerCase()))) {
      nodes.push({ id: makeId(), kind, name, props: parseAttrs(attrs), children: null });
      pos = afterOpen;
      continue;
    }

    // <style>/<script>: capture inner verbatim, no parsing.
    if (!isComponent && RAW_ELEMENTS.has(name.toLowerCase())) {
      const close = str.indexOf(`</${name}`, afterOpen);
      if (close === -1) return bail(nodes, str, lt, `an unclosed <${name}> block`);
      const closeEnd = str.indexOf('>', close);
      nodes.push({
        id: makeId(),
        kind: 'raw',
        name,
        props: parseAttrs(attrs),
        inner: str.slice(afterOpen, close),
      });
      pos = closeEnd + 1;
      continue;
    }

    const closeIdx = findMatchingClose(str, afterOpen, name);
    if (closeIdx === -1) return bail(nodes, str, lt, `an unclosed <${name}> tag`);
    const innerResult = parseTemplate(str.slice(afterOpen, closeIdx));
    if (!innerResult.clean) return { nodes, clean: false }; // the inner frame recorded the cause
    nodes.push({
      id: makeId(),
      kind,
      name,
      props: parseAttrs(attrs),
      children: innerResult.nodes,
    });
    // The close tag may contain whitespace: </Name >
    pos = str.indexOf('>', closeIdx) + 1;
  }

  return { nodes, clean: true };
}

// Index of the close tag matching an already-consumed open tag, handling
// nested same-name tags.
function findMatchingClose(str, from, name) {
  const re = new RegExp(
    `<${escapeRe(name)}(?=[\\s/>])(?:[^>"']|"[^"]*"|'[^']*')*?(/?)>|</${escapeRe(name)}\\s*>`,
    'g'
  );
  re.lastIndex = from;
  let depth = 1;
  let m;
  while ((m = re.exec(str)) !== null) {
    if (m[0].startsWith('</')) {
      depth--;
      if (depth === 0) return m.index;
    } else if (m[1] !== '/') {
      depth++;
    }
  }
  return -1;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function collapseWhitespace(text) {
  return text.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Page parse / serialize
// ---------------------------------------------------------------------------

// Returns {editable: true, model} or {editable: false, reason}.
// model = {imports, extraFrontmatter, nodes: tree}. The page's layout wrapper
// (if any) stays in the tree as a regular node with the well-known id
// 'layout', so nodes can live before/after it at the top level.
function parsePage(source) {
  const fm = source.match(/^---\r?\n(?:([\s\S]*?)\r?\n)?---\r?\n?/);
  const frontmatter = fm ? fm[1] || '' : '';
  const body = fm ? source.slice(fm[0].length) : source;

  const imports = [];
  let extraFrontmatter = frontmatter;
  let m;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(frontmatter)) !== null) {
    imports.push({ name: m[1], path: m[2], at: m.index });
    extraFrontmatter = extraFrontmatter.replace(m[0], '');
  }
  // Named imports become one entry per specifier, so "is this name imported"
  // stays a single lookup. `named` groups them back onto one line on the way
  // out; `imported` keeps the original behind an `as` alias.
  NAMED_IMPORT_RE.lastIndex = 0;
  while ((m = NAMED_IMPORT_RE.exec(frontmatter)) !== null) {
    // `import type { … }` declares types only — nothing in it can be placed on
    // a page, and re-emitting it as a value import would break the build. Left
    // in the frontmatter text untouched.
    if (/import\s+type\s*\{/.test(m[0])) continue;
    const specs = m[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const spec of specs) {
      // An inline `type X` sits alongside real values; it's carried through so
      // the line comes back whole, but it is never a component.
      const typeOnly = /^type\s/.test(spec);
      const [imported, local] = spec
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/)
        .map((s) => s.trim());
      imports.push({
        name: local || imported,
        imported,
        path: m[2],
        named: true,
        at: m.index,
        ...(typeOnly ? { typeOnly: true } : {}),
      });
    }
    extraFrontmatter = extraFrontmatter.replace(m[0], '');
  }
  // Back into the order they were written in — the two passes above collect
  // default and named imports separately, and without this every save would
  // shuffle one group past the other.
  imports.sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity));
  extraFrontmatter = extraFrontmatter.trim();

  lastBail = null;
  const { nodes: topNodes, clean } = parseTemplate(body);
  if (!clean) {
    // Name the construct and point at it. The bail records the text it stopped
    // on, so find that text back in the file for a line number — far more
    // actionable than "something in this page".
    let where = '';
    if (lastBail) {
      const at = source.indexOf(lastBail.near);
      const line = at === -1 ? 0 : source.slice(0, at).split('\n').length;
      where = ` Found ${lastBail.what}${line ? ` on line ${line}` : ''}.`;
    }
    return {
      editable: false,
      reason: `Page contains markup the visual editor cannot represent.${where}`,
      bail: lastBail ? { what: lastBail.what, near: lastBail.near } : null,
    };
  }

  // Type-only specifiers name types, not values, so nothing on the page can be
  // one of them — they must not count as "this component is imported".
  const importsByName = Object.fromEntries(
    imports.filter((i) => !i.typeOnly).map((i) => [i.name, i])
  );

  // Layout detection: a single top-level component wrapping the whole page,
  // or — when siblings live outside it — exactly one top-level component
  // whose import path mentions "layout". The wrapper keeps its place in the
  // tree; it's just tagged with the well-known id 'layout'.
  const significant = topNodes.filter((n) => n.kind !== 'comment');
  let wrapper = null;
  if (
    significant.length === 1 &&
    significant[0].kind === 'component' &&
    significant[0].children !== null
  ) {
    wrapper = significant[0];
  } else if (significant.length > 1) {
    const layoutish = significant.filter(
      (n) =>
        n.kind === 'component' &&
        n.children !== null &&
        /layout/i.test(importsByName[n.name]?.path || '')
    );
    if (layoutish.length === 1) wrapper = layoutish[0];
  }
  if (wrapper) wrapper.id = 'layout';

  // A capitalized tag that isn't imported is a dynamic tag, not a component:
  // `const Tag = tag` then `<Tag>` is how an Astro component renders a
  // caller-chosen element. Flag those so the UI treats them as elements —
  // they have no file to open and no props of their own.
  const markDynamic = (list) => {
    for (const n of list) {
      if (n.kind === 'component') {
        const imp = importsByName[n.name];
        if (!imp) n.dynamicTag = true;
        // Astro's own <Image>/<Picture>, identified by where the name came
        // from rather than by the name itself — a project is perfectly
        // entitled to its own component called Image, and several have one.
        else if (imp.path === 'astro:assets') n.astroAsset = true;
      }
      if (Array.isArray(n.children)) markDynamic(n.children);
    }
  };
  markDynamic(topNodes);

  return { editable: true, model: { imports, extraFrontmatter, nodes: topNodes } };
}

// Writes the import block. Named specifiers that share a module are emitted
// together, at the position of the first one, so `{ Image, Picture }` comes
// back as the single line it was written as. `specFor` lets the marked writer
// rewrite a path without duplicating any of this.
function serializeImports(model, lines, specFor) {
  const done = new Set();
  for (const imp of model.imports) {
    if (done.has(imp)) continue;
    if (!imp.named) {
      lines.push(`import ${imp.name} from '${specFor ? specFor(imp) : imp.path}';`);
      continue;
    }
    const group = model.imports.filter((i) => i.named && i.path === imp.path);
    for (const g of group) done.add(g);
    const specs = group.map((g) => {
      const base = g.imported && g.imported !== g.name ? `${g.imported} as ${g.name}` : g.name;
      return g.typeOnly ? `type ${base}` : base;
    });
    lines.push(`import { ${specs.join(', ')} } from '${imp.path}';`);
  }
}

function serializePage(model) {
  const lines = ['---'];
  serializeImports(model, lines);
  if (model.extraFrontmatter) {
    lines.push('', model.extraFrontmatter);
  }
  lines.push('---');

  for (const node of model.nodes) serializeNode(node, '', lines);
  return lines.join('\n') + '\n';
}

// Inline runs (text + simple tags like <strong>/<em>) serialize on a single
// line so the exact spacing between words and tags survives the round trip.
const INLINE_TAGS = new Set([
  'strong', 'em', 'b', 'i', 'sup', 'sub', 'code', 'a', 'span', 'br',
  'small', 'mark', 'u', 's',
]);

// Simple {expr} interpolations (single braces, no JSX) count as inline.
function isSimpleExpr(n) {
  return n.kind === 'expr' && /^\{[^{}]*\}$/.test(n.value) && !n.value.includes('<');
}

function isInlineRun(nodes) {
  return (
    nodes.length > 0 &&
    nodes.every(
      (n) =>
        n.kind === 'text' ||
        isSimpleExpr(n) ||
        (n.kind === 'element' &&
          INLINE_TAGS.has(n.name.toLowerCase()) &&
          (n.children === null || n.children.length === 0 || isInlineRun(n.children)))
    )
  );
}

function inlineString(nodes) {
  let out = '';
  for (const n of nodes) {
    if (n.kind === 'text') out += n.value;
    else if (n.kind === 'expr') out += n.value;
    else if (n.children === null || n.children.length === 0) {
      out += n.name === 'br' ? '<br />' : `<${n.name}${serializeAttrs(n.props)} />`;
    } else {
      out += `<${n.name}${serializeAttrs(n.props)}>${inlineString(n.children)}</${n.name}>`;
    }
  }
  return out;
}

// A conditional without the { } that put it in markup context. An else-if
// chain is one of these directly inside another's else — writing the braces
// there would make it an object literal, not a nested condition.
function serializeCondBody(node, indent, lines) {
  const kidsOf = (i) => node.children?.[i]?.children || [];
  const thenKids = kidsOf(0);
  const elseKids = node.op === '&&' ? null : kidsOf(1);
  const chained =
    elseKids && elseKids.length === 1 && elseKids[0].kind === 'cond' ? elseKids[0] : null;
  // `()` is a syntax error, so a branch holding nothing is written as `null` —
  // the same thing a hand-written conditional does.
  const tail = elseKids === null ? '' : chained ? ' :' : elseKids.length ? ' : (' : ' : null';
  const head = `${node.test} ${node.op === '&&' ? '&&' : '?'} `;
  if (thenKids.length) {
    lines.push(indent + head + '(');
    for (const child of thenKids) serializeNode(child, indent + '  ', lines);
    lines.push(indent + ')' + tail);
  } else {
    lines.push(indent + head + 'null' + tail);
  }
  if (chained) {
    serializeCondBody(chained, indent, lines);
  } else if (elseKids && elseKids.length) {
    for (const child of elseKids) serializeNode(child, indent + '  ', lines);
    lines.push(indent + ')');
  }
}

function serializeNode(node, indent, lines) {
  // Chunk containers: children live in external .html files (set:html),
  // never in the page — emit the component self-closing, skip the subtree.
  if (node.kind === 'chunk-group') return; // synthetic, not in page source
  if (node.chunkFile || node.chunkAggregate) {
    lines.push(`${indent}<${node.name}${serializeAttrs(node.props)} />`);
    return;
  }
  switch (node.kind) {
    case 'text':
      lines.push(indent + node.value);
      return;
    case 'expr': {
      // Verbatim, multi-line safe: only the first line gets the tree indent
      // (subsequent lines carry their original indentation).
      const exprLines = node.value.split('\n');
      lines.push(indent + exprLines[0]);
      for (let i = 1; i < exprLines.length; i++) lines.push(exprLines[i]);
      return;
    }
    case 'map': {
      lines.push(indent + '{');
      // A loop whose body declares things keeps the statement form: the
      // declarations, then the markup inside `return ( … )`.
      if (node.body && node.body.length) {
        lines.push(indent + '  ' + blockHead(node.head));
        for (const line of node.body) lines.push(indent + '    ' + line);
        lines.push(indent + '    return (');
        for (const child of node.children || []) {
          serializeNode(child, indent + '      ', lines);
        }
        lines.push(indent + '    );');
        lines.push(indent + '  })');
        lines.push(indent + '}');
        return;
      }
      // Untouched heads keep the lines they were written on; an edited one is
      // written as the single line the Loop field holds.
      const kept =
        node.headSource && normalizeHead(node.headSource) === node.head ? node.headSource : null;
      // The body belongs under `.map(`, which on a chain written across lines
      // is indented past the head's own first line — so the loop's contents
      // hang off the LAST head line, not off the node.
      let inner = '';
      if (kept) {
        const headLines = kept.split('\n');
        for (const line of headLines) lines.push(line ? indent + '  ' + line : '');
        inner = headLines[headLines.length - 1].match(/^[ \t]*/)[0];
      } else {
        lines.push(indent + '  ' + node.head);
      }
      for (const child of node.children || []) {
        serializeNode(child, indent + '  ' + inner + '  ', lines);
      }
      lines.push(indent + '  ' + inner + '))');
      lines.push(indent + '}');
      return;
    }
    case 'cond':
      lines.push(indent + '{');
      serializeCondBody(node, indent + '  ', lines);
      lines.push(indent + '}');
      return;
    case 'branch':
      // Written by the condition above; standing on its own it is just its
      // contents.
      for (const child of node.children || []) serializeNode(child, indent, lines);
      return;
    case 'comment':
      lines.push(`${indent}<!--${node.value}-->`);
      return;
    case 'raw-line':
      lines.push(indent + node.value);
      return;
    case 'raw': {
      lines.push(`${indent}<${node.name}${serializeAttrs(node.props)}>`);
      // Keep raw inner verbatim (trim outer blank lines only).
      const inner = node.inner.replace(/^\r?\n/, '').replace(/\s+$/, '');
      if (inner) lines.push(inner);
      lines.push(`${indent}</${node.name}>`);
      return;
    }
    default: {
      const attrs = serializeAttrs(node.props);
      if (node.children === null) {
        lines.push(`${indent}<${node.name}${attrs} />`);
        return;
      }
      // Inline runs stay on one line: <p>We're <strong>Acme</strong>.</p>
      if (node.children.length > 0 && isInlineRun(node.children)) {
        lines.push(`${indent}<${node.name}${attrs}>${inlineString(node.children).trim()}</${node.name}>`);
        return;
      }
      lines.push(`${indent}<${node.name}${attrs}>`);
      for (const child of node.children) serializeNode(child, indent + '  ', lines);
      lines.push(`${indent}</${node.name}>`);
    }
  }
}

// Dev-preview variant used by the marker Vite plugin: wraps every node in
// <!--avb-s:path--> / <!--avb-e:path--> boundary comments (path = index trail,
// e.g. "0.2.1") so the preview iframe can map rendered DOM back to model nodes.
//
// Comments, not elements. A <template> is an element like any other as far as
// the tree is concerned: it counts for :nth-child, :first-child, + and ~, so
// every marker shifted the page's own structural selectors by one for as long
// as it was in the DOM — which is until the preview strips them, i.e. through
// first paint. A comment node is invisible to all of those, so the page a
// marked build renders is the page the real build renders.
// Children of {…map} loops render once per item and are left unmarked.
// Chunk subtrees can't be marked here — they render from an imported HTML
// string, not from page markup — so the ?raw import carries the Fragment's
// path and the dev plugin marks the chunk module itself. Passing it through
// the id (rather than a side map) also keys Vite's cache: move the Fragment
// and the chunk module's id changes with it.
// `prefix` namespaces every path so a component file’s markers cannot collide
// with the page’s. A page marks as "0.1"; src/components/Card.astro marks as
// "src/components/Card.astro|0.1", and the app asks for that namespace while
// that component is the file being edited.
function serializePageMarked(model, prefix = '') {
  const marks = chunkImportMarks(model);
  const lines = ['---'];
  serializeImports(model, lines, (imp) => {
    const mark = /\.html\?raw$/i.test(imp.path) ? marks.get(imp.name) : null;
    return mark ? `${imp.path}&avb=${mark.path}${mark.group ? '&avbg=1' : ''}` : imp.path;
  });
  if (model.extraFrontmatter) {
    lines.push('', model.extraFrontmatter);
  }
  lines.push('---');
  model.nodes.forEach((node, i) => serializeNodeMarked(node, '', lines, `${prefix}${i}`));
  return lines.join('\n') + '\n';
}

// A marker that survives wherever it's put.
//
// A comment is the ideal marker — invisible to :nth-child and friends — but
// Astro's compiler DROPS html comments that are direct children of a
// component, which on a page wrapped in a layout is the entire tree. Verified
// against @astrojs/compiler: kept at the top level and inside elements,
// stripped in slot content. Where a plain comment wouldn't survive, the same
// comment goes in as raw html through a Fragment, which renders nothing of
// its own — so what lands in the DOM is still just a comment.
const markerFor = (path, kind, inSlotContent) =>
  inSlotContent
    ? `<Fragment set:html={${JSON.stringify(`<!--avb-${kind}:${path}-->`)}} />`
    : `<!--avb-${kind}:${path}-->`;

// `inSlot` says this node is a direct child of a component, i.e. slot content.
function serializeNodeMarked(node, indent, lines, path, inSlot = false) {
  if (node.kind === 'chunk-group') return; // synthetic, not in page source
  // A slotted node can't be wrapped: a marker beside it lands in the default
  // slot while the node itself renders in the named one, so the pair ends up
  // around nothing. A <template slot="…"> travels with it — but that's an
  // element, and an element is a sibling that :nth-child counts.
  //
  // An element doesn't need wrapping at all: tag it with its path directly,
  // which is the same attribute the collector writes onto every element it
  // records. No extra node, nothing for a selector to trip over.
  //
  // A slotted COMPONENT still gets the <template> pair: an attribute on an
  // instance is a prop, and only reaches the DOM if that component spreads
  // its rest props — so it can't be relied on to carry the mapping.
  const slotVal = node.props?.slot;
  const slotted = slotVal && slotVal.type === 'string' && !!slotVal.value;
  const tagInPlace = slotted && node.kind === 'element';
  const slotAttr = slotted ? ` slot="${slotVal.value}"` : '';
  if (!tagInPlace) {
    lines.push(
      slotted
        ? `${indent}<template${slotAttr} data-avb-s="${path}"></template>`
        : indent + markerFor(path, 's', inSlot)
    );
  }
  // Serialized with the path attribute already on it, in that one case.
  const markedProps = tagInPlace
    ? { ...node.props, 'data-avb-p': { type: 'string', value: path } }
    : node.props;
  if (
    (node.kind === 'component' || node.kind === 'element') &&
    !node.chunkFile &&
    !node.chunkAggregate &&
    Array.isArray(node.children) &&
    // Inline runs serialize as one line — markers between words would break
    // spacing (each marker's surrounding newlines render as a space).
    !(node.children.length > 0 && isInlineRun(node.children))
  ) {
    const attrs = serializeAttrs(markedProps);
    lines.push(`${indent}<${node.name}${attrs}>`);
    node.children.forEach((child, i) =>
      serializeNodeMarked(child, indent + '  ', lines, `${path}.${i}`, node.kind === 'component')
    );
    lines.push(`${indent}</${node.name}>`);
  } else if (node.kind === 'map') {
    // Loop children render once per item, so their marker pairs repeat in
    // the DOM — the collector unions every instance into one region.
    lines.push(indent + '{');
    if (node.body && node.body.length) {
      lines.push(indent + '  ' + blockHead(node.head));
      for (const line of node.body) lines.push(indent + '    ' + line);
      lines.push(indent + '    return (');
      (node.children || []).forEach((child, i) =>
        serializeNodeMarked(child, indent + '      ', lines, `${path}.${i}`, inSlot)
      );
      lines.push(indent + '    );');
      lines.push(indent + '  })');
      lines.push(indent + '}');
      return;
    }
    lines.push(indent + '  ' + node.head);
    (node.children || []).forEach((child, i) =>
      serializeNodeMarked(child, indent + '    ', lines, `${path}.${i}`, inSlot)
    );
    lines.push(indent + '  ))');
    lines.push(indent + '}');
  } else if (node.kind === 'cond') {
    // Both branches keep their parens here whether or not they hold anything:
    // the branch's own marker templates are inside them, so they're never the
    // empty `()` the plain writer has to avoid.
    //
    // …and inside those parens goes a <Fragment>. A branch always emits at
    // least three things — its opening marker, its contents, its closing
    // marker — and `cond && ( a b c )` is not valid JSX: the parens hold one
    // expression, not a list. Without the wrapper the compiler stops at the
    // first token after the markers ("Expected `,` or `)` but found `{`") and
    // the page won't build. Fragment renders no element, so the markers stay
    // siblings of the content in the DOM, which is what the canvas needs.
    const branches = node.children || [];
    const inner = indent + '    ';
    const branchOut = (branch, i) => {
      lines.push(inner + '<Fragment>');
      if (branch) serializeNodeMarked(branch, inner + '  ', lines, `${path}.${i}`);
      lines.push(inner + '</Fragment>');
    };
    lines.push(indent + '{');
    lines.push(indent + '  ' + node.test + (node.op === '&&' ? ' && (' : ' ? ('));
    branchOut(branches[0], 0);
    if (node.op === '&&') {
      lines.push(indent + '  )');
    } else {
      lines.push(indent + '  ) : (');
      branchOut(branches[1], 1);
      lines.push(indent + '  )');
    }
    lines.push(indent + '}');
  } else if (node.kind === 'branch') {
    // No markup of its own — just its contents, wrapped by the marker pair
    // this function already emits around every node.
    (node.children || []).forEach((child, i) =>
      serializeNodeMarked(child, indent, lines, `${path}.${i}`, inSlot)
    );
  } else {
    serializeNode(tagInPlace ? { ...node, props: markedProps } : node, indent, lines);
  }
  if (!tagInPlace) {
    lines.push(
      slotted
        ? `${indent}<template${slotAttr} data-avb-e="${path}"></template>`
        : indent + markerFor(path, 'e', inSlot)
    );
  }
}

// ---------------------------------------------------------------------------
// Component prop schema extraction
// ---------------------------------------------------------------------------

// Returns [{name, type: 'string'|'number'|'boolean'|'other', optional, default}]
// Splits a type expression on a top-level operator, ignoring ones inside
// braces, parens, brackets or strings.
function splitTypeTop(expr, op) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < expr.length; i++) {
    const skipped = skipStringOrComment(expr, i);
    if (skipped !== i) {
      i = skipped - 1;
      continue;
    }
    const c = expr[i];
    if ('([{<'.includes(c)) depth++;
    else if (')]}>'.includes(c)) depth--;
    else if (c === op && depth === 0) {
      out.push(expr.slice(start, i));
      start = i + 1;
    }
  }
  out.push(expr.slice(start));
  return out.map((x) => x.trim()).filter(Boolean);
}

// A member block written on one line (`{ variant: "fixed"; sizes?: never }`)
// holds several members between semicolons. Both walkers below read one member
// per line, so the top-level semicolons become newlines first — nested ones
// (inside a nested object or a generic) are left alone.
function explodeMembers(block) {
  return splitTypeTop(block, ';').join('\n');
}

function parsePropSchema(source) {
  const fm = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const frontmatter = fm ? fm[1] : '';
  const schema = new Map();

  // Collect local type aliases (type HeadingTag = "h1" | "h2" | ...) so props
  // referencing them resolve to their union options.
  //
  // The declaration ends at the semicolon that closes it, which has to be
  // found by scanning: stopping at the first `;` truncates any alias whose
  // body is an object, because every member ends in one — `type Base = { a:
  // string; b: number }` would come back as `{ a: string`.
  const aliases = new Map();
  const declRe = /(?:^|\n)\s*(?:export\s+)?(type|interface)\s+([A-Za-z_$][\w$]*)\s*/g;
  let dm;
  while ((dm = declRe.exec(frontmatter)) !== null) {
    const after = declRe.lastIndex;
    let body;
    if (dm[1] === 'interface') {
      // `interface X extends Y { … }` — the braces are the body.
      const open = frontmatter.indexOf('{', after);
      if (open === -1) continue;
      const close = findMatchingBrace(frontmatter, open);
      if (close === -1) continue;
      const heritage = frontmatter.slice(after, open).replace(/^\s*extends\s+/, '');
      body = `${heritage} ${frontmatter.slice(open, close + 1)}`;
    } else {
      const eq = frontmatter.indexOf('=', after);
      if (eq === -1) continue;
      let i = eq + 1;
      let depth = 0;
      for (; i < frontmatter.length; i++) {
        const skipped = skipStringOrComment(frontmatter, i);
        if (skipped !== i) {
          i = skipped - 1;
          continue;
        }
        const c = frontmatter[i];
        if ('([{'.includes(c)) depth++;
        else if (')]}'.includes(c)) depth--;
        else if (c === ';' && depth === 0) break;
      }
      body = frontmatter.slice(eq + 1, i);
    }
    aliases.set(dm[2], body.trim());
  }

  // Which type describes the props. `Astro.props as X` names it outright;
  // otherwise it's Props. Both are consulted when both exist — a component can
  // export a strict discriminated `Props` and destructure through a widened
  // alias, and between them they hold the whole picture.
  const asType = frontmatter.match(/Astro\.props\s+as\s+([A-Za-z_$][\w$]*)/);
  const propsDecl = frontmatter.match(
    /(?:export\s+)?(?:interface|type)\s+Props\b\s*(?:extends\s+([^{=]+))?(?:=)?\s*([\s\S]*?)(?=\n(?:export\s+)?(?:type|interface|const|let|function|\/\/|\/\*)|\n---|$)/
  );

  // Every object-literal block that makes up a type expression. Intersections
  // and unions are flattened and local aliases are followed, so
  // `Base & ({ a } | { b })` yields Base's members plus both branches. A prop
  // in ANY branch is a prop the component can take.
  const memberBlocks = (expr, seen = new Set(), out = []) => {
    if (!expr || seen.size > 12) return out;
    let i = 0;
    while (i < expr.length) {
      if (expr[i] === '{') {
        const close = findMatchingBrace(expr, i);
        if (close === -1) break;
        out.push(expr.slice(i + 1, close));
        i = close + 1;
        continue;
      }
      const id = /^[A-Za-z_$][\w$]*/.exec(expr.slice(i));
      if (id) {
        if (aliases.has(id[0]) && !seen.has(id[0])) {
          seen.add(id[0]);
          memberBlocks(aliases.get(id[0]), seen, out);
        }
        i += id[0].length;
        continue;
      }
      i++;
    }
    return out;
  };

  const blocks = [];
  if (propsDecl) {
    // `interface Props extends HTMLAttributes<"button">` — the extended type
    // is part of the shape too.
    if (propsDecl[1]) memberBlocks(propsDecl[1], new Set(), blocks);
    memberBlocks(propsDecl[2], new Set(), blocks);
  }
  if (asType && aliases.has(asType[1])) memberBlocks(aliases.get(asType[1]), new Set(), blocks);

  // A discriminated union says which props go together: `variant: "densities"`
  // comes with `densities`, and `widths`/`sizes` belong to the responsive
  // branch. Flattening loses that, and the panel ends up offering every prop
  // at once — including the ones the union has already ruled out. So the
  // branches are kept, and each prop records which discriminant values it is
  // actually available under.
  // A union of shapes says which props go together. Two ways it discriminates,
  // and a component may use either:
  //
  //   by value     variant: "responsive" | "densities" | "fixed"
  //   by presence  { href: string; type?: never } | { href?: never; type?: … }
  //
  // Both reduce to the same table — per branch, which props it FORBIDS
  // (`never`) and which values it PINS — and the panel decides what to show by
  // matching the node's current props against it. Flattening the union instead
  // offers every prop at once, including ones the type has already ruled out.
  const unionTables = [];
  const collectUnions = (expr, seen = new Set()) => {
    if (!expr) return;
    for (const part of splitTypeTop(expr, '&')) {
      // The declaration's own semicolon rides along on the last part.
      const inner = part.replace(/;\s*$/, '').replace(/^\(([\s\S]*)\)$/, '$1');
      const arms = splitTypeTop(inner, '|');
      if (arms.length >= 2) {
        // An arm is an object literal, a named alias, or an intersection of
        // them — resolve each to the members it contributes.
        const branches = arms.map((a) => memberBlocks(a, new Set(), []));
        if (branches.every((b) => b.length)) {
          unionTables.push(branches.map((blocks) => blocks.join('\n')));
          continue;
        }
      }
      const id = inner.match(/^[A-Za-z_$][\w$]*$/);
      if (id && aliases.has(id[0]) && !seen.has(id[0])) {
        seen.add(id[0]);
        collectUnions(aliases.get(id[0]), seen);
      }
    }
  };
  collectUnions(propsDecl && propsDecl[2]);
  collectUnions(asType && aliases.get(asType[1]));

  const memberEntries = (block) => {
    const out = new Map();
    for (const line of explodeMembers(block).split('\n')) {
      const m = line.trim().match(/^(?:readonly\s+)?([\w$]+)\??\s*:\s*([^;\n]+?)[;,]?\s*$/);
      if (m) out.set(m[1], m[2].trim());
    }
    return out;
  };
  const unions = [];
  for (const branchBlocks of unionTables) {
    const maps = branchBlocks.map(memberEntries);
    const names = new Set(maps.flatMap((m) => [...m.keys()]));
    const branches = maps.map((m) => {
      const forbids = [];
      const pins = {};
      for (const name of names) {
        const t = m.get(name);
        if (!t) continue;
        // A branch only PINS a prop when it fixes it to one value. A union of
        // its own (`"primary" | "secondary"`) fixes nothing — and it starts
        // and ends with a quote, so a naive literal test reads the whole thing
        // as one string and pins garbage.
        const single = splitTypeTop(t, '|').length === 1;
        if (t === 'never') forbids.push(name);
        else if (single && /^(['"`]).*\1$/.test(t)) pins[name] = t.slice(1, -1);
        else if (single && /^(true|false|-?\d+(\.\d+)?)$/.test(t)) pins[name] = t;
      }
      return { forbids, pins };
    });
    // A union that forbids nothing and pins nothing tells the panel nothing.
    if (branches.some((b) => b.forbids.length || Object.keys(b.pins).length)) {
      unions.push({ names: [...names], branches });
    }
  }

  // Raw type strings per prop, gathered across every block, so a prop split
  // over a discriminated union comes back as the union of what it can be —
  // `"responsive"` here and `"fixed"` there is one three-option enum, not
  // three separate one-option ones.
  const rawTypes = new Map();
  const noted = new Map();

  for (const block of blocks) {
    // Walked line by line rather than matched in one pass, so the comment
    // above a prop can be carried onto it — that's the prop's documentation,
    // and the panel shows it as the field's help text.
    const entryRe = /^\s*(?:readonly\s+)?([\w$]+)(\?)?\s*:\s*([^;\n]+?)[;,]?\s*$/;
    let doc = [];
    let inBlock = false;
    for (const rawLine of explodeMembers(block).split('\n')) {
      const line = rawLine.trim();
      if (inBlock) {
        // Closing a block that opened on an earlier line.
        const end = line.indexOf('*/');
        doc.push((end === -1 ? line : line.slice(0, end)).replace(/^\*+\s?/, ''));
        if (end !== -1) inBlock = false;
        continue;
      }
      if (line.startsWith('/*')) {
        const end = line.indexOf('*/');
        doc.push((end === -1 ? line.slice(2) : line.slice(2, end)).replace(/^\*+\s?/, ''));
        inBlock = end === -1;
        continue;
      }
      if (line.startsWith('//')) {
        doc.push(line.slice(2).trim());
        continue;
      }
      // A blank line ends a comment's reach — otherwise a note about the
      // interface itself would land on whatever prop happens to come next.
      if (!line) {
        doc = [];
        continue;
      }
      const m = line.match(entryRe);
      if (!m) {
        doc = [];
        continue;
      }
      const name = m[1];
      let typeStr = m[3].trim();
      if (aliases.has(typeStr)) typeStr = aliases.get(typeStr);
      // `never` is how a union branch says "not in this shape" — it describes
      // the branch, not the prop, so it contributes no type and no
      // optionality. It DOES fix the prop's position though: a component that
      // writes `href?: never` above `type` is saying where href belongs, and
      // skipping the line outright would only register href in a later branch
      // and sort it to the bottom.
      if (typeStr === 'never') {
        if (!rawTypes.has(name)) rawTypes.set(name, { parts: [], optional: false });
      } else {
        if (!rawTypes.has(name)) rawTypes.set(name, { parts: [], optional: false });
        const rec = rawTypes.get(name);
        for (const part of typeStr.split('|').map((x) => x.trim()).filter(Boolean)) {
          if (part !== 'never' && !rec.parts.includes(part)) rec.parts.push(part);
        }
        if (m[2]) rec.optional = true;
      }
      const text = doc.join(' ').replace(/\s+/g, ' ').trim();
      if (text && !noted.has(name)) noted.set(name, text);
      doc = [];
    }
  }

  for (const [name, rec] of rawTypes) {
    const { type, options } = normalizeType(rec.parts.join(' | '));
    schema.set(name, {
      name,
      type,
      options,
      optional: rec.optional,
      default: undefined,
      doc: noted.get(name),
      // The union shapes this component declares, so the panel can show only
      // the branch that matches what's currently set. Same table on every
      // field — it describes the type, not the prop.
      unions: unions.length ? unions : undefined,
    });
  }

  const destructure = frontmatter.match(/(?:const|let)\s*\{([\s\S]*?)\}\s*=\s*Astro\.props/);
  if (destructure) {
    // Rest params (...rest) aren't real props, and renames (class: className)
    // should register under the real prop name only.
    destructure[1] = destructure[1]
      .replace(/\.\.\.\s*\w+/g, '')
      .replace(/(\w+)\s*:\s*\w+/g, '$1');
    // Defaults can be quoted strings, shallow object/array literals ({} or
    // { a: 1 }), or plain expressions — the literal alternatives come first
    // so `= {}` isn't truncated at the closing brace.
    const entryRe =
      /(\w+)(?:\s*=\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\{[^{}]*\}|\[[^\][]*\]|[^,\n}]+))?/g;
    let m;
    while ((m = entryRe.exec(destructure[1])) !== null) {
      if (!m[1]) continue;
      const existing = schema.get(m[1]) || {
        name: m[1],
        type: 'other',
        optional: true,
        default: undefined,
      };
      if (m[2] !== undefined) {
        let def = m[2].trim();
        if (/^["'`]/.test(def)) {
          existing.default = def.slice(1, -1);
          if (existing.type === 'other') existing.type = 'string';
        } else if (/^(true|false)$/.test(def)) {
          existing.default = def === 'true';
          if (existing.type === 'other') existing.type = 'boolean';
        } else if (/^-?\d+(\.\d+)?$/.test(def)) {
          existing.default = Number(def);
          if (existing.type === 'other') existing.type = 'number';
        } else {
          // Not a literal — an identifier or expression (e.g. SITE_TITLE).
          // Flag it so the scanner can try resolving it to a real value.
          existing.default = def;
          existing.defaultExpr = true;
          // An object-literal default marks an attributes-object prop.
          if (existing.type === 'other' && /^\{/.test(def)) existing.type = 'attrs';
        }
        existing.optional = true;
      }
      schema.set(m[1], existing);
    }
  }

  // A prop's fallback isn't always a destructure default. Two more places it
  // is stated plainly, both worth showing as a field's placeholder so the
  // panel can say what happens when you leave it alone:
  //
  //   const alt = altProp ?? "";                     a renamed prop's fallback
  //   /** Output format. Defaults to `webp`. */      the doc comment
  //
  // Only literal values are taken. "Defaults to whatever Astro picks" is prose
  // and stays prose — a placeholder that isn't a real value would be a lie
  // about what the component does.
  for (const field of schema.values()) {
    if (field.default !== undefined) continue;

    // `const x = xProp ?? <literal>` / `const x = props.x ?? <literal>`
    const nullish = frontmatter.match(
      new RegExp(
        `(?:const|let)\\s+${field.name}\\s*=\\s*[\\w.]+\\s*\\?\\?\\s*("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|\`[^\`]*\`|true|false|-?\\d+(?:\\.\\d+)?)`
      )
    );
    if (nullish) {
      const lit = nullish[1];
      field.default = /^["'\`]/.test(lit)
        ? lit.slice(1, -1)
        : /^(true|false)$/.test(lit)
          ? lit === 'true'
          : Number(lit);
      continue;
    }

    // "Defaults to `webp`", "Default: 2", "Defaults to `[1, 2]`". The
    // backticked form is tried first and taken whole — a value like `[1, 2]`
    // contains the comma the bare form has to stop at.
    const stated =
      (field.doc && field.doc.match(/defaults?\s*(?:to|:)\s*\`([^\`]+)\`/i)) ||
      (field.doc && field.doc.match(/defaults?\s*(?:to|:)\s*([^\`.,;]+)/i));
    if (stated) {
      const text = stated[1].trim().replace(/^["']|["']$/g, '');
      // Only when it names a value, not a sentence about one.
      // "Defaults to `webp`, or `svg` for SVG sources" is TWO answers, and
      // which one applies depends on the value of another prop — something
      // only the component can work out. Asserting the first would have the
      // panel show `webp` while the build emits `svg`. So a conditional
      // default is reported as the whole clause, for the field to show as a
      // hint, and no single value is claimed.
      const conditional = /defaults?\s*(?:to|:)\s*[^.]*?\bor\b[^.]*?\b(?:for|when|if|on)\b/i.test(field.doc);
      if (conditional) {
        const clause = field.doc.match(/defaults?\s*(?:to|:)\s*([^.]+)/i);
        if (clause) {
          field.hint = clause[1]
            .replace(/`/g, '')
            .replace(/\s+/g, ' ')
            .replace(/\s*passthrough\s*/i, ' ')
            .trim();
        }
        continue;
      }
      if (text && text.length <= 24 && !/\s(the|a|an|whatever|sensible)\s/i.test(` ${text} `)) {
        field.default = /^-?\d+(\.\d+)?$/.test(text) ? Number(text) : text;
        continue;
      }
    }

    // Some fallbacks are a behaviour rather than a value — "it is inferred",
    // "Astro picks sensible ones". There is nothing to prefill, but a field
    // that says `inferred` still answers "what happens if I leave this?".
    // Kept as `hint`, not `default`: it is not a value, so nothing may treat
    // it as one (the enum's unset-shows-default logic, for instance).
    const phrase =
      field.doc &&
      field.doc.match(
        /\b(?:is|are)\s+(inferred|automatic|calculated)\b|\b(inferred|automatic)\s+from\b|\b([A-Z][\w ]{0,24}?picks[\w ]{0,20}?)\s+by default\b|\bdefaults?\s*(?:to|:)\s*([^.]+)/i
      );
    if (phrase) {
      // To the end of the sentence, not a fixed number of word characters —
      // "the image service's own default" was coming back as "the image
      // service", which reads like a value rather than the shrug it is.
      const text = (phrase[1] || phrase[2] || phrase[3] || phrase[4] || '')
        .replace(/`/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (text && text.length <= 48) field.hint = text;
    }
  }

  return [...schema.values()];
}

// Slot names a component's template exposes: 'default' for <slot>/<slot />,
// plus any <slot name="x">. Default first, then named in appearance order.
function parseSlots(source) {
  const fm = source.match(/^---\r?\n(?:[\s\S]*?\r?\n)?---\r?\n?/);
  const body = fm ? source.slice(fm[0].length) : source;
  const found = new Set();
  const re = /<slot\b((?:[^>"'{]|"[^"]*"|'[^']*'|\{[^}]*\})*?)\/?>/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const nameMatch = m[1].match(/\bname\s*=\s*(?:"([^"]*)"|'([^']*)')/);
    found.add(nameMatch ? nameMatch[1] ?? nameMatch[2] : 'default');
  }
  const named = [...found].filter((s) => s !== 'default');
  return found.has('default') ? ['default', ...named] : named;
}

// Extracts the tag from `interface Props extends HTMLAttributes<"button">`
// so the UI can offer that element's built-in attributes (type, disabled, …).
function parseExtendsTag(source) {
  const fm = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const frontmatter = fm ? fm[1] : '';
  const m = frontmatter.match(
    /interface\s+Props\s+extends\s+(?:astroHTML\.JSX\.)?HTMLAttributes\s*<\s*['"](\w+)['"]\s*>/
  );
  return m ? m[1] : null;
}

function normalizeType(t) {
  // Union of string literals ('primary' | 'secondary') → enum with options.
  const parts = t.split('|').map((s) => s.trim()).filter(Boolean);
  if (parts.length > 1) {
    const literals = parts.filter((p) => /^(['"`]).*\1$/.test(p));
    const rest = parts.filter((p) => !/^(['"`]).*\1$/.test(p));
    if (literals.length >= 2 && rest.every((p) => p === 'undefined' || p === 'null')) {
      return { type: 'enum', options: literals.map((p) => p.slice(1, -1)) };
    }
  }
  // Arrays, tuples and object literals are values only JS can express —
  // `number[]`, `(number | \`${number}x\`)[]`, `{ a: 1 }`. They must be checked
  // BEFORE the primitive prefixes, or `number[]` reads as a plain number and
  // the field writes `widths="400"` where the component wants `widths={[400]}`.
  // A text field here produces a string, and the component does .map on it.
  const arrayish = /\[\s*\]\s*$/.test(t) || /^Array\s*</.test(t) || /^\[[\s\S]*\]$/.test(t);
  // A plain bag of attributes still edits as name/value rows — that reads far
  // better than a JS literal. Only when it can also be an ARRAY does it have
  // to become code, since rows cannot express one.
  if (/^(HTMLAttributes\b|astroHTML\.|Record\s*<)/.test(t) && !arrayish) return { type: 'attrs' };
  if (arrayish || /^\{[\s\S]*\}$/.test(t)) return { type: 'code' };
  if (/^string\b/.test(t)) return { type: 'string' };
  if (/^number\b/.test(t)) return { type: 'number' };
  if (/^boolean\b/.test(t)) return { type: 'boolean' };
  if (/^(['"`]).*\1$/.test(t)) return { type: 'string' };
  // Objects of attributes (HTMLAttributes<"div">, Record<string, …>) edit
  // as name/value rows.
  if (/^(HTMLAttributes\b|astroHTML\.|Record\s*<)/.test(t)) return { type: 'attrs' };
  return { type: 'other' };
}

// Serializes a plain node list (used for standalone HTML chunk files).
function serializeNodes(nodes) {
  const lines = [];
  for (const node of nodes) serializeNode(node, '', lines);
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// HTML chunks
// ---------------------------------------------------------------------------
// Pages built as <Fragment set:html={x} /> where x is an import of
// "chunks/foo.html?raw" (or a joined array of them). The chunk files' markup
// is parsed into the Fragment's children so it's editable in the navigator;
// edits are written back to the chunk file, never the page.

let chunkGroupId = 1;

function resolveChunks(model, pagePath) {
  // ident -> absolute chunk file path
  const rawImports = new Map();
  for (const imp of model.imports) {
    if (/\.html\?raw$/i.test(imp.path) && imp.path.startsWith('.')) {
      rawImports.set(
        imp.name,
        path.resolve(path.dirname(pagePath), imp.path.replace(/\?raw$/i, ''))
      );
    }
  }
  if (!rawImports.size) return;

  // const main = [a, b, c].join("") aggregations in the frontmatter.
  const aggregates = new Map();
  const aggRe = /(?:const|let)\s+(\w+)\s*=\s*\[([^\]]*)\]\s*\.join\(/g;
  let am;
  while ((am = aggRe.exec(model.extraFrontmatter || '')) !== null) {
    const idents = am[2].split(',').map((s) => s.trim()).filter(Boolean);
    if (idents.length && idents.every((i) => /^\w+$/.test(i))) {
      aggregates.set(am[1], idents);
    }
  }

  const parseChunkFile = (filePath) => {
    try {
      const { nodes, clean } = parseTemplate(fs.readFileSync(filePath, 'utf8'));
      return clean ? nodes : null;
    } catch {
      return null;
    }
  };

  const walk = (list) => {
    for (const node of list) {
      if (
        node.kind === 'component' &&
        node.props?.['set:html']?.type === 'expr' &&
        node.children == null
      ) {
        const ref = node.props['set:html'].value.trim();
        if (rawImports.has(ref)) {
          const file = rawImports.get(ref);
          const children = parseChunkFile(file);
          if (children) {
            node.chunkFile = file;
            node.children = children;
          }
          continue;
        }
        if (aggregates.has(ref)) {
          const groups = [];
          for (const ident of aggregates.get(ref)) {
            if (!rawImports.has(ident)) continue;
            const file = rawImports.get(ident);
            const children = parseChunkFile(file);
            if (children) {
              groups.push({
                id: `chunk${chunkGroupId++}`,
                kind: 'chunk-group',
                name: ident,
                chunkFile: file,
                children,
              });
            }
          }
          if (groups.length) {
            node.children = groups;
            node.chunkAggregate = true;
          }
          continue;
        }
      }
      if (Array.isArray(node.children)) walk(node.children);
    }
  };
  walk(model.nodes);
}

// Marker path each chunk import's content occupies in the tree, keyed by the
// import's identifier: the Fragment's own path for a lone chunk, the
// chunk-group's path for each member of a joined aggregate. Requires a model
// that's been through resolveChunks.
function chunkImportMarks(model) {
  const marks = new Map();
  const walk = (list, prefix) => {
    list.forEach((node, i) => {
      const p = prefix ? `${prefix}.${i}` : String(i);
      if (node.chunkFile) {
        const group = node.kind === 'chunk-group';
        const ident = group ? node.name : node.props?.['set:html']?.value?.trim();
        if (ident) marks.set(ident, { path: p, group });
      }
      if (Array.isArray(node.children)) walk(node.children, p);
    });
  };
  walk(model.nodes, '');
  return marks;
}

// Dev-preview only: the chunk's markup with the same boundary markers the
// page serializer emits, numbered from the Fragment's (or group's) path so
// chunk nodes address identically to the app's tree. A group also gets a
// marker pair of its own — nothing in the page wraps it. Returns null when
// the chunk isn't representable, so the caller can serve it unmarked.
function markChunkHtml(source, prefix, group) {
  const { nodes, clean } = parseTemplate(source);
  if (!clean) return null;
  const lines = [];
  if (group) lines.push(`<!--avb-s:${prefix}-->`);
  nodes.forEach((node, i) => serializeNodeMarked(node, '', lines, `${prefix}.${i}`));
  if (group) lines.push(`<!--avb-e:${prefix}-->`);
  return lines.join('\n') + '\n';
}

module.exports = {
  parsePage,
  serializePage,
  serializePageMarked,
  parseTemplate,
  serializeNodes,
  resolveChunks,
  markChunkHtml,
  parsePropSchema,
  parseExtendsTag,
  parseSlots,
  parseAttrs,
  serializeAttrs,
};
