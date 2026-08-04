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

// Values: {type:'string', value} | {type:'expr', value} | {type:'bare'}
// Expression values may contain one level of nested braces (attrs={{ a: 1 }}).
function parseAttrs(attrString) {
  const props = {};
  const re = /([\w@:.-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|\{((?:[^{}]|\{[^{}]*\})*)\}))?/g;
  let m;
  while ((m = re.exec(attrString)) !== null) {
    if (!m[0].trim()) continue;
    const name = m[1];
    if (m[2] !== undefined) props[name] = { type: 'string', value: m[2] };
    else if (m[3] !== undefined) props[name] = { type: 'string', value: m[3] };
    else if (m[4] !== undefined) props[name] = { type: 'expr', value: m[4].trim() };
    else props[name] = { type: 'bare' };
  }
  return props;
}

function serializeAttrs(props) {
  const parts = [];
  for (const [name, v] of Object.entries(props || {})) {
    if (v == null || v.type === 'bare') {
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
// `base`, when a number, is the offset of exprText's '{' in the file (see
// parseTemplate) so the loop's children carry source offsets too.
function tryParseMap(exprText, base = null) {
  const inner = exprText.slice(1, -1); // strip the outer { }
  const arrow = inner.match(/^([\s\S]*?\.map\(\s*\(([^)]*)\)\s*=>\s*\()/);
  if (!arrow) return null;
  const headRaw = arrow[1];
  const openIdx = arrow[0].length - 1; // the arrow-body '('
  const closeIdx = findMatchingParen(inner, openIdx);
  if (closeIdx === -1) return null;
  // After the body must come only the .map() close paren.
  if (!/^\s*\)\s*$/.test(inner.slice(closeIdx + 1))) return null;
  const body = inner.slice(openIdx + 1, closeIdx);
  // inner starts one char into exprText, and body one char past the arrow '('.
  const parsed = parseTemplate(body, base === null ? null : base + 1 + openIdx + 1);
  if (!parsed.clean) return null;
  return {
    id: makeId(),
    kind: 'map',
    head: headRaw.replace(/\s+/g, ' ').trim(), // e.g. "stats.map((stat) => ("
    children: parsed.nodes,
  };
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
    if (text.trim()) {
      const value =
        (/^\s/.test(text) ? ' ' : '') +
        collapseWhitespace(text) +
        (/\s$/.test(text) ? ' ' : '');
      nodes.push(at({ id: makeId(), kind: 'text', value }, pos, textEnd));
    }
    if (next === -1) break;

    // {expression} — a recognized .map() becomes a structural loop node;
    // anything else is kept verbatim as an opaque node (may contain JSX).
    if (next === br && (lt === -1 || br < lt)) {
      const close = findMatchingBrace(str, br);
      if (close === -1) return bail(nodes, str, br, 'an unclosed { … } expression');
      const exprText = str.slice(br, close + 1);
      const mapNode = tryParseMap(exprText, base === null ? null : base + br);
      nodes.push(at(mapNode || { id: makeId(), kind: 'expr', value: exprText }, br, close + 1));
      pos = close + 1;
      continue;
    }

    // Comment
    if (str.startsWith('<!--', lt)) {
      const end = str.indexOf('-->', lt + 4);
      if (end === -1) return bail(nodes, str, lt, 'an unclosed <!-- comment');
      nodes.push(at({ id: makeId(), kind: 'comment', value: str.slice(lt + 4, end) }, lt, end + 3));
      pos = end + 3;
      continue;
    }

    // Doctype
    if (/^<!doctype/i.test(str.slice(lt))) {
      const end = str.indexOf('>', lt);
      if (end === -1) return bail(nodes, str, lt, 'an unclosed <!doctype>');
      nodes.push(at({ id: makeId(), kind: 'raw-line', value: str.slice(lt, end + 1) }, lt, end + 1));
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
    if (/=\s*\{[^{}]*\{[^{}]*\{/.test(attrs)) return bail(nodes, str, lt, 'an attribute with deeply nested { } braces');
    const isComponent = /^[A-Z]/.test(name);
    const kind = isComponent ? 'component' : 'element';
    const afterOpen = lt + full.length;

    if (selfClose === '/' || (!isComponent && VOID_ELEMENTS.has(name.toLowerCase()))) {
      nodes.push(
        at({ id: makeId(), kind, name, props: parseAttrs(attrs), children: null }, lt, afterOpen)
      );
      pos = afterOpen;
      continue;
    }

    // <style>/<script>: capture inner verbatim, no parsing.
    if (!isComponent && RAW_ELEMENTS.has(name.toLowerCase())) {
      const close = str.indexOf(`</${name}`, afterOpen);
      if (close === -1) return bail(nodes, str, lt, `an unclosed <${name}> block`);
      const closeEnd = str.indexOf('>', close);
      nodes.push(
        at(
          {
            id: makeId(),
            kind: 'raw',
            name,
            props: parseAttrs(attrs),
            inner: str.slice(afterOpen, close),
          },
          lt,
          closeEnd + 1
        )
      );
      pos = closeEnd + 1;
      continue;
    }

    const closeIdx = findMatchingClose(str, afterOpen, name);
    if (closeIdx === -1) return bail(nodes, str, lt, `an unclosed <${name}> tag`);
    const innerResult = parseTemplate(
      str.slice(afterOpen, closeIdx),
      base === null ? null : base + afterOpen
    );
    if (!innerResult.clean) return { nodes, clean: false }; // the inner frame recorded the cause
    // The close tag may contain whitespace: </Name >
    const tagEnd = str.indexOf('>', closeIdx) + 1;
    nodes.push(
      at(
        {
          id: makeId(),
          kind,
          name,
          props: parseAttrs(attrs),
          children: innerResult.nodes,
        },
        lt,
        tagEnd
      )
    );
    pos = tagEnd;
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
// `opts.locs` records source offsets on every node and the body's own start
// offset on the model — for reading a location out of the file on disk, not
// for the editor's live model (see parseTemplate).
function parsePage(source, opts = {}) {
  const fm = source.match(/^---\r?\n(?:([\s\S]*?)\r?\n)?---\r?\n?/);
  const frontmatter = fm ? fm[1] || '' : '';
  const bodyStart = fm ? fm[0].length : 0;
  const body = source.slice(bodyStart);

  const imports = [];
  let extraFrontmatter = frontmatter;
  let m;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(frontmatter)) !== null) {
    imports.push({ name: m[1], path: m[2] });
    extraFrontmatter = extraFrontmatter.replace(m[0], '');
  }
  extraFrontmatter = extraFrontmatter.trim();

  lastBail = null;
  const { nodes: topNodes, clean } = parseTemplate(body, opts.locs ? bodyStart : null);
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

  const importsByName = Object.fromEntries(imports.map((i) => [i.name, i]));

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
      if (n.kind === 'component' && !importsByName[n.name]) n.dynamicTag = true;
      if (Array.isArray(n.children)) markDynamic(n.children);
    }
  };
  markDynamic(topNodes);

  return {
    editable: true,
    model: { imports, extraFrontmatter, nodes: topNodes, ...(opts.locs ? { bodyStart } : {}) },
  };
}

function serializePage(model) {
  const lines = ['---'];
  for (const imp of model.imports) {
    lines.push(`import ${imp.name} from '${imp.path}';`);
  }
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
    case 'map':
      lines.push(indent + '{');
      lines.push(indent + '  ' + node.head);
      for (const child of node.children || []) serializeNode(child, indent + '    ', lines);
      lines.push(indent + '  ))');
      lines.push(indent + '}');
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
// <template data-avb-s/e="path"> boundary markers (path = index trail, e.g.
// "0.2.1") so the preview iframe can map rendered DOM back to model nodes.
// The preview strips the markers from the DOM right after recording them, so
// they never affect structural CSS selectors (:first-child, :nth-child, …).
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
  for (const imp of model.imports) {
    const mark = /\.html\?raw$/i.test(imp.path) ? marks.get(imp.name) : null;
    const spec = mark
      ? `${imp.path}&avb=${mark.path}${mark.group ? '&avbg=1' : ''}`
      : imp.path;
    lines.push(`import ${imp.name} from '${spec}';`);
  }
  if (model.extraFrontmatter) {
    lines.push('', model.extraFrontmatter);
  }
  lines.push('---');
  model.nodes.forEach((node, i) => serializeNodeMarked(node, '', lines, `${prefix}${i}`));
  return lines.join('\n') + '\n';
}

function serializeNodeMarked(node, indent, lines, key) {
  if (node.kind === 'chunk-group') return; // synthetic, not in page source
  // A slotted node's markers must go into the same named slot, or they'd
  // land in the default slot while the node renders elsewhere.
  const slotVal = node.props?.slot;
  const slotAttr =
    slotVal && slotVal.type === 'string' && slotVal.value ? ` slot="${slotVal.value}"` : '';
  lines.push(`${indent}<template${slotAttr} data-avb-s="${key}"></template>`);
  if (
    (node.kind === 'component' || node.kind === 'element') &&
    !node.chunkFile &&
    !node.chunkAggregate &&
    Array.isArray(node.children) &&
    // Inline runs serialize as one line — markers between words would break
    // spacing (each marker's surrounding newlines render as a space).
    !(node.children.length > 0 && isInlineRun(node.children))
  ) {
    const attrs = serializeAttrs(node.props);
    lines.push(`${indent}<${node.name}${attrs}>`);
    node.children.forEach((child, i) =>
      serializeNodeMarked(child, indent + '  ', lines, `${key}.${i}`)
    );
    lines.push(`${indent}</${node.name}>`);
  } else if (node.kind === 'map') {
    // Loop children render once per item, so their marker pairs repeat in
    // the DOM — the collector unions every instance into one region.
    lines.push(indent + '{');
    lines.push(indent + '  ' + node.head);
    (node.children || []).forEach((child, i) =>
      serializeNodeMarked(child, indent + '    ', lines, `${key}.${i}`)
    );
    lines.push(indent + '  ))');
    lines.push(indent + '}');
  } else {
    serializeNode(node, indent, lines);
  }
  lines.push(`${indent}<template${slotAttr} data-avb-e="${key}"></template>`);
}

// ---------------------------------------------------------------------------
// Component prop schema extraction
// ---------------------------------------------------------------------------

// Returns [{name, type: 'string'|'number'|'boolean'|'other', optional, default}]
function parsePropSchema(source) {
  const fm = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const frontmatter = fm ? fm[1] : '';
  const schema = new Map();

  // Collect local type aliases (type HeadingTag = "h1" | "h2" | ...) so
  // props referencing them resolve to their union options.
  const aliases = new Map();
  const aliasRe = /(?:export\s+)?type\s+(\w+)\s*=\s*([\s\S]*?);/g;
  let am;
  while ((am = aliasRe.exec(frontmatter)) !== null) {
    if (am[1] !== 'Props') aliases.set(am[1], am[2].trim());
  }

  const iface = frontmatter.match(/(?:export\s+)?(?:interface|type)\s+Props\s*(?:extends\s+[^{]+)?(?:=\s*)?\{([\s\S]*?)\n\}/);
  if (iface) {
    const entryRe = /^\s*(\w+)(\?)?\s*:\s*([^;\n]+?)[;,]?\s*$/gm;
    let m;
    while ((m = entryRe.exec(iface[1])) !== null) {
      let typeStr = m[3].trim();
      if (aliases.has(typeStr)) typeStr = aliases.get(typeStr);
      const { type, options } = normalizeType(typeStr);
      schema.set(m[1], {
        name: m[1],
        type,
        options,
        optional: !!m[2],
        default: undefined,
      });
    }
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
  if (group) lines.push(`<template data-avb-s="${prefix}"></template>`);
  nodes.forEach((node, i) => serializeNodeMarked(node, '', lines, `${prefix}.${i}`));
  if (group) lines.push(`<template data-avb-e="${prefix}"></template>`);
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
  parseAttrs,
  serializeAttrs,
};
