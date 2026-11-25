// Goal: every gesture step 6 ships through the engine means what it meant
// through the legacy path (plan §11 step 6: "parity vs the legacy path for
// that gesture"). The legacy path applies the gesture to the page model and
// reprints the whole file; the engine plans the gesture's edit requests as
// splices on the bytes. Both results must parse to the same page — and the
// engine's may differ from the input only where it spliced.
// Method: for every node of every `.astro` fixture (corpus, round-trip,
// editor-core), each shipped gesture runs both ways: the adapter's effect
// (src/editor/editGestures.ts) on the parsed model, reprinted by serializePage; and
// the adapter's requests (src/editor/pageEdits.ts, nodeRefIn) through main's
// translator (electron/documents/editRequests.ts) and the shipping planner, a later
// request of one gesture rebased through the earlier ones as the host does
// (shared/engine/rebase.ts). The two results are parsed and compared with layout
// metadata removed (ids, source ranges, and the fields that only remember
// how a tag was written); text is compared up to whitespace runs, which the
// reprint reflows. Gestures whose requests cannot be stated are counted, not
// compared: they still take the legacy path in the app. Byte-identical
// results are counted and reported; a model difference fails.
const assert = require('node:assert/strict');
const { LIMITS } = require('#dist/shared/core/limits.js');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const esbuild = require('esbuild');
const { parsePage, serializePage } = require('#dist/electron/parse/astroParser.js');
const { buildEditIntent } = require('#dist/electron/documents/editRequests.js');
const { toDigest, toFilePath, toIntentId } = require('#dist/shared/core/brand.js');
const { toIntent } = require('#dist/shared/engine/intent.js');
const { parsePageResult } = require('#dist/shared/page/pageNode.js');
const { planIntent } = require('#dist/shared/engine/planner.js');
const { rebaseIntent, minimalSplices } = require('#dist/shared/engine/rebase.js');
const { createSnapshot } = require('#dist/shared/page/snapshot.js');
const { projectPage } = require('#dist/shared/page/sourceProjection.js');
const { decodeUtf8, encodeUtf8 } = require('#dist/shared/core/span.js');
const { applySplices } = require('#dist/shared/engine/splice.js');
const { repoPath } = require('../../helpers/sources.js');

const buildDirectory = repoPath('node_modules/.stacki-test/gesture-parity');
fs.mkdirSync(buildDirectory, { recursive: true });
esbuild.buildSync({
  // Named entries: each output is <name>.js wherever its source lives.
  entryPoints: {
    pageEdits: repoPath('src/editor/pageEdits.ts'),
    editGestures: repoPath('src/editor/editGestures.ts'),
  },
  outdir: buildDirectory,
  bundle: true,
  format: 'cjs',
  platform: 'node',
  logLevel: 'silent',
});
const edits = require(path.join(buildDirectory, 'pageEdits.js'));
const gestures = require(path.join(buildDirectory, 'editGestures.js'));

const DIRECTORIES = ['test/corpus', 'test/fixtures/round-trip', 'test/fixtures/editor-core'];
const BOM = '﻿';
const hash = (bytes) => toDigest(crypto.createHash('sha256').update(bytes).digest('hex'));

function snapshotOf(file, text) {
  const projection = projectPage(text, parsePageResult(parsePage(text, { locs: true })));
  return createSnapshot({ path: toFilePath(file), bytes: encodeUtf8(text), projection }, hash);
}

function pages() {
  return DIRECTORIES.flatMap((directory) =>
    fs
      .readdirSync(directory)
      .filter((name) => name.endsWith('.astro'))
      .sort()
      .map((name) => ({
        name: `${directory}/${name}`,
        text: fs.readFileSync(path.join(directory, name), 'utf8'),
      })),
  );
}

function nodesOf(model) {
  const found = [];
  const pending = [...model.nodes];
  for (let index = 0; index < pending.length; index++) {
    const node = pending[index];
    found.push(node);
    if (Array.isArray(node.children) && node.kind !== 'chunk-group') {
      pending.push(...node.children);
    }
  }
  return found;
}

