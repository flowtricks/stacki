// Parses .md / .mdx pages into the same editable tree model as .astro pages,
// and serializes the model back to markdown.
//
// The tree uses the node kinds the rest of the app already understands, so the
// navigator, the props panel, text editing, undo, copy/paste and the insert
// palette all work without knowing markdown exists:
//
//   heading      → element h1…h6      paragraph  → element p
//   list         → element ul / ol     list item  → element li
//   blockquote   → element blockquote  rule       → element hr
//   fenced code  → element pre (props.lang), one text child holding the code
//   image-only   → element img (props.src / props.alt)
//   anything else → raw-line, kept verbatim
//
// Inline formatting (**bold**, [links](…), `code`) stays as markdown inside the
// text node rather than becoming a tree of its own. That keeps a paragraph one
// editable field — the way a writer thinks about it — and, more importantly,
// makes the round trip exact: text this parser does not interpret is text it
// cannot corrupt.
//
// ROUND TRIP IS THE CONSTRAINT. Opening a page must never rewrite it. Every
// block records the source details that would otherwise be normalised away —
// the bullet character, the fence character and width, setext vs ATX headings,
// blank lines between items — so serializing an untouched page reproduces it
// byte for byte. There are round-trip tests over a realistic post; anything
// this file cannot reproduce exactly belongs in a raw-line instead.

const { parseTemplate, serializeNodes, parseAttrs } = require('./astroParser');

let nextId = 1;
const makeId = () => `m${nextId++}`;

