// Goal: a list prop written as a multi-line array literal, the way Prettier
// splits one (one item per line, a trailing comma), is edited from Settings
// and every change reaches the file: reorder, edit, add and remove, and a
// plain string prop on the same instance beside it. The instance mirrors the
// marketing site's `<Chips data-enter items={[...]} />`: a component with a
// bare attribute before the list, self-closing, attributes on their own lines.
// Method: the list field's own value helpers (src/features/props/arrayValue.ts)
// turn the literal into items and back, exactly as ListField.tsx does for each
// change; propsGesture (src/editor/editGestures.ts) states the write; main's real
// handlers, in the windowless harness, plan and apply it on a temporary project.
// Each step is checked against the bytes written and against the page read back,
// so a write that never landed, or landed somewhere else, fails here. The
// literal is rewritten on one line: the field writes the array it shows, and
// the project's formatter may split it again.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');
const { parsePageDiskRead, parsePageEditResult } = require('#dist/shared/ipc/pageSave.js');
const { repoPath } = require('../../helpers/sources.js');

const buildDirectory = repoPath('node_modules/.stacki-test/list-prop-write');
fs.mkdirSync(buildDirectory, { recursive: true });
esbuild.buildSync({
  entryPoints: {
    pageEdits: repoPath('src/editor/pageEdits.ts'),
    editGestures: repoPath('src/editor/editGestures.ts'),
    arrayValue: repoPath('src/features/props/arrayValue.ts'),
  },
  outdir: buildDirectory,
  bundle: true,
  format: 'cjs',
  platform: 'node',
  logLevel: 'silent',
});
const edits = require(path.join(buildDirectory, 'pageEdits.js'));
const gestures = require(path.join(buildDirectory, 'editGestures.js'));
const arrayValue = require(path.join(buildDirectory, 'arrayValue.js'));

const PAGE = [
  '---',
  'import Chips from "../components/Chips.astro";',
  '---',
  '<main>',
  '  <section>',
  '    <Chips',
  '      data-enter',
  '      items={[',
  '        "Free and open source",',
  '        "Edit any Astro site",',
  '        "Easy to customize",',
  '      ]}',
  '    />',
  '  </section>',
  '</main>',
  '',
].join('\n');

const COMPONENT = [
  '---',
  'interface Props {',
  '  items?: readonly string[];',
  '  marginTop?: "default" | "7";',
  '}',
  'const { items = ["Short fact"], marginTop = "default" } = Astro.props;',
  '---',
  '<ul class:list={["chips", marginTop !== "default" && `margin-top-${marginTop}`]}>{items.map((item) => <li>{item}</li>)}</ul>',
  '',
].join('\n');

// The page tree is at most a few levels deep; the walk stops well past it.
const WALK_NODES_MAX = 1_000;

/** The first node named `name`, breadth first, within WALK_NODES_MAX nodes. */
function nodeNamed(nodes, name) {
  const queue = [...nodes];
  for (let index = 0; index < queue.length; index++) {
    assert.ok(index < WALK_NODES_MAX, 'the walk stays within its bound');
    const node = queue[index];
    if (node.name === name) {
      return node;
    }
    queue.push(...(node.children ?? []));
  }
  return undefined;
}

/** The Chips instance's attribute text, as the file now holds it. */
function chipsText(file) {
  const text = fs.readFileSync(file, 'utf8');
  const start = text.indexOf('<Chips');
  const end = text.indexOf('/>', start);
  assert.ok(start >= 0, 'the instance is still in the file');
  assert.ok(end > start, 'the instance still closes itself');
  return text.slice(start, end + 2);
}