// What the page says, without what only records how it was written.
const LAYOUT = new Set([
  'id',
  'start',
  'end',
  'attrSpans',
  'attrSource',
  'attrOrder',
  'source',
  'closeSource',
  'headSource',
  'blankBefore',
  'blankAfter',
  'tightClose',
  'bodyStart',
  'frontmatterLayout',
  'trailingBlank',
  'extraFrontmatterSpaced',
  'frontmatterLead',
]);
// Text is compared with adjacent text nodes merged and whitespace removed:
// the legacy printer puts each node of a reflowed inline run on its own line
// (duplicate the `.` closing a sentence and it writes `.` twice, a line each,
// which even renders as `. .`), where the engine keeps the bytes (`..`).
// Which words, in which nodes and order, is what the comparison holds equal.
function meaning(value, depth = 0) {
  assert.ok(depth <= LIMITS.ipcDepthMax, 'meaning: value depth limit');
  if (Array.isArray(value)) {
    const merged = [];
    for (const item of value) {
      const last = merged[merged.length - 1];
      if (item && item.kind === 'text' && last && last.kind === 'text') {
        merged[merged.length - 1] = { ...last, value: `${last.value}${item.value}` };
      } else {
        merged.push(item);
      }
    }
    return merged.filter((item) => !(item && item.kind === 'text' && /^\s*$/.test(item.value))).map((item) => meaning(item, depth + 1));
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (!LAYOUT.has(key)) {
        // Defined, not assigned: an attribute may be named `__proto__`.
        Object.defineProperty(out, key, {
          value: meaning(value[key], depth + 1),
          enumerable: true,
        });
      }
    }
    return out;
  }
  // `&quot;` is how the legacy printer writes a double quote inside any value
  // it reprints — even a single-quoted one on a tag no gesture touched, so a
  // whole-file save rewrites `style='font-family: "Inter"'`. HTML decodes the
  // entity back in an attribute value, so the two mean the same.
  return typeof value === 'string' ? value.replace(/&quot;/g, '"').replace(/\s+/g, '') : value;
}

/** Plan a gesture's requests the way the host does: each against the bytes
 * the previous one left, rebased from the origin through their splices. */
function engine(file, snapshot, requests) {
  let current = snapshot;
  const log = [];
  for (const [index, edit] of requests.entries()) {
    const draft = buildEditIntent(edit, snapshot);
    if (!draft.ok) {
      return { tag: 'rejected', reason: draft.error };
    }
    let intent = toIntent({
      id: toIntentId(`parity-${index}`),
      file: snapshot.path,
      authoredChecksum: snapshot.checksum,
      ...draft.value,
    });
    if (log.length > 0) {
      const rebased = rebaseIntent(intent, log, current);
      if (!rebased.ok) {
        return { tag: 'rejected', reason: rebased.error };
      }
      intent = rebased.value;
    }
    const planned = planIntent({ authored: current, current }, intent);
    if (!planned.ok) {
      return { tag: 'rejected', reason: planned.error };
    }
    const bytes = applySplices(current.bytes, planned.value.splices);
    const decoded = decodeUtf8(bytes);
    assert.ok(decoded.ok);
    const next = snapshotOf(file, decoded.value);
    log.push({
      from: current.checksum,
      to: next.checksum,
      splices: minimalSplices(planned.value.splices),
    });
    current = next;
  }
  return { tag: 'applied', text: Buffer.from(current.bytes).toString('utf8') };
}

function legacy(text, model, gesture) {
  const printed = serializePage(gesture.apply(structuredClone(model)));
  return text.startsWith(BOM) ? `${BOM}${printed}` : printed;
}