const ATX_RE = /^(\s{0,3})(#{1,6})(\s+)(.*?)(\s*#*\s*)$/;
const FENCE_RE = /^(\s{0,3})(`{3,}|~{3,})\s*(.*)$/;
const RULE_RE = /^(\s{0,3})((?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/;
const BULLET_RE = /^(\s*)([-*+])(\s+)(.*)$/;
const ORDERED_RE = /^(\s*)(\d{1,9})([.)])(\s+)(.*)$/;
const QUOTE_RE = /^(\s{0,3})>(\s?)(.*)$/;
const SETEXT_RE = /^(\s{0,3})(=+|-+)\s*$/;
// A line that is nothing but an image — the one inline construct promoted to a
// node of its own, so the asset picker can edit it like any other <img>.
const IMAGE_ONLY_RE = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)$/;
const ESM_RE = /^(import|export)\s/;

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

// Markdown frontmatter is YAML, not JS, so it is kept as text and handed to the
// same frontmatter editor .astro pages use. `layout:` is read back out by name
// because the layout picker needs it — see layoutFromFrontmatter.
function splitFrontmatter(source) {
  const m = source.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/);
  if (!m) return { frontmatter: null, body: source, offset: 0 };
  return { frontmatter: m[1], body: source.slice(m[0].length), offset: m[0].length };
}

// The `layout:` value from YAML frontmatter, unquoted. Markdown pages pick
// their layout here rather than by importing it, so the app's layout picker
// reads and writes this field.
function layoutFromFrontmatter(frontmatter) {
  if (!frontmatter) return null;
  const m = frontmatter.match(/^[ \t]*layout[ \t]*:[ \t]*(.+?)[ \t]*$/m);
  if (!m) return null;
  return m[1].replace(/^['"]|['"]$/g, '') || null;
}

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------

// Splits `lines` (already dedented to its own container) into block nodes.
// `mdx` enables ESM imports and JSX blocks; `imports` collects the former.
function parseBlocks(lines, { mdx, imports, esm }) {
  const nodes = [];
  let i = 0;

  const blankRun = () => {
    let n = 0;
    while (i < lines.length && !lines[i].trim()) {
      n++;
      i++;
    }
    return n;
  };

  // Blank lines are carried on the node that follows them, so the exact
  // spacing of the source comes back on serialize.
  let pendingBlanks = 0;
  const push = (node) => {
    node.id = makeId();
    if (pendingBlanks) node.mdBlanksBefore = pendingBlanks;
    pendingBlanks = 0;
    nodes.push(node);
  };

  while (i < lines.length) {
    if (!lines[i].trim()) {
      pendingBlanks += blankRun();
      continue;
    }
    const line = lines[i];

    // ── MDX: ESM imports and exports ──────────────────────────────────────
    // Hoisted out of the body into the same `imports` list an .astro page
    // has, so the palette can tell which components this page can use.
    if (mdx && ESM_RE.test(line)) {
      const start = i;
      while (i < lines.length && lines[i].trim()) i++;
      const text = lines.slice(start, i).join('\n');
      const im = text.match(/^import\s+(\w+)\s+from\s+['"]([^'"]+)['"]/);
      if (im) imports.push({ name: im[1], path: im[2] });
      else esm.push(text);
      // Recorded so the block order survives even though the text lives
      // outside the tree.
      push({ kind: 'raw-line', value: text, mdEsm: true });
      continue;
    }

    // ── MDX / markdown: an HTML or JSX block ──────────────────────────────
    // A component in MDX is exactly the JSX an .astro page holds, so it is
    // parsed by the .astro parser and lands in the tree as the same node —
    // which is what makes a component inside a post selectable and editable.
    if (/^\s{0,3}</.test(line)) {
      const start = i;
      // JSX/HTML runs to the first blank line at depth zero, which is how
      // both markdown and MDX delimit an embedded block.
      while (i < lines.length && lines[i].trim()) i++;
      const text = lines.slice(start, i).join('\n');
      const parsed = parseTemplate(text);
      // One node per block, not per element. The canvas numbers markdown
      // blocks by their index among the document's root nodes, and remark
      // treats a run of raw HTML as a single node however many tags it holds
      // — so a block that opens two sibling elements has to stay one node
      // here too, or every block after it would be numbered one too high.
      // MDX is exempt: there each JSX element really is its own root node.
      const oneNode = parsed.clean && parsed.nodes.length === 1;
      if (!mdx && !oneNode) {
        push({ kind: 'raw-line', value: text });
        continue;
      }
      if (parsed.clean && parsed.nodes.length) {
        // The .astro serializer reflows what it writes (a short component
        // collapses onto one line). That is fine for a page it owns, but here
        // it would reformat a post the moment anything else on the page is
        // edited. Keeping the source lets serializeBlock emit it verbatim for
        // as long as the node still means the same thing.
        if (parsed.nodes.length === 1) parsed.nodes[0].mdSource = text;
        for (const n of parsed.nodes) push(n);
      } else {
        push({ kind: 'raw-line', value: text });
      }
      continue;
    }

    // ── Fenced code ───────────────────────────────────────────────────────
    const fence = line.match(FENCE_RE);
    if (fence) {
      const [, indent, marker, info] = fence;
      const char = marker[0];
      const body = [];
      i++;
      let closed = false;
      while (i < lines.length) {
        const close = lines[i].match(/^(\s{0,3})(`{3,}|~{3,})\s*$/);
        if (close && close[2][0] === char && close[2].length >= marker.length) {
          i++;
          closed = true;
          break;
        }
        body.push(lines[i]);
        i++;
      }
      push({
        kind: 'element',
        name: 'pre',
        props: info.trim() ? { lang: { type: 'string', value: info.trim() } } : {},
        children: body.length ? [{ id: makeId(), kind: 'text', value: body.join('\n') }] : [],
        mdIndent: indent,
        mdFence: marker,
        mdInfo: info,
        mdUnclosed: !closed || undefined,
      });
      continue;
    }

    // ── Thematic break ────────────────────────────────────────────────────
    // Checked before lists: `- - -` is a rule, not three bullets.
    const rule = line.match(RULE_RE);
    if (rule) {
      push({ kind: 'element', name: 'hr', props: {}, children: null, mdRaw: line });
      i++;
      continue;
    }

    // ── ATX heading ───────────────────────────────────────────────────────
    const atx = line.match(ATX_RE);
    if (atx) {
      const [, indent, hashes, gap, text, trail] = atx;
      push({
        kind: 'element',
        name: `h${hashes.length}`,
        props: {},
        children: text ? [{ id: makeId(), kind: 'text', value: text }] : [],
        mdIndent: indent,
        mdGap: gap,
        mdTrail: trail,
      });
      i++;
      continue;
    }

    // ── Blockquote ────────────────────────────────────────────────────────
    if (QUOTE_RE.test(line)) {
      const inner = [];
      let gap = ' ';
      while (i < lines.length) {
        const q = lines[i].match(QUOTE_RE);
        if (!q) {
          // A lazy continuation line belongs to the quote's last paragraph.
          if (!lines[i].trim() || /^\s{0,3}(#|>|```|~~~|[-*+]\s|\d+[.)]\s)/.test(lines[i])) break;
          inner.push(lines[i]);
          i++;
          continue;
        }
        if (q[2]) gap = q[2];
        inner.push(q[3]);
        i++;
      }
      push({
        kind: 'element',
        name: 'blockquote',
        props: {},
        children: parseBlocks(inner, { mdx, imports, esm }),
        mdGap: gap,
      });
      continue;
    }

    // ── Lists ─────────────────────────────────────────────────────────────
    const bullet = line.match(BULLET_RE);
    const ordered = line.match(ORDERED_RE);
    if (bullet || ordered) {
      const listIndent = (bullet || ordered)[1];
      const ol = !!ordered;
      const items = [];
      let looseSeen = false;
      let marker = ol ? ordered[3] : bullet[2];
      const start = ol ? Number(ordered[2]) : null;
      let numbers = [];

      while (i < lines.length) {
        const b = lines[i].match(BULLET_RE);
        const o = lines[i].match(ORDERED_RE);
        const m = ol ? o : b;
        // A different marker or indent starts a different list.
        if (!m || m[1] !== listIndent) break;
        if (ol ? m[3] !== marker : m[2] !== marker) break;
        if (ol) numbers.push(Number(m[2]));
        const gap = ol ? m[4] : m[3];
        const first = ol ? m[5] : m[4];
        const contentIndent = listIndent.length + (ol ? m[2].length + 1 : 1) + gap.length;
        const inner = [first];
        i++;
        // Continuation lines: anything indented under the item, plus blank
        // lines that are followed by more of the item.
        while (i < lines.length) {
          if (!lines[i].trim()) {
            let j = i;
            while (j < lines.length && !lines[j].trim()) j++;
            if (j < lines.length && lines[j].startsWith(' '.repeat(contentIndent))) {
              looseSeen = true;
              for (let k = i; k < j; k++) inner.push('');
              i = j;
              continue;
            }
            break;
          }
          if (!lines[i].startsWith(' '.repeat(contentIndent))) break;
          inner.push(lines[i].slice(contentIndent));
          i++;
        }
        items.push({
          id: makeId(),
          kind: 'element',
          name: 'li',
          props: {},
          children: parseBlocks(inner, { mdx, imports, esm }),
          mdGap: gap,
        });
      }

      push({
        kind: 'element',
        name: ol ? 'ol' : 'ul',
        props: ol && start !== 1 ? { start: { type: 'string', value: String(start) } } : {},
        children: items,
        mdIndent: listIndent,
        mdMarker: marker,
        mdLoose: looseSeen || undefined,
        // Re-emitted exactly: a list written 1. 1. 1. must not become 1. 2. 3.
        mdNumbers: ol ? numbers : undefined,
      });
      continue;
    }

    // A table's shape lives in its alignment row; nothing in the tree models
    // that, so it stays source.
    if (line.includes('|') && i + 1 < lines.length && /^[\s|:-]+$/.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const start = i;
      while (i < lines.length && lines[i].trim()) i++;
      push({ kind: 'raw-line', value: lines.slice(start, i).join('\n') });
      continue;
    }

    // ── Paragraph (and the setext heading it can turn out to be) ──────────
    const start = i;
    while (i < lines.length && lines[i].trim()) {
      // A paragraph ends where another block begins.
      if (
        i > start &&
        (ATX_RE.test(lines[i]) ||
          FENCE_RE.test(lines[i]) ||
          RULE_RE.test(lines[i]) ||
          QUOTE_RE.test(lines[i]) ||
          /^\s{0,3}</.test(lines[i]) ||
          SETEXT_RE.test(lines[i]))
      ) {
        break;
      }
      i++;
    }
    const text = lines.slice(start, i).join('\n');

    // An underline directly under paragraph text makes it a heading. This is
    // decided here rather than by looking ahead, because `---` is both a
    // setext underline and a thematic break and only the paragraph above it
    // tells them apart: touching the text it's a heading, separated by a
    // blank line it's a rule (the blank ends the paragraph first, so `lines[i]`
    // is the blank, not the dashes).
    if (i < lines.length && SETEXT_RE.test(lines[i])) {
      const underline = lines[i];
      i++;
      push({
        kind: 'element',
        name: underline.trim()[0] === '=' ? 'h1' : 'h2',
        props: {},
        children: [{ id: makeId(), kind: 'text', value: text }],
        mdSetext: underline,
      });
      continue;
    }
    const img = text.match(IMAGE_ONLY_RE);
    if (img) {
      const props = { src: { type: 'string', value: img[2] } };
      if (img[1]) props.alt = { type: 'string', value: img[1] };
      if (img[3]) props.title = { type: 'string', value: img[3] };
      push({ kind: 'element', name: 'img', props, children: null, mdImage: true });
      continue;
    }
    push({
      kind: 'element',
      name: 'p',
      props: {},
      children: [{ id: makeId(), kind: 'text', value: text }],
    });
  }

  // Trailing blank lines have no node to ride on, so they are recorded on the
  // list itself — otherwise every save would trim the end of the file.
  nodes.mdTrailingBlanks = pendingBlanks;
  return nodes;
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

function serializeBlocks(nodes, out) {
  for (const node of nodes || []) {
    for (let b = 0; b < (node.mdBlanksBefore || 0); b++) out.push('');
    serializeBlock(node, out);
  }
  for (let b = 0; b < (nodes?.mdTrailingBlanks || 0); b++) out.push('');
}

// A node the app created (from the insert palette, or by pasting) has none of
// the md* source details, so these defaults are also the "new block" format.
function serializeBlock(node, out) {
  const textOf = (n) =>
    (n.children || [])
      .filter((c) => c.kind === 'text')
      .map((c) => c.value)
      .join('');

  switch (node.kind) {
    case 'raw-line':
    case 'raw':
      out.push(...String(node.value ?? node.inner ?? '').split('\n'));
      return;
    case 'text':
      out.push(...String(node.value ?? '').split('\n'));
      return;
    case 'comment':
      out.push(`<!--${node.value}-->`);
      return;
    default:
      break;
  }

  const name = node.name || '';
  const indent = node.mdIndent ?? '';

  if (/^h[1-6]$/.test(name)) {
    if (node.mdSetext) {
      out.push(textOf(node));
      out.push(node.mdSetext);
      return;
    }
    const hashes = '#'.repeat(Number(name[1]));
    out.push(`${indent}${hashes}${node.mdGap ?? ' '}${textOf(node)}${node.mdTrail ?? ''}`);
    return;
  }

  if (name === 'p') {
    out.push(...textOf(node).split('\n'));
    return;
  }

  if (name === 'hr') {
    out.push(node.mdRaw ?? '---');
    return;
  }

  if (name === 'img') {
    const val = (p) => (node.props?.[p]?.value ?? '');
    const title = val('title') ? ` "${val('title')}"` : '';
    out.push(`![${val('alt')}](${val('src')}${title})`);
    return;
  }

  if (name === 'pre') {
    const fence = node.mdFence ?? '```';
    const info = node.mdInfo ?? node.props?.lang?.value ?? '';
    out.push(`${indent}${fence}${info}`);
    out.push(...textOf(node).split('\n').filter((l, idx, arr) => !(arr.length === 1 && l === '')));
    if (!node.mdUnclosed) out.push(`${indent}${fence}`);
    return;
  }

  if (name === 'blockquote') {
    const inner = [];
    serializeBlocks(node.children || [], inner);
    const gap = node.mdGap ?? ' ';
    for (const l of inner) out.push(l ? `>${gap}${l}` : '>');
    return;
  }

  if (name === 'ul' || name === 'ol') {
    const ol = name === 'ol';
    const marker = node.mdMarker ?? (ol ? '.' : '-');
    const start = Number(node.props?.start?.value ?? 1) || 1;
    (node.children || []).forEach((item, idx) => {
      for (let b = 0; b < (item.mdBlanksBefore || 0); b++) out.push('');
      const num = ol ? String(node.mdNumbers?.[idx] ?? start + idx) : '';
      const bullet = ol ? `${num}${marker}` : marker;
      const gap = item.mdGap ?? ' ';
      const inner = [];
      serializeBlocks(item.children || [], inner);
      const pad = ' '.repeat(indent.length + bullet.length + gap.length);
      inner.forEach((l, k) => {
        if (k === 0) out.push(`${indent}${bullet}${gap}${l}`);
        else out.push(l ? pad + l : '');
      });
      if (!inner.length) out.push(`${indent}${bullet}`);
    });
    return;
  }

  // Anything else came from JSX (a component in MDX, or an HTML block) — the
  // .astro serializer owns those, and owns them exactly. It returns a string
  // with a trailing newline; markdown works in lines, so drop it.
  const text = serializeNodes([node]).replace(/\n$/, '');
  // Untouched? Then write back what was there. The comparison is between two
  // serializations, not two source strings, so it answers "does this node
  // still say what the source said" rather than "is the text identical" —
  // formatting the .astro writer would normalise doesn't count as a change.
  if (node.mdSource != null) {
    const original = parseTemplate(node.mdSource);
    if (original.clean && original.nodes.length === 1 && serializeNodes(original.nodes).replace(/\n$/, '') === text) {
      out.push(...node.mdSource.split('\n'));
      return;
    }
  }
  out.push(...text.split('\n'));
}

// ---------------------------------------------------------------------------
// Page API — mirrors parsePage / serializePage in astroParser.js
// ---------------------------------------------------------------------------

function parseMarkdownPage(source, { mdx = false } = {}) {
  const { frontmatter, body } = splitFrontmatter(source);
  const imports = [];
  const esm = [];
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = body.split(/\r?\n/);
  // A trailing newline shows up as one empty final element; it is the file's
  // line ending, not a blank line, so it is dropped here and added back on
  // serialize.
  const endsWithNewline = lines.length > 0 && lines[lines.length - 1] === '';
  if (endsWithNewline) lines.pop();

  const nodes = parseBlocks(lines, { mdx, imports, esm });

  return {
    editable: true,
    model: {
      format: mdx ? 'mdx' : 'md',
      imports,
      // The YAML block, shown in the frontmatter editor. `layout:` is also
      // surfaced separately so the layout picker can drive it.
      extraFrontmatter: frontmatter ?? '',
      frontmatterLang: 'yaml',
      layoutPath: layoutFromFrontmatter(frontmatter),
      nodes,
      mdEol: eol,
      mdEndsWithNewline: endsWithNewline,
      mdHasFrontmatter: frontmatter != null,
    },
  };
}

function serializeMarkdownPage(model) {
  const out = [];
  const fm = model.extraFrontmatter ?? '';
  if (model.mdHasFrontmatter || fm.trim()) {
    out.push('---');
    if (fm !== '') out.push(...fm.split('\n'));
    out.push('---');
  }
  serializeBlocks(model.nodes || [], out);
  const eol = model.mdEol || '\n';
  return out.join(eol) + (model.mdEndsWithNewline === false ? '' : eol);
}

module.exports = {
  parseMarkdownPage,
  serializeMarkdownPage,
  layoutFromFrontmatter,
  splitFrontmatter,
};