async function projectWithChips(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-list-prop-'));
  fs.mkdirSync(path.join(root, 'src/pages'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src/components'), { recursive: true });
  fs.mkdirSync(path.join(root, 'user'));
  fs.writeFileSync(path.join(root, 'package.json'), '{"dependencies":{"astro":"*"}}');
  fs.writeFileSync(path.join(root, 'src/components/Chips.astro'), COMPONENT);
  const file = path.join(root, 'src/pages/index.astro');
  fs.writeFileSync(file, PAGE);
  const { mainHarness } = await import('../../helpers/mainHarness.ts');
  const harness = mainHarness(path.join(root, 'user'));
  context.after(() => {
    harness.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { harness, file };
}

/** Sets one prop of the Chips instance as Settings does, against the page as read now. */
async function setChipsProp(harness, file, name, value) {
  const read = parsePageDiskRead(await harness.invoke('page:read', file));
  assert.ok(read.editable, 'the page is editable');
  const chips = nodeNamed(read.model.nodes, 'Chips');
  assert.ok(chips !== undefined, 'the instance is in the page tree');
  const origin = { checksum: read.checksum, source: read.source, model: read.model };
  const gesture = gestures.propsGesture(chips.id, { [name]: value }, { coalesceKey: undefined, urgency: true });
  const send = async (request) => parsePageEditResult(await harness.invoke('page:edit', request));
  const record = { outcome: { tag: 'applied', applied: [] } };
  const outcome = await edits.sendGesture({ path: file, origin, gesture, record, send });
  assert.equal(outcome.tag, 'applied', `${name}: the write lands`);
  return chips;
}

/** The list's items, as the list field reads them from the page's current value. */
async function chipsItems(harness, file) {
  const read = parsePageDiskRead(await harness.invoke('page:read', file));
  const chips = nodeNamed(read.model.nodes, 'Chips');
  assert.ok(chips !== undefined, 'the instance is in the page tree');
  const value = chips.props.items;
  assert.equal(value?.type, 'expr', 'the list is an expression prop');
  const items = arrayValue.arrayItems(value.value);
  assert.ok(items !== undefined, 'the list field can show the literal');
  return items;
}

const labels = (items) => items.map((item) => arrayValue.itemLabel(item));

test('the list field reads a multi-line literal with a trailing comma as its items', () => {
  const literal = '[\n  "Free and open source",\n  "Edit any Astro site",\n  "Easy to customize",\n]';
  const items = arrayValue.arrayItems(literal);
  assert.deepEqual(labels(items), ['Free and open source', 'Edit any Astro site', 'Easy to customize']);
  assert.equal(arrayValue.arrayText(items), '["Free and open source", "Edit any Astro site", "Easy to customize"]');
  assert.equal(arrayValue.arrayItems('[\n  "a",\n  ,\n]'), undefined, 'a hole before the trailing comma is not a list');
});

test('reorder, edit, add and remove on a multi-line list prop all write the file', async (context) => {
  const { harness, file } = await projectWithChips(context);

  // Reorder: "Easy to customize" dragged to the top (row 2 into gap 0).
  const original = await chipsItems(harness, file);
  assert.equal(original.length, 3);
  const moved = arrayValue.moveItem(original, 2, 0);
  await setChipsProp(harness, file, 'items', { type: 'expr', value: arrayValue.arrayText(moved) });
  assert.equal(chipsText(file), '<Chips\n      data-enter\n      items={["Easy to customize", "Free and open source", "Edit any Astro site"]}\n    />');
  assert.deepEqual(labels(await chipsItems(harness, file)), ['Easy to customize', 'Free and open source', 'Edit any Astro site']);

  // Edit: the second row's words.
  const beforeEdit = await chipsItems(harness, file);
  const edited = beforeEdit.map((item, index) => (index === 1 ? { ...item, text: 'Free and "open" source' } : item));
  await setChipsProp(harness, file, 'items', { type: 'expr', value: arrayValue.arrayText(edited) });
  assert.deepEqual(labels(await chipsItems(harness, file)), ['Easy to customize', 'Free and "open" source', 'Edit any Astro site']);
  assert.match(chipsText(file), /"Free and \\"open\\" source"/, 'a quote inside an item is escaped, not ended');

  // Add: a new last row, shaped like the others.
  const beforeAdd = await chipsItems(harness, file);
  const added = [...beforeAdd, { ...arrayValue.blankLike(beforeAdd), text: 'Works offline' }];
  await setChipsProp(harness, file, 'items', { type: 'expr', value: arrayValue.arrayText(added) });
  assert.deepEqual(labels(await chipsItems(harness, file)), ['Easy to customize', 'Free and "open" source', 'Edit any Astro site', 'Works offline']);

  // Remove: the first row.
  const beforeRemove = await chipsItems(harness, file);
  const removed = beforeRemove.filter((_, index) => index !== 0);
  await setChipsProp(harness, file, 'items', { type: 'expr', value: arrayValue.arrayText(removed) });
  assert.deepEqual(labels(await chipsItems(harness, file)), ['Free and "open" source', 'Edit any Astro site', 'Works offline']);

  const text = fs.readFileSync(file, 'utf8');
  assert.ok(
    text.startsWith('---\nimport Chips from "../components/Chips.astro";\n---\n<main>\n  <section>\n    <Chips\n      data-enter\n'),
    'nothing above the list moved',
  );
  assert.ok(text.endsWith('\n    />\n  </section>\n</main>\n'), 'nothing below the list moved');
});

test('a string prop on the same multi-line instance writes beside the list', async (context) => {
  const { harness, file } = await projectWithChips(context);
  await setChipsProp(harness, file, 'marginTop', { type: 'string', value: '7' });
  assert.equal(
    chipsText(file),
    '<Chips\n      data-enter\n      items={[\n        "Free and open source",\n        "Edit any Astro site",\n        "Easy to customize",\n      ]}\n      marginTop="7"\n    />',
    'the new prop goes last, on its own line, and the literal keeps its lines',
  );
  await setChipsProp(harness, file, 'marginTop', { type: 'string', value: 'default' });
  assert.match(chipsText(file), /\n {6}marginTop="default"\n/, 'a set string prop changes in place');
  await setChipsProp(harness, file, 'marginTop', undefined);
  assert.doesNotMatch(chipsText(file), /marginTop/, 'reset removes it');
  assert.deepEqual(labels(await chipsItems(harness, file)), ['Free and open source', 'Edit any Astro site', 'Easy to customize'], 'the list is untouched');
});