/** Run one gesture family over the corpus; returns the tally. */
function sweep(label, casesFor) {
  const tally = { compared: 0, identical: 0, legacyOnly: 0, refused: new Map() };
  for (const page of pages()) {
    const parsed = parsePage(page.text, { locs: true });
    if (!parsed.editable) {
      continue;
    }
    const model = parsed.model;
    const snapshot = snapshotOf(`/project/${path.basename(page.name)}`, page.text);
    const origin = { checksum: snapshot.checksum, model };
    for (const node of nodesOf(model)) {
      for (const [caseIndex, gesture] of casesFor(node, model).entries()) {
        const requests = gesture.request((id) => edits.nodeRefIn(origin, id));
        if (requests === undefined) {
          tally.legacyOnly += 1;
          continue;
        }
        const where = `${page.name} ${node.id} ${label} #${caseIndex}`;
        const result = engine(snapshot.path, snapshot, requests);
        if (result.tag === 'rejected') {
          tally.refused.set(result.reason, (tally.refused.get(result.reason) ?? 0) + 1);
          continue;
        }
        const reprinted = legacy(page.text, model, gesture);
        const mine = parsePage(result.text, { locs: false });
        const theirs = parsePage(reprinted, { locs: false });
        assert.ok(mine.editable, `${where}: the engine's result parses`);
        assert.ok(theirs.editable, `${where}: the legacy result parses`);
        if (process.env.PARITY_DEBUG && JSON.stringify(meaning(mine.model)) !== JSON.stringify(meaning(theirs.model))) {
          console.log(`--- ${where}\nENGINE\n${result.text}\nLEGACY\n${reprinted}`);
        }
        assert.deepEqual(meaning(mine.model), meaning(theirs.model), `${where}: same page`);
        tally.compared += 1;
        tally.identical += result.text === reprinted ? 1 : 0;
      }
    }
  }
  return tally;
}

function report(context, tally) {
  const refused = [...tally.refused].map(([reason, count]) => `${count} ${reason}`).join(', ');
  context.diagnostic(`${tally.compared} compared, ${tally.identical} byte-identical, ` + `${tally.legacyOnly} legacy-only, refused: ${refused || 'none'}`);
}

const TAGS = new Set(['element', 'component', 'raw']);
const stringProps = (node) => Object.entries(node.props ?? {}).filter(([, value]) => value && value.type === 'string');
const options = { coalesceKey: undefined, urgency: true };

test('parity, attribute: set a new attribute, set and remove each string one', (context) => {
  const tally = sweep('attribute', (node) => {
    if (!TAGS.has(node.kind)) {
      return [];
    }
    return [
      gestures.propsGesture(node.id, { 'data-step': { type: 'string', value: '6' } }, options),
      ...stringProps(node).flatMap(([name]) => [
        gestures.propsGesture(node.id, { [name]: { type: 'string', value: 'x y' } }, options),
        gestures.propsGesture(node.id, { [name]: undefined }, options),
      ]),
      gestures.propsGesture(node.id, { 'data-a': { type: 'string', value: 'a' }, 'data-b': { type: 'string', value: 'b' } }, options),
    ];
  });
  report(context, tally);
  assert.ok(tally.compared > 300, `the sweep compares many real gestures (${tally.compared})`);
});

test('parity, prop: expressions and bare props, new and replacing any value', (context) => {
  const tally = sweep('prop', (node) => {
    if (!TAGS.has(node.kind)) {
      return [];
    }
    const named = Object.entries(node.props ?? {}).filter(([, value]) => value.type !== 'spread');
    return [
      gestures.propsGesture(node.id, { items: { type: 'expr', value: 'list.slice(0, 3)' } }, options),
      gestures.propsGesture(node.id, { hidden: { type: 'bare' } }, options),
      ...named.flatMap(([name]) => [
        gestures.propsGesture(node.id, { [name]: { type: 'expr', value: 'value ?? 1' } }, options),
        gestures.propsGesture(node.id, { [name]: { type: 'bare' } }, options),
        gestures.propsGesture(node.id, { [name]: { type: 'string', value: 'plain' } }, options),
      ]),
    ];
  });
  report(context, tally);
  assert.ok(tally.compared > 500, `the sweep compares many real gestures (${tally.compared})`);
});

