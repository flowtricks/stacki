// Printing the page model back to .astro source: each node kind, inline
// runs kept on one line, and text, expressions and blocks written as they
// were authored when the model left them unchanged.

import { parseSerializeNodes } from './astroParserValidation';
import { collapseText, encodeText, textValue } from '../../shared/page/htmlText';
import type { Attr } from '../../shared/page/pageNode';
import { assert } from '../../shared/core/assert';
import { LIMITS } from '../../shared/core/limits';
import type { ParserNode, MapNode, CondNode, ValueNode } from './astroParserTypes';
import { serializeMapCallback } from './astroMapSerialize';
import { attrsAsWritten, serializeAttrs, required } from './astroAttrs';
import { normalizeHead, blockHead } from './astroScan';

// Inline runs (text + simple tags like <strong>/<em>) serialize on a single
// line so the exact spacing between words and tags survives the round trip.
const INLINE_TAGS = new Set(['strong', 'em', 'b', 'i', 'sup', 'sub', 'code', 'a', 'span', 'br', 'small', 'mark', 'u', 's']);

// Simple {expr} interpolations (single braces, no JSX) count as inline.
function isSimpleExpr(node: ParserNode): boolean {
  return node.kind === 'expr' && /^\{[^{}]*\}$/.test(node.value) && !node.value.includes('<');
}

// `depth` is how deep `nodes` sit. The parser asks about trees still being built, which are
// bounded only once complete, so past the bound the answer is no: such a tree is refused whole.
export function isInlineRun(nodes: readonly ParserNode[], depth: number): boolean {
  if (depth > LIMITS.treeDepthMax) {
    return false;
  }
  return (
    nodes.length > 0 &&
    nodes.every(
      (node) =>
        node.kind === 'text' ||
        isSimpleExpr(node) ||
        (node.kind === 'element' &&
          INLINE_TAGS.has(node.name.toLowerCase()) &&
          (node.children === undefined || node.children.length === 0 || isInlineRun(node.children, depth + 1))),
    )
  );
}

