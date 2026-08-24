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
const { decodeEntities, encodeText } = require('./htmlText');

const IMPORT_RE = /import\s+(\w+)\s+from\s+(['"])([^'"]+)\2;?/g;
// `import { Image, Picture } from 'astro:assets'` — Astro's own components come
// in this way, so without it <Image> looks like an unimported capitalized tag
// (a dynamic `const Tag = …`) rather than the component it is.
const NAMED_IMPORT_RE = /import\s*\{([^}]*)\}\s*from\s*(['"])([^'"]+)\2;?/g;
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

// A tag whose attributes were written across several lines keeps them there,
// as long as none of them has been edited. Compared with the whitespace taken
// out, so the question asked is "do these say the same thing", not "were they
// laid out the same way". Editing one attribute reflows the tag onto a line,
// which is the same bargain struck everywhere else here.
function attrsAsWritten(node) {
  if (!node.attrSource) return null;
  const flat = (t) => t.replace(/\s+/g, ' ').trim();
  return flat(node.attrSource) === flat(serializeAttrs(node.props)) ? node.attrSource : null;
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

function tryParseMap(exprText, base = null) {
  const inner = exprText.slice(1, -1); // strip the outer { }
  // Every form is tried: the concise matcher's lazy prefix can run past a
  // block body's `=> {`, or past a bare body's `=> <`, and match a NESTED
  // `.map((t) => (` in its markup, so its failure says nothing about whether
  // this is a block-bodied or paren-less loop.
  const inBase = base === null ? null : base + 1;
  return (
    tryParseConciseMap(inner, inBase) ||
    tryParseBareMap(inner, inBase) ||
    tryParseBlockMap(inner, inBase)
  );
}

function tryParseConciseMap(inner, base = null) {
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
  // inner starts one char into exprText, and body one char past the arrow '('.
  const parsed = parseTemplate(body, base === null ? null : base + openIdx + 1);
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

// The same loop with no parentheses around its body — `.map((x) => <Tag/>)`,
// the shape an arrow function returning a single element is usually written in.
// The body runs to the `)` that closes `.map(`, so that paren is found rather
// than assumed. Normalized to the same node the parenthesized form produces,
// with `bare` remembering how it was written.
function tryParseBareMap(inner, base = null) {
  const arrow = inner.match(
    /^([\s\S]*?\.map\(\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*)</
  );
  if (!arrow) return null;
  const headRaw = arrow[1];
  const mapOpen = headRaw.lastIndexOf('.map(') + '.map'.length;
  const mapClose = findMatchingParen(inner, mapOpen);
  if (mapClose === -1) return null;
  // After the body must come only the .map() close paren.
  if (inner.slice(mapClose + 1).trim()) return null;
  const parsed = parseTemplate(
    inner.slice(headRaw.length, mapClose),
    base === null ? null : base + headRaw.length
  );
  if (!parsed.clean) return null;
  return {
    id: makeId(),
    kind: 'map',
    head: normalizeHead(headRaw + '('), // the Loop editor reads one shape
    bare: true,
    children: parsed.nodes,
  };
}

// The same loop, written with a statement body. Normalized to the same node
// the concise form produces — head ending in `=> (` so the Loop editor reads
// it unchanged — with the declarations parked in `body` for serializing back.
function tryParseBlockMap(inner, base = null) {
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

// Whether a branch renders markup, as opposed to a value.
const branchIsMarkup = (kids) =>
  (kids || []).some((k) => k.kind !== 'expr' && k.kind !== 'text');

// The other side of a conditional whose one side is markup: a plain value, as
// an expression child.
//
// `{href ? (<a …>{heading}</a>) : (heading)}` — the LinkCard pattern — used to
// be code in the navigator, whole, because one of its branches was a bare name
// rather than a tag. Which meant a conditional around an anchor read as a wall
// of JSX, and neither the anchor nor the fallback could be selected.
//
// Written with braces, like every other expression node: it lands in JSX
// context on the canvas (inside the branch's Fragment). The writer takes them
// off again for the file, where a branch's parens are JS.
function exprBranch(raw) {
  let t = String(raw).trim();
  while (t.startsWith('(') && findMatchingParen(t, 0) === t.length - 1) {
    t = t.slice(1, -1).trim();
  }
  // Markup that failed to parse is not a value — sending it back as an opaque
  // expression would hide a real bail behind a node that looks fine.
  if (!t || t.startsWith('<')) return null;
  return [{ id: makeId(), kind: 'expr', value: `{${t}}` }];
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
    const thenRaw = text.slice(ternary.at + 1, colon.at);
    const elseRaw = text.slice(colon.at + 1);
    let thenKids = branchNodes(thenRaw);
    let elseKids = branchNodes(elseRaw);
    // One side is markup and the other is a value — the common shape of "wrap
    // this in a link when there's somewhere to go". The value side becomes an
    // expression child rather than sending the whole conditional back to code.
    // Both sides being values (`a ? "x" : "y"`) is a value, not markup, and
    // stays as it was.
    if (thenKids && !elseKids && branchIsMarkup(thenKids)) elseKids = exprBranch(elseRaw);
    else if (elseKids && !thenKids && branchIsMarkup(elseKids)) thenKids = exprBranch(thenRaw);
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
function tryParseMapWithSource(exprText, base = null) {
  const node = tryParseMap(exprText, base);
  if (node) node.source = exprText;
  return node;
}

function tryParseCond(exprText) {
  const node = parseCondSource(exprText.slice(1, -1));
  // The text it was written as. A condition that has not been edited is
  // written back exactly, rather than reflowed onto the shape this file would
  // choose — `{x && <p/>}` is not improved by becoming four lines.
  if (node) node.source = exprText;
  return node;
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
//
// `base` is the offset of `str` within the file it was read from; pass a
// number and every node comes back tagged with `start`/`end` source offsets
// (what locateSelection turns into line numbers). The editor's own parse
// leaves it null on purpose: offsets describe the file as it was on disk and
// go stale the moment the model is mutated, so only a fresh parse may use them.
function parseTemplate(str, base = null) {
  const nodes = [];
  let pos = 0;
  // Blank lines between nodes are the author's paragraphing. They are not
  // nodes themselves — the whitespace they live in is dropped — so they are
  // counted here and carried on whatever comes next, to be written back out
  // in front of it. Without this a save closed up every gap in the file.
  let pendingBlank = 0;
  // Where whitespace-only text sat between two nodes. It carries no words, so
  // it is no node — except in an inline run, where the newline and indent
  // between `</a>` and `<span>` is the space the page shows between them. The
  // run's shape isn't known until every sibling is in, so the positions are
  // noted here and the spaces put back at the end.
  const gaps = [];
  const emit = (node) => {
    if (pendingBlank) {
      node.blankBefore = pendingBlank;
      pendingBlank = 0;
    }
    nodes.push(node);
    return node;
  };

  // Tags a node with its source range and returns it — a no-op when offsets
  // weren't asked for.
  const at = (node, from, to) => {
    if (base !== null) {
      node.start = base + from;
      node.end = base + to;
    }
    return node;
  };

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
    if (!text.trim() && text) {
      // Whitespace only: no node, but remember any blank line inside it.
      const breaks = (text.match(/\n/g) || []).length;
      if (breaks > 1) pendingBlank = Math.max(pendingBlank, breaks - 1);
      if (nodes.length) gaps.push(nodes.length);
    }
    if (text.trim()) {
      // `source` when the collapsed value isn't the whole truth: a slice that
      // spans lines (the serializer hands those lines back if nothing has
      // edited the node since), and one written with entities in it — `&copy;`
      // and `©` are the same character to a reader and not to a diff, and the
      // file's own spelling is the file's to keep.
      const node = { id: makeId(), kind: 'text', value: textValue(text) };
      if (text.includes('\n') || /&[#a-zA-Z]/.test(text)) node.source = text;
      emit(at(node, pos, textEnd));
    }
    if (next === -1) break;

    // {expression} — a recognized .map() becomes a structural loop node and a
    // recognized ternary/&& becomes a condition; anything else is kept
    // verbatim as an opaque node (may contain JSX).
    if (next === br && (lt === -1 || br < lt)) {
      const close = findMatchingBrace(str, br);
      if (close === -1) return bail(nodes, str, br, 'an unclosed { … } expression');
      const exprText = str.slice(br, close + 1);
      // `{/* … */}` is a comment that happens to be written the way markup
      // requires inside JSX. It is the same thing as `<!-- … -->` to everyone
      // reading the file — and to this app, where a comment above a node is
      // that node's note — so it is one here too, remembering which of the two
      // forms it was written in so it goes back the same way.
      const jsxComment = exprText.match(/^\{\s*\/\*([\s\S]*?)\*\/\s*\}$/);
      if (jsxComment) {
        emit(at({ id: makeId(), kind: 'comment', value: jsxComment[1], jsx: true }, br, close + 1));
        pos = close + 1;
        continue;
      }
      const structural =
        tryParseMapWithSource(exprText, base === null ? null : base + br) || tryParseCond(exprText);
      emit(at(structural || { id: makeId(), kind: 'expr', value: exprText }, br, close + 1));
      pos = close + 1;
      continue;
    }

    // Comment
    if (str.startsWith('<!--', lt)) {
      const end = str.indexOf('-->', lt + 4);
      if (end === -1) return bail(nodes, str, lt, 'an unclosed <!-- comment');
      emit(at({ id: makeId(), kind: 'comment', value: str.slice(lt + 4, end) }, lt, end + 3));
      pos = end + 3;
      continue;
    }

    // Doctype
    if (/^<!doctype/i.test(str.slice(lt))) {
      const end = str.indexOf('>', lt);
      if (end === -1) return bail(nodes, str, lt, 'an unclosed <!doctype>');
      emit(at({ id: makeId(), kind: 'raw-line', value: str.slice(lt, end + 1) }, lt, end + 1));
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
      emit(at({
        id: makeId(),
        kind,
        name,
        props: parseAttrs(attrs),
        ...(attrs && attrs.includes('\n') ? { attrSource: attrs } : {}),
        // `<x/>` and `<x />` mean the same thing and are not the same text.
        ...(selfClose === '/' && !/\s\/>$/.test(full) ? { tightClose: true } : {}),
        children: null,
      }, lt, afterOpen));
      pos = afterOpen;
      continue;
    }

    // <style>/<script>: capture inner verbatim, no parsing.
    if (!isComponent && RAW_ELEMENTS.has(name.toLowerCase())) {
      const close = str.indexOf(`</${name}`, afterOpen);
      if (close === -1) return bail(nodes, str, lt, `an unclosed <${name}> block`);
      const closeEnd = str.indexOf('>', close);
      emit(at({
        id: makeId(),
        kind: 'raw',
        name,
        props: parseAttrs(attrs),
        ...(attrs && attrs.includes('\n') ? { attrSource: attrs } : {}),
        inner: str.slice(afterOpen, close),
      }, lt, closeEnd + 1));
      pos = closeEnd + 1;
      continue;
    }

    const closeIdx = findMatchingClose(str, afterOpen, name);
    if (closeIdx === -1) return bail(nodes, str, lt, `an unclosed <${name}> tag`);
    const inner = str.slice(afterOpen, closeIdx);
    const innerResult = parseTemplate(inner, base === null ? null : base + afterOpen);
    if (!innerResult.clean) return { nodes, clean: false }; // the inner frame recorded the cause
    // A run written across several lines keeps its raw inner. The tree can't
    // hold it: whitespace-only text between the tags is dropped, so the break
    // before a closing tag exists nowhere else, and the serializer needs it to
    // put a hand-wrapped paragraph back the way it found it.
    const source =
      inner.includes('\n') && (isInlineRun(innerResult.nodes) || innerResult.nodes.length === 0)
        ? inner
        : undefined;
    const blankAfter = innerResult.trailingBlank || 0;
    // The close tag may contain whitespace: </Name >
    const closeEnd = str.indexOf('>', closeIdx) + 1;
    // Kept when it is written across lines — the style that hangs the bracket
    // on its own line, which several formatters produce and which is not this
    // file's to undo.
    const closeText = str.slice(closeIdx, closeEnd);
    emit(at({
      id: makeId(),
      kind,
      name,
      ...(source === undefined ? {} : { source }),
      ...(blankAfter ? { blankAfter } : {}),
      props: parseAttrs(attrs),
      ...(attrs && attrs.includes('\n') ? { attrSource: attrs } : {}),
      ...(closeText.includes('\n') ? { closeSource: closeText } : {}),
      children: innerResult.nodes,
    }, lt, closeEnd));
    pos = closeEnd;
  }

  // The gaps that turned out to be inside an inline run become the single
  // space a browser renders them as. Without this, editing anything in
  // `<a>Docs</a> <span>/</span>` — which the serializer writes back as one
  // line — closed the words up into `Docs/`, on the page as well as in the
  // panel. A gap after the last node is the indent before the closing tag and
  // renders as nothing, so it is left out.
  if (gaps.length && isInlineRun(nodes)) {
    for (let i = gaps.length - 1; i >= 0; i--) {
      if (gaps[i] >= nodes.length) continue;
      nodes.splice(gaps[i], 0, { id: makeId(), kind: 'text', value: ' ' });
    }
  }
  return { nodes, clean: true, trailingBlank: pendingBlank };
}

// Index of the close tag matching an already-consumed open tag, handling
// nested same-name tags.
//
// Text inside a <script>, a <style> or a comment is not markup, and counting
// it as markup loses the whole page. A Webflow export had a script with
// `/* Find the closest parent <section> for hover events */` in it: seven
// `<section`s to this scan and six closes, so the section that really did
// close never balanced, and a page with nothing wrong with it opened as code
// with "an unclosed <section> tag" over it. The same words in an HTML comment
// did the same thing.
//
// So those three are stepped over rather than read. A run that never ends is
// not treated as fatal here — it is only text this scan can't use — so the
// scan carries on past the opener and whatever is really wrong with the page
// is reported by the parse itself.
function findMatchingClose(str, from, name) {
  const tag = escapeRe(name);
  const re = new RegExp(
    `<!--|<(script|style)(?=[\\s/>])|<${tag}(?=[\\s/>])(?:[^>"']|"[^"]*"|'[^']*')*?(/?)>|</${tag}\\s*>`,
    'g'
  );
  re.lastIndex = from;
  let depth = 1;
  let m;
  while ((m = re.exec(str)) !== null) {
    const [full, raw, selfClose] = m;
    if (full === '<!--') {
      const end = str.indexOf('-->', m.index + 4);
      re.lastIndex = end === -1 ? m.index + 4 : end + 3;
      continue;
    }
    if (raw) {
      const end = str.indexOf(`</${raw}`, m.index + full.length);
      const after = end === -1 ? -1 : str.indexOf('>', end);
      re.lastIndex = after === -1 ? m.index + full.length : after + 1;
      continue;
    }
    if (full.startsWith('</')) {
      depth--;
      if (depth === 0) return m.index;
    } else if (selfClose !== '/') {
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

// The words, with every run of whitespace inside them squeezed to one space,
// and a single space kept at either end where the source had any — a
// newline-and-indent boundary renders as one space, and "people
// <strong>Acme</strong>" would otherwise lose the gap. The source's own
// spelling is kept: entities are still entities here.
function collapseText(raw) {
  return (
    (/^\s/.test(raw) ? ' ' : '') + collapseWhitespace(raw) + (/\s$/.test(raw) ? ' ' : '')
  );
}

// What a text node HOLDS: the characters, not the file's spelling of them.
// `&copy;&#160;` is one character and a space, and a panel over a rendered page
// has to say what the page says. Decoded after the whitespace above, not
// before: `&#160;` is a space to `\s`, and collapsing it away would delete the
// very character it was written to insist on.
//
// Shared with the serializer, which recomputes it to tell an edited node from
// an untouched one.
function textValue(raw) {
  return decodeEntities(collapseText(raw));
}

// ---------------------------------------------------------------------------
// Page parse / serialize
// ---------------------------------------------------------------------------

// Returns {editable: true, model} or {editable: false, reason}.
// model = {imports, extraFrontmatter, nodes: tree}. The page's layout wrapper
// (if any) stays in the tree as a regular node with the well-known id
// 'layout', so nodes can live before/after it at the top level.
// `opts.locs` records source offsets on every node and the body's own start
// offset on the model — for reading a location out of the file on disk, not
// for the editor's live model (see parseTemplate).
function parsePage(source, opts = {}) {
  const fm = source.match(/^---\r?\n(?:([\s\S]*?)\r?\n)?---\r?\n?/);
  const frontmatter = fm ? fm[1] || '' : '';
  const hadFrontmatter = !!fm;
  const bodyStart = fm ? fm[0].length : 0;
  const body = source.slice(bodyStart);

  const imports = [];
  // Where each import's text sits, so the block can be cut out by position.
  // A `.replace(m[0], '')` left behind the line break that ended the
  // statement, and the blank lines those leave built up on every save.
  const cuts = [];
  let m;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(frontmatter)) !== null) {
    imports.push({ name: m[1], path: m[3], quote: m[2], at: m.index });
    cuts.push([m.index, m.index + m[0].length]);
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
        path: m[3],
        quote: m[2],
        named: true,
        at: m.index,
        ...(typeOnly ? { typeOnly: true } : {}),
      });
    }
    cuts.push([m.index, m.index + m[0].length]);
  }
  // Back into the order they were written in — the two passes above collect
  // default and named imports separately, and without this every save would
  // shuffle one group past the other.
  imports.sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity));
  cuts.sort((a, b) => a[0] - b[0]);

  // Whatever stands above the first import belongs above it. A page that
  // opens with a `/** … */` describing it had that comment hoisted below the
  // import block by every save — a loud diff for an edit that never went
  // near it. Anything between or after the imports still gathers below them,
  // which is where it already was.
  const firstImport = cuts.length ? cuts[0][0] : -1;
  const frontmatterLead = firstImport === -1 ? '' : frontmatter.slice(0, firstImport).trim();
  let rest = firstImport === -1 ? frontmatter : frontmatter.slice(firstImport);
  // Back to front, so an earlier cut can't shift a later one's offsets. The
  // statement goes with the line break that ended it, or removing it would
  // leave the blank line behind.
  for (let i = cuts.length - 1; i >= 0; i--) {
    const from = cuts[i][0] - firstImport;
    const to = cuts[i][1] - firstImport;
    const eol = rest.slice(to).match(/^[ \t]*\r?\n/);
    rest = rest.slice(0, from) + rest.slice(eol ? to + eol[0].length : to);
  }
  // Whether a blank line stood between the import block and what follows.
  // Writing one unconditionally moved `import type { … }` — which stays in the
  // frontmatter text, being a type and never a component — a line further
  // down on every save.
  const extraFrontmatterSpaced = /^[ \t]*\r?\n/.test(rest);
  const extraFrontmatter = rest.trim();

  lastBail = null;
  const { nodes: topNodes, clean, trailingBlank } = parseTemplate(body, opts.locs ? bodyStart : null);
  // A newline at the very start of the body is a blank line, because the
  // frontmatter's closing --- already ended its own line. Everywhere else a
  // leading newline is just the break after the tag before it, which is why
  // parseTemplate counts one fewer — so the first node is told directly.
  if (topNodes.length) {
    const lead = (body.match(/^(?:[ \t]*\r?\n)+/) || [''])[0];
    const blanks = (lead.match(/\n/g) || []).length;
    if (blanks) topNodes[0].blankBefore = blanks;
    else delete topNodes[0].blankBefore;
  }
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

  return {
    editable: true,
    model: {
      imports,
      frontmatterLead,
      extraFrontmatter,
      extraFrontmatterSpaced,
      hadFrontmatter,
      trailingBlank,
      nodes: topNodes,
      // Only when offsets were asked for: it describes the file on disk, and
      // the live model is edited out from under it.
      ...(opts.locs ? { bodyStart } : {}),
    },
  };
}

// Writes the import block. Named specifiers that share a module are emitted
// together, at the position of the first one, so `{ Image, Picture }` comes
// back as the single line it was written as. `specFor` lets the marked writer
// rewrite a path without duplicating any of this.
function serializeImports(model, lines, specFor) {
  const done = new Set();
  for (const imp of model.imports) {
    if (done.has(imp)) continue;
    // Whichever quote the file used. Rewriting every import line to change
    // one character is a diff on a page that was only opened.
    const q = imp.quote === '"' ? '"' : "'";
    if (!imp.named) {
      lines.push(`import ${imp.name} from ${q}${specFor ? specFor(imp) : imp.path}${q};`);
      continue;
    }
    const group = model.imports.filter((i) => i.named && i.path === imp.path);
    for (const g of group) done.add(g);
    const specs = group.map((g) => {
      const base = g.imported && g.imported !== g.name ? `${g.imported} as ${g.name}` : g.name;
      return g.typeOnly ? `type ${base}` : base;
    });
    lines.push(`import { ${specs.join(', ')} } from ${q}${imp.path}${q};`);
  }
}

// The frontmatter, in the order it was written: whatever stood above the
// imports, the import block, then the rest. The blank line only appears
// between two things that are both there — on a page with no imports it used
// to open the frontmatter with an empty line.
function serializeFrontmatter(model, lines, specFor) {
  const start = lines.length;
  if (model.frontmatterLead) lines.push(model.frontmatterLead);
  serializeImports(model, lines, specFor);
  if (model.extraFrontmatter) {
    // `!== false` so a model built anywhere but the parser keeps the spacing
    // the app has always written.
    if (lines.length > start && model.extraFrontmatterSpaced !== false) lines.push('');
    lines.push(model.extraFrontmatter);
  }
}

function serializePage(model) {
  // A file that never had a frontmatter block does not acquire one. Writing
  // `---` twice at the top of a component that had none is a change to every
  // line number in it, for nothing.
  const fmLines = [];
  serializeFrontmatter(model, fmLines);
  const lines = [];
  if (fmLines.length || model.hadFrontmatter !== false) {
    lines.push('---', ...fmLines, '---');
  }

  for (const node of model.nodes) serializeNode(node, '', lines);
  // Blank lines the file ended on.
  for (let i = 0; i < (model.trailingBlank || 0); i++) lines.push('');
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
    // Same rule as a text node on its own (see the 'text' case in
    // serializeNode): the file keeps its own spelling of a character until
    // somebody edits the words, and then the characters are what there is.
    if (n.kind === 'text') out += textOut(n);
    else if (n.kind === 'expr') out += n.value;
    else if (n.children === null) {
      out += n.name === 'br' ? '<br />' : `<${n.name}${serializeAttrs(n.props)} />`;
    } else if (n.children.length === 0) {
      // Written as a pair with nothing between them. Closing it as `<span />`
      // says the same thing to a browser and a different thing to a diff.
      out += `<${n.name}${serializeAttrs(n.props)}></${n.name}>`;
    } else {
      out += `<${n.name}${serializeAttrs(n.props)}>${inlineString(n.children)}</${n.name}>`;
    }
  }
  return out;
}

// Paths for the nodes inside an inline run, written onto the tags themselves.
// A marker pair can't go there — the serializer puts each marker on its own
// line, and those newlines render as spaces, which moves the words — so until
// now nothing inside a run could be outlined or reported as rendered, and a
// link in a sentence read as a node that wasn't on the page at all. The
// collector already resolves a path from `data-avb-p` (it is how a slotted
// element is addressed), so the attribute does the whole job and adds nothing
// to the DOM. The stored `source` goes: it would put the run back verbatim,
// tags and all, without them.
function tagInlineRun(nodes, path) {
  return nodes.map((n, i) => {
    if (n.kind !== 'element') return n;
    const childPath = `${path}.${i}`;
    const tagged = {
      ...n,
      source: undefined,
      props: { ...n.props, 'data-avb-p': { type: 'string', value: childPath } },
    };
    if (Array.isArray(n.children) && n.children.length > 0) {
      tagged.children = tagInlineRun(n.children, childPath);
    }
    return tagged;
  });
}

// A node still saying exactly what the file said keeps the lines it was
// written on — the same bargain `headSource` strikes for a loop head. A text
// node with no `source` never had lines to lose, so its value is the original.
function textAsWritten(node) {
  if (!node.source) return node.value;
  return textValue(node.source) === node.value ? node.source : null;
}

// A text node on its way into the file. Untouched, the file keeps its own
// spelling of a character — `&copy;` goes back as `&copy;`, not as the © it was
// read as, which would be the editor rewriting a page it was only asked to
// open. Edited (or never read from a file at all), the characters are what
// there is, and the three that would otherwise be markup — plus the spaces a
// source file cannot show — become entities again.
function textOut(node) {
  const source = node.source;
  return source != null && textValue(source) === node.value
    ? collapseText(source)
    : encodeText(node.value);
}

// Whitespace inside an inline run is collapsed by the renderer, so the run can
// be shifted to a new indent without changing a thing about the page. Worth
// doing: an element that has been moved, or whose ancestor was re-indented,
// would otherwise hold the indentation of wherever it used to live. The last
// line of the stored inner is the whitespace before the closing tag, which is
// the indent the element was written at.
function reindentRun(source, indent) {
  const lines = source.split('\n');
  const base = lines[lines.length - 1];
  if (lines.length < 2 || !/^[ \t]*$/.test(base) || base === indent) return source;
  let shift;
  if (indent.startsWith(base)) {
    const add = indent.slice(base.length);
    shift = (line) => (line.trim() ? add + line : line);
  } else if (base.startsWith(indent)) {
    const drop = base.slice(indent.length);
    shift = (line) => (line.startsWith(drop) ? line.slice(drop.length) : line);
  } else {
    return source; // tabs against spaces — no shift that isn't a guess
  }
  return [lines[0], ...lines.slice(1, -1).map(shift), indent].join('\n');
}

const flatten = (t) => t.replace(/\s+/g, ' ').trim();
// Whitespace between two inline tags lives in text nodes the tree drops, so
// comparing runs has to ignore it entirely rather than merely collapse it.
const squash = (t) => t.replace(/\s+/g, '');

// Does an element's stored inner still describe the run hanging off it? Both
// sides collapse to the same words when nothing has been edited: a changed
// word, an added child or a rewritten inline tag all break the match, and the
// run is reflowed onto one line as before. Compared trimmed because the
// whitespace-only tail before a closing tag is in the source and not in the
// tree — which is the whole reason the source is kept.
function inlineRunUnchanged(node) {
  return (
    !!node.source &&
    node.source.includes('\n') &&
    // Compared in the file's own spelling on both sides: inlineString writes
    // `&rsquo;` back as `&rsquo;` for a node nobody has touched, and decoding
    // one side would call every hand-wrapped run with an entity in it changed
    // — reflowing the paragraph onto one line for having been looked at.
    squash(collapseText(node.source)) === squash(inlineString(node.children))
  );
}

// A block — a condition, a loop — as the file wrote it, or null once anything
// inside it has changed. It is rebuilt the way this file would write it from
// scratch and the two are compared with whitespace and this file's own
// brackets taken out, so the question is whether they say the same thing
// rather than whether they were laid out the same way. Rebuilding by running
// the serializer over a copy with the source removed means there is only one
// description of how these are written, and this cannot drift from it.
function blockAsWritten(node, indent) {
  if (!node.source) return null;
  const probe = { ...node, source: undefined, blankBefore: 0, blankAfter: 0 };
  const rebuilt = [];
  serializeNode(probe, '', rebuilt);
  const flat = (t) => t.replace(/[\s(){}]+/g, '').trim();
  if (flat(rebuilt.join('\n')) !== flat(node.source)) return null;
  const src = node.source.split('\n');
  const base = (src[src.length - 1].match(/^[ \t]*/) || [''])[0];
  return src.map((line, i) =>
    i === 0
      ? indent + line
      : line.startsWith(base)
        ? indent + line.slice(base.length)
        : line
  );
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
  // A branch's parens are JS, not JSX: an expression goes in there as itself.
  // `{heading}` would be a block, and `{ a: 1 }` an object — neither is what
  // the author wrote.
  const branchOut = (kids, at) => {
    if (kids.length === 1 && kids[0].kind === 'expr') {
      const raw = String(kids[0].value ?? '').trim().replace(/^\{/, '').replace(/\}$/, '');
      raw.split('\n').forEach((line, i) => lines.push(i === 0 ? at + line : line));
      return;
    }
    for (const child of kids) serializeNode(child, at, lines);
  };
  if (thenKids.length) {
    lines.push(indent + head + '(');
    branchOut(thenKids, indent + '  ');
    lines.push(indent + ')' + tail);
  } else {
    lines.push(indent + head + 'null' + tail);
  }
  if (chained) {
    serializeCondBody(chained, indent, lines);
  } else if (elseKids && elseKids.length) {
    branchOut(elseKids, indent + '  ');
    lines.push(indent + ')');
  }
}

function serializeNode(node, indent, lines) {
  // Chunk containers: children live in external .html files (set:html),
  // never in the page — emit the component self-closing, skip the subtree.
  if (node.kind === 'chunk-group') return; // synthetic, not in page source
  // The gap the author left in front of this node.
  for (let i = 0; i < (node.blankBefore || 0); i++) lines.push('');
  if (node.chunkFile || node.chunkAggregate) {
    lines.push(`${indent}<${node.name}${serializeAttrs(node.props)} />`);
    return;
  }
  switch (node.kind) {
    case 'text': {
      // Prose the author wrapped by hand comes back on the lines they wrapped
      // it on. Each line already carries its own indentation; only the first
      // takes the tree's, the way a multi-line expression does.
      const written = textAsWritten(node);
      if (written === null || !written.includes('\n')) {
        // The space at either end of the value is the boundary space — the one
        // a browser renders where the source had any whitespace. On a line of
        // its own the line breaks either side already ARE that whitespace, and
        // writing it as well made saving twice differ from saving once: the
        // first save moved `>Join our Discord <svg` onto separate lines with
        // the space still on the words' line, and the second save, reading its
        // own output, dropped it. The value is unchanged either way — that is
        // what makes the space the layout's to draw rather than the text's.
        lines.push(indent + textOut(node).replace(/^ +| +$/g, ''));
        return;
      }
      const body = written.replace(/^[ \t]*\r?\n/, '').replace(/\s+$/, '');
      const [first, ...more] = body.split('\n');
      lines.push(indent + first.replace(/^[ \t]+/, ''));
      for (const line of more) lines.push(line);
      return;
    }
    case 'expr': {
      // Verbatim, multi-line safe: only the first line gets the tree indent
      // (subsequent lines carry their original indentation).
      const exprLines = node.value.split('\n');
      lines.push(indent + exprLines[0]);
      for (let i = 1; i < exprLines.length; i++) lines.push(exprLines[i]);
      return;
    }
    case 'map': {
      const keptMap = blockAsWritten(node, indent);
      if (keptMap) {
        for (const line of keptMap) lines.push(line);
        return;
      }
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
      // A loop written without parens around its body keeps that shape —
      // adding them would rewrite a line the user never edited.
      if (node.bare) {
        lines.push(indent + '  ' + node.head.replace(/\($/, '').trimEnd());
        for (const child of node.children || []) {
          serializeNode(child, indent + '    ', lines);
        }
        lines.push(indent + '  )');
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
    case 'cond': {
      const kept = blockAsWritten(node, indent);
      if (kept) {
        for (const line of kept) lines.push(line);
        return;
      }
      lines.push(indent + '{');
      serializeCondBody(node, indent + '  ', lines);
      lines.push(indent + '}');
      return;
    }
    case 'branch':
      // Written by the condition above; standing on its own it is just its
      // contents.
      for (const child of node.children || []) serializeNode(child, indent, lines);
      return;
    case 'comment':
      lines.push(
        node.jsx ? `${indent}{/*${node.value}*/}` : `${indent}<!--${node.value}-->`
      );
      return;
    case 'raw-line':
      lines.push(indent + node.value);
      return;
    case 'raw': {
      const open = `${indent}<${node.name}${serializeAttrs(node.props)}>`;
      // Keep raw inner verbatim. Only the line break that ends the last line
      // goes, since the closing tag supplies its own — trimming all trailing
      // whitespace also took away a blank line the author left in the CSS.
      const inner = node.inner.replace(/^\r?\n/, '').replace(/\r?\n[ \t]*$/, '');
      // A block with nothing in it is one tag: `<script src="…"></script>`.
      // Putting the close on its own line made the block a line taller on
      // every save — the next parse reads that line as content, keeps it, and
      // adds another — so a Webflow export's three library <script>s grew by
      // three lines each time the page was opened and saved.
      if (!inner.trim()) {
        lines.push(`${open}</${node.name}>`);
        return;
      }
      lines.push(open);
      for (const line of inner.split('\n')) lines.push(line);
      lines.push(`${indent}</${node.name}>`);
      return;
    }
    default: {
      const kept = attrsAsWritten(node);
      const attrs = kept === null ? serializeAttrs(node.props) : kept;
      // The closing tag as written, when it was written across lines. Only
      // trusted while it still names this element: renaming the tag rebuilds
      // it the ordinary way.
      const closeTag =
        node.closeSource && node.closeSource.startsWith(`</${node.name}`)
          ? node.closeSource
          : `</${node.name}>`;
      const openTag = (close) => {
        // Preserved attributes carry their own trailing whitespace — the line
        // break before the closing bracket — so the usual leading space would
        // be one too many.
        const tail = kept !== null && /\s$/.test(attrs) ? close.replace(/^ /, '') : close;
        const text = `${indent}<${node.name}${attrs}${tail}`;
        for (const line of text.split('\n')) lines.push(line);
      };
      if (node.children === null) {
        openTag(node.tightClose ? '/>' : ' />');
        return;
      }
      // Inline runs stay on one line: <p>We're <strong>Acme</strong>.</p>
      if (node.children.length > 0 && isInlineRun(node.children)) {
        // Unless the file already wrote the run across several lines and
        // nothing has touched it since. Re-flowing a hand-wrapped paragraph
        // onto one long line is a diff on a page that was only opened, and
        // the stored inner puts the tag back whole — its line breaks, its
        // indentation, and the break before the closing tag.
        if (inlineRunUnchanged(node)) {
          openTag(`>${reindentRun(node.source, indent)}${closeTag}`);
          return;
        }
        openTag(`>${inlineString(node.children).trim()}${closeTag}`);
        return;
      }
      if (node.children.length === 0) {
        openTag(`>${node.source ? reindentRun(node.source, indent) : ''}${closeTag}`);
        return;
      }
      openTag('>');
      for (const child of node.children) serializeNode(child, indent + '  ', lines);
      for (let i = 0; i < (node.blankAfter || 0); i++) lines.push('');
      for (const line of `${indent}${closeTag}`.split('\n')) lines.push(line);
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
  // Through the same writer as a real save: `frontmatterLead` is ordinary
  // frontmatter that happens to sit above the imports, and a preview that
  // dropped it would be missing whatever it declares.
  serializeFrontmatter(model, lines, (imp) => {
    const mark = /\.html\?raw$/i.test(imp.path) ? marks.get(imp.name) : null;
    return mark ? `${imp.path}&avb=${mark.path}${mark.group ? '&avbg=1' : ''}` : imp.path;
  });
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

// `inSlot` says this node is a direct child of a component, i.e. slot content —
// which decides how the marker has to be written, since Astro's compiler drops
// a plain html comment there.
//
// Every element and component also carries its path as an attribute, which is
// the marker that survives what happens to the page after Astro is done with
// it. A component doesn't have to render `<slot />` and leave it at that: it
// can render the slot to a string and put the string back with `set:html`,
// which is how it asks "did my slot render anything?" — and the usual way to
// answer is to drop html comments before looking, since a comment is content
// that isn't:
//
//   const content = await slots.render('default');
//   return content.replace(/<!--[\s\S]*?-->/g, '').trim();  // ← markers gone
//
// Nothing on the page then answers to those paths. The navigator reported
// every row inside such a component as rendering nothing, on a page where they
// were plainly on screen, and nothing in there could be clicked or outlined.
//
// It can't be narrowed to slot content, either: what is being scrubbed is
// everything the slot rendered, which includes the output of every component
// inside it. <Tabs> written at the top of its own file, its markers a page
// away from any slot, still lost every one of them for being placed inside a
// <Section>. So the path rides on the markup everywhere — as the same
// `data-avb-p` the collector writes at runtime, and invisible to :nth-child,
// :first-child, + and ~ in a way a marker node could never be.
//
// On a component the attribute is a prop, and only reaches the DOM if that
// component spreads its rest props — most do, and where one doesn't this is
// no worse than the comment that was being dropped. The markers stay either
// way: they are what works when nothing interferes, they say where a node
// ENDS, and they carry the nodes an attribute can't (text, a loop, a branch).
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
  // Serialized with the path attribute already on it (see above). <Fragment>
  // and <slot> are left out: neither puts an element on the page, so there is
  // nothing for the attribute to ride on.
  const carryPath =
    (node.kind === 'element' || node.kind === 'component') &&
    node.name !== 'Fragment' &&
    node.name !== 'slot';
  // Where the node forwards its rest props, the caller's path for this
  // instance arrives inside the spread, and both want the same attribute. So
  // the one written here names BOTH — its own path and whatever came in on
  // Astro.props — and then has to be the one that survives.
  //
  // Which side of the spread that is depends on what the spread is. An
  // element's attributes are text: two `data-avb-p=` land in the tag and an
  // html parser keeps the FIRST, so this one goes before the spread. A
  // component's are an object: the later key overwrites, so this one goes
  // after it. Getting that backwards is silent — the tag is there, holding
  // the wrong file's path. With <Tabs> open, its root div kept the page's
  // path and a click on it resolved to nothing, which is how the canvas says
  // "you're done in here": the component closed itself the moment you clicked
  // inside it.
  const forwards = Object.keys(node.props || {}).some((k) => k.startsWith('...'));
  const pathProp = forwards
    ? { type: 'expr', value: `[${JSON.stringify(path)}, Astro.props["data-avb-p"]].filter(Boolean).join(" ")` }
    : { type: 'string', value: path };
  const markedProps = !carryPath
    ? node.props
    : forwards && node.kind === 'element'
      ? { 'data-avb-p': pathProp, ...node.props }
      : { ...node.props, 'data-avb-p': pathProp };
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
    //
    // The body goes inside a <Fragment>, for the same reason the branches of
    // a `cond` do: what an iteration returns is a marker, the child, and
    // another marker, and `(a b c)` is a list where one expression is wanted.
    // Astro's own compiler accepts it — it reads the children as one template
    // — but Astro 7's Rust compiler (@astrojs/compiler-rs) does not, and the
    // page fails to build with a bare "Unexpected token".
    //
    // Inside that Fragment the children are slot content, where a plain html
    // comment is dropped by both compilers, so the markers have to go in as
    // `set:html` — hence inSlot. Missing that is silent: the page builds and
    // the loop renders, but nothing inside it can be outlined.
    lines.push(indent + '{');
    const loopBody = (bodyIndent) => {
      lines.push(bodyIndent + '<Fragment>');
      (node.children || []).forEach((child, i) =>
        serializeNodeMarked(child, bodyIndent + '  ', lines, `${path}.${i}`, true)
      );
      lines.push(bodyIndent + '</Fragment>');
    };
    if (node.body && node.body.length) {
      lines.push(indent + '  ' + blockHead(node.head));
      for (const line of node.body) lines.push(indent + '    ' + line);
      lines.push(indent + '    return (');
      loopBody(indent + '      ');
      lines.push(indent + '    );');
      lines.push(indent + '  })');
      lines.push(indent + '}');
      return;
    }
    lines.push(indent + '  ' + node.head);
    loopBody(indent + '    ');
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
      // Slot content of that Fragment, so the markers must be the `set:html`
      // form — a plain comment directly inside a component is dropped, which
      // left everything in a branch unoutlinable.
      if (branch) serializeNodeMarked(branch, inner + '  ', lines, `${path}.${i}`, true);
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
    const base = carryPath ? { ...node, props: markedProps } : node;
    const inlineKids =
      (node.kind === 'component' || node.kind === 'element') &&
      !node.chunkFile &&
      !node.chunkAggregate &&
      Array.isArray(node.children) &&
      node.children.length > 0 &&
      isInlineRun(node.children);
    serializeNode(
      inlineKids
        ? { ...base, source: undefined, children: tagInlineRun(node.children, path) }
        : base,
      indent,
      lines
    );
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

// `prelude` carries type declarations this file imports from elsewhere. A
// component is free to write `type Props = SeoProps` with SeoProps in
// types.ts, and without the declaration text there is nothing to read — the
// panel would show a component with no props at all. The caller (which has
// What a doc comment promises about a prop's fallback. Returns a value when it
// names exactly one, a hint when it names several, and nothing when it is
// prose. Used twice: once for the field itself, and once per union branch,
// where a prop written in several branches has a different answer in each.
function statedDefault(doc) {
  if (!doc) return {};
  const stated =
    doc.match(/defaults?\s*(?:to|:)\s*\`([^\`]+)\`/i) ||
    doc.match(/defaults?\s*(?:to|:)\s*([^\`.,;]+)/i);
  if (!stated) return {};

  // "Defaults to `webp`, or `svg` for SVG sources" is TWO answers, and which
  // one applies depends on a prop only the component can weigh. Asserting the
  // first would have the panel show `webp` while the build emits `svg`.
  //
  // Naming a second value is the tell, whatever word joins them. Asking for
  // "for", "when", "if" or "on" as well let "Defaults to `Play`, or `Pause`
  // while pressed" through as a plain default of Play, and the panel offered
  // Play on a close button. A list of joining words is always one word short;
  // two backticked values in one clause cannot be anything but two answers.
  // Prose still needs those words, having no second value to count.
  const clause =
    (doc.match(/defaults?\s*(?:to|:)\s*((?:`[^`]*`|[^.])+)/i) || [])[1] || '';
  const named = clause.match(/`[^`]+`/g) || [];
  const conditional =
    named.length > 1 ||
    (/\bor\b/i.test(clause) &&
      /\b(?:for|when|if|on|while|unless|with|without|depending)\b/i.test(clause));
  if (conditional) {
    const hint = clause
      .replace(/`/g, '')
      .replace(/\s+/g, ' ')
      .replace(/\s*passthrough\s*/i, ' ')
      .trim();

    // A clause that names the prop it turns on can be answered rather than
    // only reported: "Defaults to `Next`, or `Previous` when direction is
    // `back`" is a rule the panel can weigh, because direction is a prop it
    // already has. The bare form — "or `Pause` when pressed" — reads a
    // boolean prop being true.
    const rule =
      clause.match(
        /^\s*`([^`]+)`.*?\bor\b\s*`([^`]+)`\s*(?:when|while|if)\s+([A-Za-z_$][\w$]*)\s+(?:is|=|===)\s*`?([^`\s.,]+)`?/i
      ) ||
      clause.match(
        /^\s*`([^`]+)`.*?\bor\b\s*`([^`]+)`\s*(?:when|while|if)\s+([A-Za-z_$][\w$]*)\s*$/i
      );
    if (rule) {
      return {
        hint,
        when: {
          prop: rule[3],
          is: rule[4] === undefined ? 'true' : String(rule[4]),
          then: rule[2],
          otherwise: rule[1],
        },
      };
    }
    return hint ? { hint } : {};
  }

  const text = stated[1].trim().replace(/^["']|["']$/g, '');
  if (text && text.length <= 24 && !/\s(the|a|an|whatever|sensible)\s/i.test(` ${text} `)) {
    return { value: /^-?\d+(\.\d+)?$/.test(text) ? Number(text) : text };
  }
  return {};
}

// file access; this doesn't) resolves and reads them.
function parsePropSchema(source, prelude = '') {
  const fm = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const frontmatter = (prelude ? prelude + '\n' : '') + (fm ? fm[1] : '');
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

  // An alias standing in for a union of literals, expanded to those literals.
  const expandAlias = (part, seen = new Set()) => {
    const body = aliases.get(part);
    if (!body || seen.has(part) || /[{}]/.test(body)) return [part];
    seen.add(part);
    return splitTypeTop(body, '|').flatMap((p) => expandAlias(p.trim(), seen));
  };

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
    // Line by line first — that reads members written one per line, including
    // several separated by commas rather than semicolons.
    for (const line of explodeMembers(block).split('\n')) {
      const m = line.trim().match(/^(?:readonly\s+)?([\w$]+)\??\s*:\s*([^;\n]+?)[;,]?\s*$/);
      if (m) out.set(m[1], m[2].trim());
    }
    // …then whole members, for a type that spans lines:
    //   variant?:
    //     | "stack"
    //     | "card";
    // No single line of that is a member, so the scan above sees nothing and
    // the prop vanishes from its branch — which is how a six-option variant
    // came out as a text field instead of a dropdown.
    for (const raw of splitTypeTop(block, ';')) {
      const flat = raw
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/\/\/[^\n]*/g, ' ')
        .replace(/[{}]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (!flat.includes('\n') && out.size && !/\|/.test(flat)) continue;
      const m = flat.match(/^(?:readonly\s+)?([\w$]+)\??\s*:\s*(.+?),?$/);
      if (m && !out.has(m[1])) out.set(m[1], m[2].trim());
    }
    return out;
  };
  const unions = [];
  const memberDocs = (block) => {
    const out = new Map();
    let doc = [];
    let inBlock = false;
    for (const raw of explodeMembers(block).split('\n')) {
      const line = raw.trim();
      if (inBlock) {
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
      if (!line) {
        doc = [];
        continue;
      }
      const m = line.match(/^(?:readonly\s+)?([\w$]+)\??\s*:\s*([^;\n]+?)[;,]?\s*$/);
      if (m) {
        const text = doc.join(' ').replace(/\s+/g, ' ').trim();
        if (text) out.set(m[1], text);
        doc = [];
      }
    }
    return out;
  };

  for (const branchBlocks of unionTables) {
    const maps = branchBlocks.map(memberEntries);
    const docMaps = branchBlocks.map(memberDocs);
    const names = new Set(maps.flatMap((m) => [...m.keys()]));
    const branches = maps.map((m, at) => {
      const forbids = [];
      const pins = {};
      // What this branch's own doc comments say a prop falls back to. A label
      // that reads Play in the play branch and Close in the close one has no
      // single answer for the field, but it has one per branch — and the
      // branch is decided by props the panel already knows.
      const defaults = {};
      const rules = {};
      const docs = {};
      for (const [name, doc] of docMaps[at]) {
        docs[name] = doc;
        const said = statedDefault(doc);
        if (said.value !== undefined) defaults[name] = said.value;
        if (said.when) rules[name] = said.when;
      }
      for (const name of names) {
        const t = m.get(name);
        if (!t) continue;
        // A branch PINS a prop when it fixes it to a known set of values —
        // one (`variant: "autofit"`) or several (`variant: "autofit" |
        // "autofill"`), which is still a discriminant, just a wider one.
        // Anything with a non-literal member (string, number, an alias like
        // GridColumns) fixes nothing and pins nothing. Split first: a naive
        // literal test on the whole type reads `"a" | "b"` as one string,
        // because it does start and end with a quote.
        if (t === 'never') {
          forbids.push(name);
          continue;
        }
        const parts = splitTypeTop(t, '|')
          .flatMap((x) => expandAlias(x.trim()))
          .map((x) => x.trim())
          .filter((x) => x && x !== 'undefined' && x !== 'null');
        const isLiteral = (x) =>
          /^(['"`]).*\1$/.test(x) || /^(true|false|-?\d+(\.\d+)?)$/.test(x);
        if (parts.length && parts.every(isLiteral)) {
          pins[name] = parts.map((x) => (/^['"`]/.test(x) ? x.slice(1, -1) : x));
        }
      }
      return { forbids, pins, defaults, rules, docs };
    });
    // A union that forbids nothing and pins nothing tells the panel nothing.
    if (
      branches.some(
        (b) =>
          b.forbids.length ||
          Object.keys(b.pins).length ||
          Object.keys(b.defaults).length ||
          Object.keys(b.rules).length
      )
    ) {
      unions.push({ names: [...names], branches });
    }
  }

  // A prop written in several branches has a doc in each, and they differ
  // exactly where the branches do — the play control's label falls back to
  // Play, the close one's to Close. The schema keeps the first it meets, so
  // the tip beside a close button's label read "Defaults to Play".
  //
  // What every branch says is what is true of the prop itself, so the tip
  // shows their common opening and stops at the last sentence they share.
  // Where they part is the fallback, which the field already answers with a
  // placeholder for the branch in force.
  const sharedDoc = new Map();
  {
    const perName = new Map();
    for (const u of unions) {
      for (const b of u.branches) {
        for (const [name, doc] of Object.entries(b.docs || {})) {
          if (!perName.has(name)) perName.set(name, new Set());
          perName.get(name).add(doc);
        }
      }
    }
    for (const [name, docs] of perName) {
      if (docs.size < 2) continue;
      const all = [...docs];
      let i = 0;
      while (i < all[0].length && all.every((d) => d[i] === all[0][i])) i++;
      const cut = all[0].slice(0, i).lastIndexOf('.');
      const common = cut === -1 ? '' : all[0].slice(0, cut + 1).trim();
      if (common) sharedDoc.set(name, common);
    }
  }

  // Raw type strings per prop, gathered across every block, so a prop split
  // over a discriminated union comes back as the union of what it can be —
  // `"responsive"` here and `"fixed"` there is one three-option enum, not
  // three separate one-option ones.
  const rawTypes = new Map();
  const noted = new Map();

  // An alias standing in for a union of literals, expanded to those literals.
  // Only for alias bodies that are plain unions — one holding an object shape
  // describes members, not values, and exploding it would be nonsense.

  for (const block of blocks) {
    // Walked line by line rather than matched in one pass, so the comment
    // above a prop can be carried onto it — that's the prop's documentation,
    // and the panel shows it as the field's help text.
    const entryRe = /^\s*(?:readonly\s+)?([\w$]+)(\?)?\s*:\s*([^;\n]+?)[;,]?\s*$/;
    let doc = [];
    let inBlock = false;
    const lines = explodeMembers(block).split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
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
      let m = line.match(entryRe);
      // A member whose type is written across lines —
      //   variant?:
      //     | "stack"
      //     | "card"
      // — has no single line that reads as a declaration, so the scan above
      // sees nothing and the prop disappears from the schema entirely. When a
      // line opens one, take the rest of the member with it. (explodeMembers
      // already ended the member at its `;`, so what follows belongs to it.)
      if (!m && /^(?:readonly\s+)?[\w$]+\??\s*:\s*$/.test(line)) {
        const rest = [];
        while (i + 1 < lines.length) {
          const next = lines[i + 1].trim();
          if (!next || next.startsWith('/*') || next.startsWith('//')) break;
          if (entryRe.test(next) || /^(?:readonly\s+)?[\w$]+\??\s*:\s*$/.test(next)) break;
          rest.push(next);
          i += 1;
        }
        if (rest.length) {
          m = (line + ' ' + rest.join(' ')).replace(/\s+/g, ' ').match(
            /^(?:readonly\s+)?([\w$]+)(\?)?\s*:\s*(.+?)[;,]?\s*$/
          );
        }
      }
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
          // `variant?: PlainVariant | ReversibleVariant` names two aliases
          // rather than being one, so the substitution above doesn't reach it
          // — and an unexpanded name among the literals is a non-literal, so
          // the whole thing stops reading as a fixed set of options.
          for (const piece of expandAlias(part)) {
            if (piece !== 'never' && !rec.parts.includes(piece)) rec.parts.push(piece);
          }
        }
        if (m[2]) rec.optional = true;
      }
      const text = doc.join(' ').replace(/\s+/g, ' ').trim();
      if (text && !noted.has(name)) noted.set(name, text);
      doc = [];
    }
  }

  for (const [name, rec] of rawTypes) {
    const { type, options, numeric } = normalizeType(rec.parts.join(' | '));
    schema.set(name, {
      name,
      type,
      options,
      numeric,
      optional: rec.optional,
      default: undefined,
      doc: sharedDoc.get(name) ?? noted.get(name),
      // Range and step, for the fields that can be typed into freely. A list
      // of literals already can't take a wrong value.
      ...(type === 'number' ? numberRules(noted.get(name)) : {}),
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

  // A prop written in several branches can promise a different fallback in
  // each. There is no single answer for the field, and reading the first
  // branch's doc would have it claim Play on a close button — the same lie
  // the conditional clause above refuses to tell. The branch tables carry
  // the per-branch answers; the field claims none.
  const splitFallback = new Set();
  for (const u of unions) {
    for (const name of u.names) {
      const seen = new Set();
      for (const b of u.branches) {
        if (b.defaults?.[name] !== undefined) seen.add(b.defaults[name]);
        if (b.rules?.[name]) seen.add(`rule:${name}`);
      }
      if (seen.size > 1) splitFallback.add(name);
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
    if (splitFallback.has(field.name)) continue;

    const said = statedDefault(field.doc);
    if (said.value !== undefined) {
      field.default = said.value;
      continue;
    }
    if (said.hint) {
      field.hint = said.hint;
      continue;
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

// The slot a use of `Astro.slots` is about, and the const it was read into.
//
// A component does not have to render `<slot />` to take slot content. It can
// read the slot itself — which is the only way to ask whether the slot
// rendered anything, and so the usual shape for a component that draws nothing
// when it is empty:
//
//   const content = await Astro.slots.render('default');
//   const column2 = await slotContent(Astro.slots, 'column2');
//
// Read from the call around it: `.render(x)` / `.has(x)` name their slot
// outright, and where `Astro.slots` is handed to a helper the string beside it
// is the name. No string means the default slot — which is also the answer for
// `render(someVariable)`, where nothing in the file says which slot it is.
//
// Scans forward from the reference to the end of the call it sits in, so a
// second call further down the file can't lend it a name.
function slotApiUses(source) {
  const text = withoutComments(source);
  const uses = [];
  const re = /Astro\s*\.\s*slots\b(\s*\.\s*(?:render|has)\s*\()?/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    // Either we just consumed the opening paren of `.render(` / `.has(`, or
    // the reference is an argument in a call whose paren is behind us. Both
    // are one level in, and both end at the ')' that closes it.
    let depth = 1;
    let name = null;
    for (let i = m.index + m[0].length; i < text.length; i++) {
      const c = text[i];
      if (c === '"' || c === "'" || c === '`') {
        const close = text.indexOf(c, i + 1);
        const quoted = text.slice(i + 1, close === -1 ? text.length : close);
        if (name === null && /^[\w-]*$/.test(quoted)) name = quoted;
        if (close === -1) break;
        i = close;
        continue;
      }
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') {
        depth--;
        if (depth === 0) break;
      } else if (depth === 1 && c === ';') break;
    }
    // `const content = await slotContent(...)` — the name that now holds it,
    // which is what the template puts back with `set:html`.
    const decl = text
      .slice(0, m.index)
      .match(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?[^;\n]*$/);
    uses.push({ slot: name || 'default', varName: decl ? decl[1] : null });
  }
  return uses;
}

// The source with what it says ABOUT itself blanked out, character for
// character so every index still points where it did. A frontmatter comment
// explaining how the component consumes its slots reads exactly like code
// that consumes them — three files in two projects grew a slot called "0"
// from a sentence about `Astro.slots.render()`.
//
// Only frontmatter takes `//` and `/* */`: in the template body a `//` is far
// more likely to be the middle of a URL than the start of a comment. Html
// comments are blanked wherever they are.
function withoutComments(source) {
  const fm = source.match(/^---\r?\n(?:[\s\S]*?\r?\n)?---\r?\n?/);
  const chars = [...source];
  const blank = (from, to) => {
    for (let i = from; i < to && i < chars.length; i++) {
      if (chars[i] !== '\n') chars[i] = ' ';
    }
  };
  const end = fm ? fm[0].length : 0;
  for (let i = 0; i < end; i++) {
    const skipped = skipStringOrComment(source, i);
    if (skipped === i) continue;
    if (source[i] === '/') blank(i, skipped);
    i = skipped - 1;
  }
  for (const m of source.matchAll(/<!--[\s\S]*?-->/g)) blank(m.index, m.index + m[0].length);
  return chars.join('');
}

// Slot names a component's template exposes: 'default' for <slot>/<slot />,
// plus any <slot name="x">, plus any slot the frontmatter reads through
// `Astro.slots` (see slotApiUses). Default first, then named in appearance
// order.
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
  for (const use of slotApiUses(source)) found.add(use.slot);
  const named = [...found].filter((s) => s !== 'default');
  return found.has('default') ? ['default', ...named] : named;
}

// Tags that hold a line of text rather than a place to put blocks. What
// wraps a component's default <slot /> says what the component is for: a
// <slot> inside a <p> or a heading wants words, one inside a <div> wants
// other components.
const TEXT_TAGS = new Set([
  'a', 'b', 'blockquote', 'button', 'caption', 'cite', 'code', 'dd', 'dt', 'em',
  'figcaption', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'i', 'label', 'legend',
  'li', 'option', 'p', 'q', 'small', 'span', 'strong', 'summary', 'td', 'th',
  'title',
]);

// A tag name written as `<Tag>` is a variable — resolve it back to the literal
// it holds. `const Tag = tag;` with `tag = "h2"` in the props destructure is
// the common shape; `const Tag = isLink ? "a" : "button"` names its options
// outright. Returns every tag it could be, or [] when that can't be told.
function dynamicTagLiterals(frontmatter, name) {
  const decl = frontmatter.match(
    new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*=\\s*([^;\\n]+)`)
  );
  if (!decl) return [];
  const literals = [...decl[1].matchAll(/["'`]([A-Za-z][\w-]*)["'`]/g)].map((m) => m[1]);
  if (literals.length) return literals;
  const ident = decl[1].trim().match(/^([A-Za-z_$][\w$]*)$/);
  if (!ident) return [];
  // `const Tag = tag` — the default sits in the destructure or its own const.
  const viaDefault = frontmatter.match(
    new RegExp(`\\b${ident[1]}\\s*=\\s*["'\`]([A-Za-z][\\w-]*)["'\`]`)
  );
  return viaDefault ? [viaDefault[1]] : [];
}

// The HTML tag a component renders as, so nesting rules can reach through it:
// a <Paragraph> is a <p>, and a <p> can't go inside an <h1> however the
// component is named. Returns { tag } when it's fixed, { prop, fallback,
// options } when a prop decides it (`<Tag>` from `const Tag = tag`, with
// `tag = "h2"` in the destructure), or null when it can't be told.
function rootTag(source) {
  const fm = source.match(/^---\r?\n(?:[\s\S]*?\r?\n)?---\r?\n?/);
  const frontmatter = fm ? fm[0] : '';
  const body = fm ? source.slice(fm[0].length) : source;
  // The first element of the template that isn't a wrapper Astro strips.
  const re = /<(\/?)([A-Za-z][\w.-]*)\b((?:[^>"'{]|"[^"]*"|'[^']*'|\{[^}]*\})*?)(\/?)>/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const [, closing, name] = m;
    if (closing) continue;
    const lower = name.toLowerCase();
    if (lower === 'fragment' || lower === 'slot' || lower === 'style' || lower === 'script') continue;
    if (!/^[A-Z]/.test(name)) return { tag: lower };
    // A capitalised name is either another component — whose own tag this
    // file can't know — or a variable holding one.
    const decl = frontmatter.match(
      new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*=\\s*([^;\\n]+)`)
    );
    if (!decl) return null;
    const expr = decl[1].trim();
    // `const Tag = tag` — the prop decides, so report it along with the
    // default, and an instance that sets the prop overrides the default.
    const ident = expr.match(/^([A-Za-z_$][\w$]*)$/);
    if (ident) {
      const prop = ident[1];
      const dflt = frontmatter.match(
        new RegExp(`\\b${prop}\\s*=\\s*["'\`]([A-Za-z][\\w-]*)["'\`]`)
      );
      return dflt ? { prop, tag: dflt[1].toLowerCase() } : { prop };
    }
    // `const Tag = isLink ? "a" : "button"` — it's one of these, and which
    // one depends on values only the page knows.
    const lits = [...expr.matchAll(/["'`]([A-Za-z][\w-]*)["'`]/g)].map((x) => x[1].toLowerCase());
    if (lits.length === 1) return { tag: lits[0] };
    if (lits.length > 1) return { options: lits };
    return null;
  }
  return null;
}

// Whether a component's default <slot /> sits somewhere text belongs, so a
// freshly inserted one can arrive with a word in it instead of empty. False
// for a slot that isn't wrapped at all, or wrapped in something structural.
//
// A component that read its slot itself puts it back with `set:html`, and that
// is the same placeholder under another name — `<Fragment set:html={content}/>`
// inside a <Tag> is where the default slot renders. Which const holds it comes
// from slotApiUses.
function defaultSlotInline(source) {
  const fm = source.match(/^---\r?\n(?:[\s\S]*?\r?\n)?---\r?\n?/);
  const frontmatter = fm ? fm[0] : '';
  const body = fm ? source.slice(fm[0].length) : source;
  const heldBy = new Set(
    slotApiUses(source)
      .filter((u) => u.slot === 'default' && u.varName)
      .map((u) => u.varName)
  );
  const stack = [];
  const re = /<(\/?)([A-Za-z][\w.-]*)\b((?:[^>"'{]|"[^"]*"|'[^']*'|\{[^}]*\})*?)(\/?)>/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const [, closing, tag, attrs, selfClosing] = m;
    const html = !closing && attrs.match(/\bset:html\s*=\s*\{\s*([A-Za-z_$][\w$]*)\s*\}/);
    const isSlot = tag.toLowerCase() === 'slot' && !closing && !/\bname\s*=/.test(attrs);
    // A <Fragment> renders nothing of its own, so what wraps the content is
    // the tag above it. Anything else IS the wrapper.
    const placeholder = isSlot || (html && heldBy.has(html[1]));
    if (placeholder) {
      const parent = isSlot || tag === 'Fragment' ? stack[stack.length - 1] : tag;
      if (!parent) return false;
      if (TEXT_TAGS.has(parent.toLowerCase())) return true;
      if (!/^[A-Z]/.test(parent)) return false;
      const options = dynamicTagLiterals(frontmatter, parent);
      return options.length > 0 && options.every((t) => TEXT_TAGS.has(t.toLowerCase()));
    }
    if (closing) {
      const at = stack.lastIndexOf(tag);
      if (at !== -1) stack.length = at;
    } else if (!selfClosing && !VOID_ELEMENTS.has(tag.toLowerCase())) {
      stack.push(tag);
    }
  }
  return false;
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

// What a number prop will actually accept. TypeScript can't say "greater than
// zero", so components say it in the doc comment — either as a tag, which is
// exact, or in the sentence a human reads, which is a guess and can be
// overridden by a tag. Returns {} when the doc says nothing about a range.
const NUMBER_RE = String.raw`-?\d+(?:\.\d+)?`;
function numberRules(doc) {
  if (!doc) return {};
  const rules = {};
  const tag = (name) => {
    const m = doc.match(new RegExp(`@${name}\\s+(${NUMBER_RE})`, 'i'));
    return m ? parseFloat(m[1]) : undefined;
  };
  const min = tag('min');
  const max = tag('max');
  const step = tag('step');
  if (min !== undefined) rules.min = min;
  if (max !== undefined) rules.max = max;
  if (step !== undefined) rules.step = step;
  if (/@(?:int|integer)\b/i.test(doc) && rules.step === undefined) rules.step = 1;

  // Prose, for the props that were written before any of that existed. Only
  // phrases that state a bound outright — "Defaults to 12" is not one, and
  // neither is "Columns from 30rem up". Each match is struck out as it is
  // read, so "no more than 8" can't be picked up a second time by the bare
  // "more than" pattern underneath it and turned into a minimum.
  let prose = doc.replace(/@\w+\s+-?[\d.]+/g, ' ');
  const take = (re, apply) => {
    const m = prose.match(re);
    if (!m) return;
    apply(...m.slice(1).map(parseFloat));
    prose = prose.replace(m[0], ' ');
  };
  take(new RegExp(`between\\s+(${NUMBER_RE})\\s+and\\s+(${NUMBER_RE})`, 'i'), (a, b) => {
    if (rules.min === undefined) rules.min = a;
    if (rules.max === undefined) rules.max = b;
  });
  // Inclusive bounds first: they contain the words the exclusive ones use.
  take(
    new RegExp(`(?:no more than|not more than|at most|maximum(?: of)?|up to)\\s+(${NUMBER_RE})`, 'i'),
    (n) => { if (rules.max === undefined) rules.max = n; }
  );
  take(
    new RegExp(`(?:no less than|not less than|at least|minimum(?: of)?)\\s+(${NUMBER_RE})`, 'i'),
    (n) => { if (rules.min === undefined) rules.min = n; }
  );
  take(new RegExp(`(?:greater than|more than|above)\\s+(${NUMBER_RE})`, 'i'), (n) => {
    if (rules.min !== undefined) return;
    rules.min = n;
    rules.minExclusive = true;
  });
  take(new RegExp(`(?:less than|below|under)\\s+(${NUMBER_RE})`, 'i'), (n) => {
    if (rules.max !== undefined) return;
    rules.max = n;
    rules.maxExclusive = true;
  });
  if (rules.step === undefined && /\b(whole numbers?|integers?|no decimals?)\b/i.test(prose)) {
    rules.step = 1;
  }
  return rules;
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
    // The same thing written with numbers — `1 | 2 | … | 12` for a column
    // count. A free number field would take -1, 0 and 1.5, none of which the
    // type allows, so this is a list too. `numeric` tells the panel to write
    // `cols={3}` rather than `cols="3"`; the component is typed for a number.
    const nums = parts.filter((p) => /^-?\d+(?:\.\d+)?$/.test(p));
    const notNums = parts.filter((p) => !/^-?\d+(?:\.\d+)?$/.test(p));
    if (nums.length >= 2 && notNums.every((p) => p === 'undefined' || p === 'null')) {
      return { type: 'enum', numeric: true, options: nums };
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

function resolveChunks(model, pagePath, opts = {}) {
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
      // Chunk offsets are into the chunk file, not the page — locateSelection
      // switches files at the boundary node.
      const { nodes, clean } = parseTemplate(
        fs.readFileSync(filePath, 'utf8'),
        opts.locs ? 0 : null
      );
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
// page serializer emits, numbered from the Fragment's (or group's) key so
// chunk nodes address identically to the app's tree. `prefix` is a full
// "<file>#<path>" key — the file half rides along untouched. A group also gets
// a marker pair of its own — nothing in the page wraps it. Returns null when
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

// ---------------------------------------------------------------------------
// Selection → source location
// ---------------------------------------------------------------------------

// 1-based line number of a source offset.
function lineOf(source, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === '\n') line++;
  }
  return line;
}

// Where a canvas selection sits in source. `indexPath` is the "0.2.1" half of
// a "<file>#<path>" node key — '' for the file itself, 'frontmatter' for the
// frontmatter block. Reads the file from disk and parses it fresh, so the
// answer describes what an agent opening that file would actually see.
//
// The file returned isn't always the one asked for: chunk children are written
// in the imported .html, not in the page that pulls it in. A node with no
// range of its own (an unrepresentable file, a synthetic chunk group, a path
// that no longer resolves) comes back as a bare file.
function locateSelection(absPath, indexPath) {
  let source;
  try {
    source = fs.readFileSync(absPath, 'utf8');
  } catch {
    return null;
  }
  const bare = { file: absPath };
  if (!indexPath) return bare;

  const parsed = parsePage(source, { locs: true });
  if (!parsed.editable) return bare;
  if (indexPath === 'frontmatter') {
    return parsed.model.bodyStart
      ? { file: absPath, startLine: 1, endLine: lineOf(source, parsed.model.bodyStart - 1) }
      : bare;
  }
  resolveChunks(parsed.model, absPath, { locs: true });

  let file = absPath;
  let list = parsed.model.nodes;
  let node = null;
  for (const part of indexPath.split('.')) {
    // Stepping past a chunk boundary: everything below it is written in the
    // chunk file, while the boundary node itself belongs to the page.
    if (node?.chunkFile) file = node.chunkFile;
    node = Array.isArray(list) ? list[Number(part)] : null;
    if (!node) return { file };
    list = node.children;
  }
  if (typeof node.start !== 'number') return { file };

  let text = source;
  if (file !== absPath) {
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return { file };
    }
  }
  // Text nodes run from the end of the previous tag, so their range starts and
  // ends in whitespace on lines that hold nothing else. Tighten it to the
  // lines the content is actually on.
  let start = node.start;
  let end = Math.min(node.end, text.length);
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;
  return { file, startLine: lineOf(text, start), endLine: lineOf(text, end - 1) };
}

module.exports = {
  parsePage,
  locateSelection,
  serializePage,
  serializePageMarked,
  parseTemplate,
  serializeNodes,
  resolveChunks,
  markChunkHtml,
  parsePropSchema,
  parseExtendsTag,
  parseSlots,
  defaultSlotInline,
  rootTag,
  numberRules,
  parseAttrs,
  serializeAttrs,
};