// Every node with its parent's id (undefined at the root) and its index there.
function placesOf(model) {
  const found = [];
  const pending = model.nodes.map((node, index) => ({ node, parentId: undefined, index }));
  for (let at = 0; at < pending.length; at++) {
    const entry = pending[at];
    found.push(entry);
    const children = entry.node.children;
    if (Array.isArray(children) && entry.node.kind !== 'chunk-group') {
      children.forEach((child, index) => pending.push({ node: child, parentId: entry.node.id, index }));
    }
  }
  return found;
}

let fresh = 0;
const newNode = (kind) =>
  kind === 'comment'
    ? { id: `x${++fresh}`, kind: 'comment', value: ' Note ' }
    : {
        id: `x${++fresh}`,
        kind: 'element',
        name: 'p',
        props: {},
        children: [{ id: `x${++fresh}`, kind: 'text', value: 'Text' }],
      };

function withNewIds(node) {
  const copy = structuredClone(node);
  const pending = [copy];
  for (let at = 0; at < pending.length; at++) {
    pending[at].id = `d${++fresh}`;
    if (Array.isArray(pending[at].children)) {
      pending.push(...pending[at].children);
    }
  }
  return copy;
}

test('parity, insert and remove: beside, inside, a copy of each node, each removed', (context) => {
  const byNode = new Map();
  const tally = sweep('insert/remove', (node, model) => {
    if (!byNode.has(model)) {
      byNode.set(model, new Map(placesOf(model).map((entry) => [entry.node.id, entry])));
    }
    const entry = byNode.get(model).get(node.id);
    const urgency = { urgency: true };
    const cases = [
      gestures.insertGesture(model, newNode('element'), { parentId: entry.parentId, index: entry.index }, urgency),
      gestures.insertGesture(model, newNode('comment'), { parentId: entry.parentId, index: entry.index + 1 }, urgency),
      gestures.duplicateGesture(node.id, withNewIds(node), urgency),
      gestures.removalGesture([node.id], { apply: (current) => gestures.withoutNodes(current, [node.id]), changesMore: false }, urgency),
    ];
    if ((node.kind === 'element' || node.kind === 'component') && Array.isArray(node.children)) {
      const inside = { parentId: node.id, index: node.children.length };
      cases.push(gestures.insertGesture(model, newNode('element'), inside, urgency));
    }
    return cases;
  });
  report(context, tally);
  assert.ok(tally.compared > 1000, `the sweep compares many real gestures (${tally.compared})`);
});

test('parity, move: every node before the first root, ' + 'after the last, into each element', (context) => {
  const rules = { keepsSlot: () => true };
  const tally = sweep('move', (node, model) => {
    const roots = model.nodes;
    const elements = placesOf(model)
      .map((entry) => entry.node)
      .filter((candidate) => candidate.kind === 'element' && Array.isArray(candidate.children))
      .slice(0, 4);
    const places = [
      { parentId: undefined, index: 0 },
      { parentId: undefined, index: roots.length },
      ...elements.map((parent) => ({ parentId: parent.id, index: parent.children.length })),
    ];
    return places.map((place) => gestures.moveGesture(model, node.id, place, rules, { urgency: true })).filter((gesture) => gesture !== undefined);
  });
  report(context, tally);
  assert.ok(tally.compared > 500, `the sweep compares many real moves (${tally.compared})`);
});