function inlineString(nodes: readonly ParserNode[], depth: number): string {
  assert(depth <= LIMITS.treeDepthMax, 'inlineString: depth limit');
  let out = '';
  for (const node of nodes) {
    // Same rule as a text node on its own (see the 'text' case in
    // serializeNode): the file keeps its own spelling of a character until
    // somebody edits the words, and then the characters are what there is.
    if (node.kind === 'text') {
      out += textOut(node);
    } else if (node.kind === 'expr') {
      out += node.value;
    } else if (node.kind !== 'element') {
      assert(false, 'Inline runs contain only text, expressions, and elements');
    } else if (node.children === undefined) {
      out += node.name === 'br' ? '<br />' : `<${node.name}${serializeAttrs(node.props, node.attrOrder)} />`;
    } else if (node.children.length === 0) {
      // Written as a pair with nothing between them. Closing it as `<span />`
      // says the same thing to a browser and a different thing to a diff.
      out += `<${node.name}${serializeAttrs(node.props, node.attrOrder)}></${node.name}>`;
    } else {
      out += `<${node.name}${serializeAttrs(node.props, node.attrOrder)}>` + inlineString(node.children, depth + 1) + `</${node.name}>`;
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
export function tagInlineRun(
  nodes: readonly ParserNode[],
  path: string,
  { atRoot, depth }: { readonly atRoot: boolean; readonly depth: number },
): ParserNode[] {
  assert(depth <= LIMITS.treeDepthMax, 'tagInlineRun: depth limit');
  return nodes.map((node, i) => {
    if (node.kind !== 'element') {
      return node;
    }
    const childPath = `${path}.${i}`;
    const forwards = Object.keys(node.props || {}).some((key) => key.startsWith('...'));
    const pathProp: Attr =
      atRoot || forwards
        ? {
            type: 'expr',
            value: `[${JSON.stringify(childPath)}, Astro.props["data-avb-p"]]` + '.filter(Boolean).join(" ")',
          }
        : { type: 'string', value: childPath };
    const tagged: ParserNode = {
      ...node,
      source: undefined,
      // As on a block element, the explicit marker precedes a spread: HTML
      // keeps the first duplicate attribute, which must name this child too.
      props: forwards ? { 'data-avb-p': pathProp, ...node.props } : { ...node.props, 'data-avb-p': pathProp },
      attrOrder: forwards && node.attrOrder ? ['data-avb-p', ...node.attrOrder] : node.attrOrder,
    };
    if (Array.isArray(node.children) && node.children.length > 0) {
      tagged.children = tagInlineRun(node.children, childPath, { atRoot: false, depth: depth + 1 });
    }
    return tagged;
  });
}

// A node still saying exactly what the file said keeps the lines it was
// written on — the same bargain `headSource` strikes for a loop head. A text
// node without source still needs escaping before its new line breaks are preserved.
function textAsWritten(node: ValueNode): string | undefined {
  if (!node.source) {
    return encodeText(node.value);
  }
  return textValue(node.source) === node.value ? node.source : undefined;
}

// A text node on its way into the file. Untouched, the file keeps its own
// spelling of a character — `&copy;` goes back as `&copy;`, not as the © it was
// read as, which would be the editor rewriting a page it was only asked to
// open. Edited (or never read from a file at all), the characters are what
// there is, and the three that would otherwise be markup — plus the spaces a
// source file cannot show — become entities again.
function textOut(node: ValueNode): string {
  const source = node.source;
  return source !== undefined && textValue(source) === node.value ? collapseText(source) : encodeText(node.value);
}

// Whitespace inside an inline run is collapsed by the renderer, so the run can
// be shifted to a new indent without changing a thing about the page. Worth
// doing: an element that has been moved, or whose ancestor was re-indented,
// would otherwise hold the indentation of wherever it used to live. The last
// line of the stored inner is the whitespace before the closing tag, which is
// the indent the element was written at.
function reindentRun(source: string, indent: string): string {
  const lines = source.split('\n');
  const base = required(lines[lines.length - 1], 'Split source has a final line');
  if (lines.length < 2 || !/^[ \t]*$/.test(base) || base === indent) {
    return source;
  }
  let shift: (line: string) => string;
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

// Whitespace between two inline tags lives in text nodes the tree drops, so
// comparing runs has to ignore it entirely rather than merely collapse it.
const squash = (text: string) => text.replace(/\s+/g, '');

// Does an element's stored inner still describe the run hanging off it? Both
// sides collapse to the same words when nothing has been edited: a changed
// word, an added child or a rewritten inline tag all break the match, and the
// run is reflowed onto one line as before. Compared trimmed because the
// whitespace-only tail before a closing tag is in the source and not in the
// tree — which is the whole reason the source is kept.
function inlineRunUnchanged(node: ParserNode, depth: number): boolean {
  return (
    !!node.source &&
    node.source.includes('\n') &&
    // Compared in the file's own spelling on both sides: inlineString writes
    // `&rsquo;` back as `&rsquo;` for a node nobody has touched, and decoding
    // one side would call every hand-wrapped run with an entity in it changed
    // — reflowing the paragraph onto one line for having been looked at.
    squash(collapseText(node.source)) === squash(inlineString(node.children ?? [], depth + 1))
  );
}

// A block — a condition, a loop — as the file wrote it, or undefined once anything
// inside it has changed. It is rebuilt the way this file would write it from
// scratch and the two are compared with whitespace and this file's own
// brackets taken out, so the question is whether they say the same thing
// rather than whether they were laid out the same way. Rebuilding by running
// the serializer over a copy with the source removed means there is only one
// description of how these are written, and this cannot drift from it.
function blockAsWritten(node: ParserNode, indent: string, depth: number): string[] | undefined {
  if (!node.source) {
    return undefined;
  }
  const probe = { ...node, source: undefined, blankBefore: 0, blankAfter: 0 };
  const rebuilt: string[] = [];
  serializeNode(probe, '', rebuilt, depth);
  const flat = (text: string) => text.replace(/[\s(){}]+/g, '').trim();
  // A trailing callback comma belongs to `.map(...)`, not to the returned
  // conditional. The rebuilt form may omit that optional separator while the
  // untouched source must retain its original spelling.
  const comparedSource =
    node.kind === 'map' && node.children.length === 1 && node.children[0]?.kind === 'cond' ? node.source.replace(/,(\s*\)\s*\})$/, '$1') : node.source;
  if (flat(rebuilt.join('\n')) !== flat(comparedSource)) {
    return undefined;
  }
  const sourceLines = node.source.split('\n');
  const finalLine = required(sourceLines[sourceLines.length - 1], 'Source has a final line');
  const base = (finalLine.match(/^[ \t]*/) || [''])[0];
  return sourceLines.map((line, i) => (i === 0 ? indent + line : line.startsWith(base) ? indent + line.slice(base.length) : line));
}

// A conditional without the { } that put it in markup context. An else-if
// chain is one of these directly inside another's else — writing the braces
// there would make it an object literal, not a nested condition.
// `depth` is the condition's own; its branches sit one below it and their contents two.
function serializeCondBody(node: CondNode, indent: string, lines: string[], depth: number): void {
  assert(depth <= LIMITS.treeDepthMax, 'serializeCondBody: depth limit');
  const kidsOf = (i: number) => node.children?.[i]?.children || [];
  const thenKids = kidsOf(0);
  const elseKids = node.op === '&&' ? undefined : kidsOf(1);
  const chained = elseKids && elseKids.length === 1 && elseKids[0]?.kind === 'cond' ? elseKids[0] : undefined;
  // `()` is a syntax error, so a branch holding nothing is written as `null` —
  // the same thing a hand-written conditional does.
  const tail = elseKids === undefined ? '' : chained ? ' :' : elseKids.length ? ' : (' : ' : null';
  const head = `${node.test} ${node.op === '&&' ? '&&' : '?'} `;
  // A branch's parens are JS, not JSX: an expression goes in there as itself.
  // `{heading}` would be a block, and `{ a: 1 }` an object — neither is what
  // the author wrote.
  const branchOut = (kids: readonly ParserNode[], at: string) => {
    if (kids.length === 1 && kids[0]?.kind === 'expr') {
      const raw = String(kids[0].value ?? '')
        .trim()
        .replace(/^\{/, '')
        .replace(/\}$/, '');
      raw.split('\n').forEach((line, i) => lines.push(i === 0 ? at + line : line));
      return;
    }
    for (const child of kids) {
      serializeNode(child, at, lines, depth + 2);
    }
  };
  if (thenKids.length) {
    lines.push(indent + head + '(');
    branchOut(thenKids, indent + '  ');
    lines.push(indent + ')' + tail);
  } else {
    lines.push(indent + head + 'null' + tail);
  }
  if (chained) {
    serializeCondBody(chained, indent, lines, depth + 2);
  } else if (elseKids && elseKids.length) {
    branchOut(elseKids, indent + '  ');
    lines.push(indent + ')');
  }
}

export function serializeNode(node: ParserNode, indent: string, lines: string[], depth: number): void {
  // Every caller hands over a validated tree (parseSerializePage, parseSerializeNodes), whose
  // depth is already within the bound.
  assert(depth <= LIMITS.treeDepthMax, 'serializeNode: depth limit');
  // Chunk containers: children live in external .html files (set:html),
  // never in the page — emit the component self-closing, skip the subtree.
  if (node.kind === 'chunk-group') {
    return;
  } // synthetic, not in page source
  // The gap the author left in front of this node.
  for (let i = 0; i < (node.blankBefore || 0); i++) {
    lines.push('');
  }
  if (node.chunkFile || node.chunkAggregate) {
    lines.push(`${indent}<${node.name}${serializeAttrs(node.props, node.attrOrder)} />`);
    return;
  }
  switch (node.kind) {
    case 'text':
      return serializeNodeText(node, indent, lines);
    case 'expr': {
      // Verbatim, multi-line safe: only the first line gets the tree indent
      // (subsequent lines carry their original indentation).
      const exprLines = node.value.split('\n');
      lines.push(indent + exprLines[0]);
      for (let i = 1; i < exprLines.length; i++) {
        lines.push(required(exprLines[i], 'Expression line index is in bounds'));
      }
      return;
    }
    case 'map':
      return serializeNodeMap(node, indent, lines, depth);
    case 'cond': {
      const kept = blockAsWritten(node, indent, depth);
      if (kept) {
        for (const line of kept) {
          lines.push(line);
        }
        return;
      }
      lines.push(indent + '{');
      serializeCondBody(node, indent + '  ', lines, depth);
      lines.push(indent + '}');
      return;
    }
    case 'branch':
      // Written by the condition above; standing on its own it is just its
      // contents.
      for (const child of node.children || []) {
        serializeNode(child, indent, lines, depth + 1);
      }
      return;
    case 'comment':
      lines.push(node.jsx ? `${indent}{/*${node.value}*/}` : `${indent}<!--${node.value}-->`);
      return;
    case 'raw-line':
      lines.push(indent + node.value);
      return;
    case 'raw':
      return serializeNodeRaw(node, indent, lines);
    case 'component':
    case 'element':
      return serializeNodeElement(node, indent, lines, depth);
  }
}

// Serializes a plain node list (used for standalone HTML chunk files).
export function serializeNodes(input: readonly unknown[]): string {
  const nodes = parseSerializeNodes(input);
  const lines: string[] = [];
  for (const node of nodes) {
    serializeNode(node, '', lines, 0);
  }
  return lines.join('\n') + '\n';
}

function serializeNodeCallback(node: MapNode, indent: string, lines: string[], depth: number): void {
  const text = serializeMapCallback(node, (child) => {
    const rendered: string[] = [];
    serializeNode(child, '', rendered, depth + 1);
    return rendered.join('\n');
  });
  lines.push(indent + text);
}

function serializeNodeText(node: ValueNode, indent: string, lines: string[]): void {
  // Prose the author wrapped by hand comes back on the lines they wrapped
  // it on. Each line already carries its own indentation; only the first
  // takes the tree's, the way a multi-line expression does.
  const written = textAsWritten(node);
  if (written === undefined || !written.includes('\n')) {
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
  lines.push(indent + required(first, 'Split text has a first line').replace(/^[ \t]+/, ''));
  for (const line of more) {
    lines.push(line);
  }
  return;
}

function serializeNodeMap(node: MapNode, indent: string, lines: string[], depth: number): void {
  const keptMap = blockAsWritten(node, indent, depth);
  if (keptMap) {
    for (const line of keptMap) {
      lines.push(line);
    }
    return;
  }
  if (node.bodyParts !== undefined) {
    return serializeNodeCallback(node, indent, lines, depth);
  }
  lines.push(indent + '{');
  // A loop whose body declares things keeps the statement form: the
  // declarations, then the markup inside `return ( … )`.
  if (node.body && node.body.length) {
    lines.push(indent + '  ' + blockHead(node.head));
    for (const line of node.body) {
      lines.push(indent + '    ' + line);
    }
    lines.push(indent + '    return (');
    for (const child of node.children || []) {
      serializeNode(child, indent + '      ', lines, depth + 1);
    }
    lines.push(indent + '    );');
    lines.push(indent + '  })');
    lines.push(indent + '}');
    return;
  }
  // A callback returning a ternary is one JavaScript expression. Writing the
  // conditional as a template `{...}` here would turn it into a block instead.
  const conditional = node.children.length === 1 ? node.children[0] : undefined;
  if (conditional?.kind === 'cond') {
    lines.push(indent + '  ' + node.head);
    serializeCondBody(conditional, indent + '    ', lines, depth + 1);
    lines.push(indent + '  ))');
    lines.push(indent + '}');
    return;
  }
  // A loop written without parens around its body keeps that shape —
  // adding them would rewrite a line the user never edited.
  if (node.bare) {
    lines.push(indent + '  ' + node.head.replace(/\($/, '').trimEnd());
    serializeLoopBody(node, indent + '    ', lines, depth);
    lines.push(indent + '  )');
    lines.push(indent + '}');
    return;
  }
  // Untouched heads keep the lines they were written on; an edited one is
  // written as the single line the Loop field holds.
  const kept = node.headSource && normalizeHead(node.headSource) === node.head ? node.headSource : undefined;
  // The body belongs under `.map(`, which on a chain written across lines
  // is indented past the head's own first line — so the loop's contents
  // hang off the LAST head line, not off the node.
  let inner = '';
  if (kept) {
    const headLines = kept.split('\n');
    for (const line of headLines) {
      lines.push(line ? indent + '  ' + line : '');
    }
    inner = required(headLines[headLines.length - 1], 'Loop head has a final line').match(/^[ \t]*/)?.[0] ?? '';
  } else {
    lines.push(indent + '  ' + node.head);
  }
  serializeLoopBody(node, indent + '  ' + inner + '  ', lines, depth);
  lines.push(indent + '  ' + inner + '))');
  lines.push(indent + '}');
  return;
}

// What a loop renders for each item. An arrow's parenthesized body cannot be
// empty: `(item) => ()` does not parse, and the page with it stops building,
// so a loop with nothing in it yet (one just inserted) renders `null`.
function serializeLoopBody(node: MapNode, indent: string, lines: string[], depth: number): void {
  for (const child of node.children || []) {
    serializeNode(child, indent, lines, depth + 1);
  }
  if ((node.children || []).length === 0) {
    lines.push(indent + 'null');
  }
}

function serializeNodeRaw(node: Extract<ParserNode, { kind: 'raw' }>, indent: string, lines: string[]): void {
  const open = `${indent}<${node.name}${serializeAttrs(node.props, node.attrOrder)}>`;
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
  for (const line of inner.split('\n')) {
    lines.push(line);
  }
  lines.push(`${indent}</${node.name}>`);
  return;
}

function serializeNodeElement(node: Extract<ParserNode, { kind: 'element' | 'component' }>, indent: string, lines: string[], depth: number): void {
  const kept = attrsAsWritten(node);
  const attrs = kept === undefined ? serializeAttrs(node.props, node.attrOrder) : kept;
  // A shorthand fragment has no attributes. If the editor adds one (for
  // example slot), use the equivalent named form that can carry it.
  const tagName = node.shorthand && node.name === 'Fragment' && !attrs ? '' : node.name;
  // The closing tag as written, when it was written across lines. Only
  // trusted while it still names this element: renaming the tag rebuilds
  // it the ordinary way.
  const closeTag = node.closeSource && node.closeSource.startsWith(`</${tagName}`) ? node.closeSource : `</${tagName}>`;
  const openTag = (close: string) => {
    // Preserved attributes carry their own trailing whitespace — the line
    // break before the closing bracket — so the usual leading space would
    // be one too many.
    const tail = kept !== undefined && /\s$/.test(attrs) ? close.replace(/^ /, '') : close;
    const text = `${indent}<${tagName}${attrs}${tail}`;
    for (const line of text.split('\n')) {
      lines.push(line);
    }
  };
  if (node.children === undefined) {
    openTag(node.tightClose ? '/>' : ' />');
    return;
  }
  // Inline runs stay on one line: <p>We're <strong>Acme</strong>.</p>
  if (node.children.length > 0 && isInlineRun(node.children, depth + 1)) {
    // Unless the file already wrote the run across several lines and
    // nothing has touched it since. Re-flowing a hand-wrapped paragraph
    // onto one long line is a diff on a page that was only opened, and
    // the stored inner puts the tag back whole — its line breaks, its
    // indentation, and the break before the closing tag.
    if (inlineRunUnchanged(node, depth)) {
      openTag(`>${reindentRun(required(node.source, 'Unchanged inline run has source'), indent)}` + closeTag);
      return;
    }
    // The run's boundary spaces are content, not layout. A text node on a
    // line of its own can trim them — the file's indent hands the boundary
    // whitespace back on reparse (see serializeNodeText) — but a run written
    // on one line has nothing but the value itself to hold them, and the
    // parse keeps exactly one space where the source had any (collapseText).
    // Trimming here made parse∘serialize lossy: a word typed followed by a
    // space came back from the save without it, and the Content field, seeing
    // its own edit echo back different, reset the caret to the start of the
    // line.
    openTag(`>${inlineString(node.children, depth + 1)}${closeTag}`);
    return;
  }
  // No children: the stored inner keeps `<div>\n</div>` as written — but only
  // while it is whitespace. An element whose last child was taken out still
  // carries the inner it was read with, and writing that back put the removed
  // child back (found by the step-6 gesture parity sweep: a deleted element's
  // only child stayed, a moved one appeared twice).
  if (node.children.length === 0) {
    const inner = node.source !== undefined && node.source.trim() === '' ? node.source : '';
    openTag(`>${inner ? reindentRun(inner, indent) : ''}${closeTag}`);
    return;
  }
  openTag('>');
  for (const child of node.children) {
    serializeNode(child, indent + '  ', lines, depth + 1);
  }
  for (let i = 0; i < (node.blankAfter || 0); i++) {
    lines.push('');
  }
  for (const line of `${indent}${closeTag}`.split('\n')) {
    lines.push(line);
  }
}