test('parity, inline CSS: one declaration set, changed, added or removed in place', (context) => {
  let inPlace = 0;
  const tally = sweep('inline CSS', (node) => {
    const style = node.props?.style;
    if (style?.type !== 'string') {
      return [];
    }
    const before = style.value;
    const first = before.split(';')[0] ?? '';
    const property = first.split(':')[0]?.trim();
    const afters = [`${before}${before.trim().endsWith(';') || !before.trim() ? '' : ';'} outline: 0`.trim()];
    if (property) {
      afters.push(before.replace(/:[^;]*/, ': 7px'));
      afters.push(before.replace(/^[^;]*;?\s*/, ''));
    }
    return afters.map((after) => {
      const gesture = gestures.inlineStyleGesture(node.id, { before, after }, options);
      const [request] = gesture.request(() => ({ path: [0], kind: 'element', span: { start: 0, end: 1 } })) ?? [];
      inPlace += request?.tag === 'set-inline-style' ? 1 : 0;
      return gesture;
    });
  });
  report(context, tally);
  context.diagnostic(`${inPlace} of them edit one declaration in place`);
  assert.ok(tally.compared >= 15, `the sweep compares every style gesture (${tally.compared})`);
  assert.ok(inPlace >= 10, `most of them in place (${inPlace})`);
});

test('parity, frontmatter: imports added and removed, declarations, with an insert', (context) => {
  const seen = new Set();
  const tally = sweep('frontmatter', (node, model) => {
    if (seen.has(model) || !model.hadFrontmatter) {
      return [];
    }
    seen.add(model); // Once per page: these gestures do not depend on the node.
    const options = { coalesceKey: undefined, urgency: true };
    const card = { name: 'ZCard', path: '../components/ZCard.astro', quote: "'" };
    const addImport = (current) => ({ ...current, imports: [...current.imports, card] });
    const declare = (current) => ({
      ...current,
      extraFrontmatter: [current.extraFrontmatter, 'const added = 1;'].filter(Boolean).join('\n'),
    });
    const cases = [
      gestures.frontmatterGesture(model, options, addImport),
      gestures.frontmatterGesture(model, options, declare),
      gestures.frontmatterGesture(model, options, (current) => declare(addImport(current))),
      ...model.imports.map((imported) =>
        gestures.frontmatterGesture(model, options, (current) => ({
          ...current,
          imports: current.imports.filter((entry) => entry !== imported && entry.name !== imported.name),
        })),
      ),
    ];
    const first = model.nodes.find((candidate) => candidate.kind !== 'text');
    if (first !== undefined) {
      const node = {
        id: 'fm-card',
        kind: 'component',
        name: 'ZCard',
        props: {},
        children: undefined,
      };
      const insert = gestures.insertGesture(model, node, { parentId: undefined, index: model.nodes.indexOf(first) }, options);
      cases.push(gestures.sequence(gestures.frontmatterGesture(model, options, addImport), insert));
    }
    return cases;
  });
  report(context, tally);
  assert.ok(tally.compared > 60, `the sweep compares many frontmatter gestures (${tally.compared})`);
});

test('parity, loop rename: each loop parameter renamed, every reference with it', (context) => {
  const tally = sweep('loop rename', (node, page) => {
    if (node.kind !== 'map') {
      return [];
    }
    const match = /^([\s\S]+?)\.map\(\(\s*([\w$]+)\s*(?:,\s*([\w$]+)\s*)?\)\s*=>\s*\($/.exec(node.head.trim());
    if (match === null) {
      return [];
    }
    const [, data, item, index] = match;
    const head = (nextItem, nextIndex) => `${data}.map((${nextItem}${nextIndex ? `, ${nextIndex}` : ''}) => (`;
    const cases = [gestures.loopRenameGesture(page, node.id, { head: head('renamed', index), renames: [{ from: item, to: 'renamed' }] }, { urgency: true })];
    if (index) {
      cases.push(gestures.loopRenameGesture(page, node.id, { head: head(item, 'position'), renames: [{ from: index, to: 'position' }] }, { urgency: true }));
    }
    return cases.filter((gesture) => gesture !== undefined);
  });
  report(context, tally);
  assert.ok(tally.compared >= 4, `the sweep renames every loop it can read (${tally.compared})`);
});
