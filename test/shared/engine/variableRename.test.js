// Goal: a variable the Loop panel renames is renamed everywhere that means it and
// nowhere that does not, in one write, and anything that would crash the page is
// refused with a reason before a byte is written.
//
// Method: real pages go through main's real parser, with source ranges, as the
// app's origin does. The rename then runs as pure code, and each result is
// compared byte for byte against the page it should be and parsed again. The
// send path runs for real against a stub of main that applies the patch, which
// counts the writes and the undo inverses. Every refusal is pinned by its message.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const load = require('../../helpers/rendererModule');
const { parsePage } = require('#dist/electron/parse/astroParser.js');

const { planVariableRename, checkLoopHead, statementRename, variableNameProblem, renamedFrontmatter, readFile, mentions } =
  load('shared/engine/variableRename.ts');
const { readModuleScope, scopeAt, innerNamesAt } = load('shared/engine/jsScope.ts');
const { predictedRename } = load('src/editor/predictedRename.ts');
const { variableRenameGesture } = load('src/editor/editGestures.ts');
const { sendGesture } = load('src/editor/pageEdits.ts');
const { applyCodePatch } = load('shared/engine/codePatch.ts');

const fileOf = (source) => {
  const parsed = parsePage(source, { locs: true });
  assert.equal(parsed.editable, true, parsed.reason);
  return { source, model: parsed.model };
};

function renamed(source, from, to) {
  const plan = planVariableRename(fileOf(source), { from, to });
  assert.equal(plan.ok, true, plan.message);
  assert.equal(parsePage(plan.text, { locs: true }).editable, true, 'The result is still a page');
  return plan.text;
}

const refusal = (source, from, to) => {
  const plan = planVariableRename(fileOf(source), { from, to });
  assert.equal(plan.ok, false, 'A rename that cannot be safe is refused');
  return plan.message;
};

const page = (frontmatter, template) => `---\n${frontmatter}\n---\n${template}\n`;
const loopOf = (file, kind = 'map') => {
  const pending = [...file.model.nodes];
  for (let index = 0; index < pending.length; index++) {
    const node = pending[index];
    if (node.kind === kind) {
      return node;
    }
    pending.push(...(node.children ?? []));
  }
  throw new Error('The page has a loop');
};
const headCheck = (source, after) => {
  const file = fileOf(source);
  const loop = loopOf(file);
  return checkLoopHead(file, { id: loop.id, before: loop.head, after });
};

const STATS = "const statsEntries2 = await getCollection('stats');";

test('a rename reaches the frontmatter and every kind of template reference', () => {
  const source = page(
    `import { getCollection } from 'astro:content';
${STATS}
const count = statsEntries2.length;
const first = statsEntries2[0];
function total() {
  return statsEntries2.reduce((sum, entry) => sum + entry.value, 0);
}`,
    `<section class={statsEntries2.length > 1 ? 'many' : 'one'} data-json={JSON.stringify(statsEntries2)} {...statsEntries2[0]}>
  <p>{statsEntries2.length} stats</p>
  {statsEntries2.map((item) => (
    <Card a={item} b={statsEntries2.length} />
  ))}
  {statsEntries2.length > 0 ? <b>{statsEntries2[0].title}</b> : <i>none</i>}
  {statsEntries2.length > 0 && (
    <ul>
      {statsEntries2.filter((entry) => entry.on).map((entry) => <li>{entry.title}</li>)}
    </ul>
  )}
  {statsEntries2.map((item) => {
    const label = statsEntries2.indexOf(item);
    return <em>{label}</em>;
  })}
  {[1, 2].map((row) => {
    if (row > 1) {
      return <b>{statsEntries2.length}</b>;
    }
    return <i>{row}</i>;
  })}
  <script define:vars={{ statsEntries2 }}>console.log(statsEntries2);</script>
  <style define:vars={{ size: statsEntries2.length }}>p { width: var(--size); }</style>
</section>`,
  );
  const text = renamed(source, 'statsEntries2', 'stats');
  const expected = source
    .replace('<script define:vars={{ statsEntries2 }}>console.log(statsEntries2);</script>', '@@SCRIPT@@')
    .replaceAll('statsEntries2', 'stats')
    .replace('@@SCRIPT@@', '<script define:vars={{ statsEntries2: stats }}>console.log(statsEntries2);</script>');
  assert.equal(text, expected);
});

test('the bytes around each name are left as they were written', () => {
  const source = page(`const   list   =   [ 1 ,2 ];`, `{  list\n    .slice( 0 , 1 )\n    .map(( item )  =>  (\n      <i>{ item }</i>\n  ))}`);
  assert.equal(renamed(source, 'list', 'rows'), source.replace('list ', 'rows ').replace('list\n', 'rows\n'));
});

test('shadowing locals, keys, members, strings and comments are left alone', () => {
  const frontmatter = `// items is a comment
/* items too */
const items = [{ items: 1 }];
const label = 'items' + "items" + \`items \${items.length}\`;
const nested = { items: 2, deep: { items } };
const member = nested.items;
function shadow(items) {
  return items.length;
}
const arrow = (items) => items;
const block = () => {
  const items = 3;
  return items;
};
const destructured = ({ items }) => items;
for (const items of [[]]) {
  console.log(items);
}
try {
  member();
} catch (items) {
  console.log(items);
}`;
  const template = `<!-- items -->
<p title="items" data-x={'items'}>items and {items.length}</p>
{[[1]].map((items) => <b>{items.length}</b>)}
{nested.items}
{items.map((row) => (
  <i data-a={row.items}>{items.length}</i>
))}
<script>const items = 1; console.log(items);</script>
<style>.items { color: red; }</style>`;
  const expectedFrontmatter = frontmatter
    .replace('const items = [{ items: 1 }];', 'const rows = [{ items: 1 }];')
    .replace('${items.length}', '${rows.length}')
    .replace('deep: { items }', 'deep: { items: rows }');
  const expectedTemplate = template
    .replace('and {items.length}', 'and {rows.length}')
    .replace('{items.map(', '{rows.map(')
    .replace('>{items.length}</i>', '>{rows.length}</i>');
  assert.equal(renamed(page(frontmatter, template), 'items', 'rows'), page(expectedFrontmatter, expectedTemplate));
});

test('a nested loop re-declaring the name shadows everything under it', () => {
  const source = page(
    'const items = [[1]];',
    `{items.map((items) => (
  <ul>
    {items.map((cell) => <li>{cell}{items.length}</li>)}
  </ul>
))}`,
  );
  assert.equal(renamed(source, 'items', 'rows'), source.replace('{items.map((items)', '{rows.map((items)').replace('const items', 'const rows'));
});

test('every way of binding a name in the frontmatter can be renamed', () => {
  const cases = [
    ['function items() { return []; }', 'function rows() { return []; }'],
    ['let items = [];', 'let rows = [];'],
    ['var items = [];', 'var rows = [];'],
    ['const [items] = [[]];', 'const [rows] = [[]];'],
    ['const { a: items } = data();', 'const { a: rows } = data();'],
    ['const { a: { items } } = data();', 'const { a: { items: rows } } = data();'],
    ["import items from './items.json';", "import rows from './items.json';"],
    ["import { items } from './items.js';", "import { items as rows } from './items.js';"],
    ["import { list as items } from './items.js';", "import { list as rows } from './items.js';"],
    ["import * as items from './items.js';", "import * as rows from './items.js';"],
  ];
  for (const [declared, expected] of cases) {
    const text = renamed(page(declared, '{items.map((item) => <i>{item}</i>)}'), 'items', 'rows');
    assert.equal(text, page(expected, '{rows.map((item) => <i>{item}</i>)}'), declared);
  }
});

test('a destructured prop keeps its key and changes only its local name', () => {
  const template = '{items.map((item) => <i>{item}</i>)}';
  const renamedTemplate = '{rows.map((item) => <i>{item}</i>)}';
  const cases = [
    ['const { items } = Astro.props;', 'const { items: rows } = Astro.props;'],
    ['const { items = [] } = Astro.props;', 'const { items: rows = [] } = Astro.props;'],
    ['const { list: items = [] } = Astro.props;', 'const { list: rows = [] } = Astro.props;'],
    ['const { a, ...items } = Astro.props;', 'const { a, ...rows } = Astro.props;'],
  ];
  for (const [declared, expected] of cases) {
    const props = 'interface Props {\n  items?: string[];\n}\n';
    assert.equal(renamed(page(props + declared, template), 'items', 'rows'), page(props + expected, renamedTemplate), declared);
  }
});

test('an attribute written as {name} keeps its attribute name', () => {
  const source = page('const items = [];', '<Card {items} />');
  assert.equal(renamed(source, 'items', 'rows'), page('const rows = [];', '<Card items={rows} />'));
});

test('a backtick attribute is code, and its text is not', () => {
  const source = page('const items = [];', '<div style=`items: ${items.length}` />');
  assert.equal(renamed(source, 'items', 'rows'), page('const rows = [];', '<div style=`items: ${rows.length}` />'));
});

test('a new name that already exists is refused, whatever provides it', () => {
  const base = "import Card from './Card.astro';\nconst items = [];\nconst other = [];\nfunction helper() {}\nconst { prop } = Astro.props;";
  const source = page(base, '{items.map((item) => <i>{item}</i>)}');
  for (const name of ['Card', 'other', 'helper', 'prop', 'Astro', 'Math', 'JSON']) {
    assert.equal(refusal(source, 'items', name), `“${name}” already exists in this file.`, name);
  }
});

test('a name read as a global is taken, since a binding would start answering it', () => {
  const source = page('const items = [];', '{items.map((item) => <i>{item}{mystery}</i>)}');
  assert.equal(refusal(source, 'items', 'mystery'), '“mystery” already exists in this file.');
});

test('a new name an inner binding would capture is refused', () => {
  const cases = [
    page('const items = [];\nconst f = (rows) => items.length + rows;', '<p/>'),
    page('const items = [];', '{[1].map((rows) => <i>{items.length}{rows}</i>)}'),
    page('const items = [];', '{[1].map((n) => { const rows = n; return <i>{items.length}{rows}</i>; })}'),
    page('const items = [];', '{items.map((rows) => <i data-a={items.length}>{rows}</i>)}'),
  ];
  for (const source of cases) {
    assert.equal(
      refusal(source, 'items', 'rows'),
      '“rows” is already a name inside a loop or function that reads “items”, so it would read that instead.',
      source,
    );
  }
});

test('an inner binding of the new name is fine where the old one is not read under it', () => {
  const source = page('const items = [];', '{items.map((rows) => <i>{rows}</i>)}\n<p>{items.length}</p>');
  assert.equal(renamed(source, 'items', 'rows'), page('const rows = [];', '{rows.map((rows) => <i>{rows}</i>)}\n<p>{rows.length}</p>'));
});

test('reserved words and invalid identifiers are refused', () => {
  const source = page('const items = [];', '{items.map((item) => <i>{item}</i>)}');
  for (const word of ['class', 'await', 'null', 'enum', 'yield', 'let', 'static']) {
    assert.equal(variableNameProblem(word), `“${word}” is a reserved word in JavaScript. Pick another name.`, word);
    assert.equal(refusal(source, 'items', word), `“${word}” is a reserved word in JavaScript. Pick another name.`, word);
  }
  for (const name of ['2stats', 'my-list', 'my list', '']) {
    assert.match(refusal(source, 'items', name), /isn’t a valid variable name/, name);
  }
  for (const name of ['stats', '$stats', '_stats', 'état', 'stats2']) {
    assert.equal(variableNameProblem(name), undefined, name);
  }
});

test('a name the file does not bind has nothing to rename', () => {
  assert.match(refusal(page('const a = 1;', '<p/>'), 'items', 'rows'), /isn’t declared in this file’s frontmatter/);
});

test('what cannot be renamed safely says why instead of leaving a dangling read', () => {
  const template = '{items.map((item) => <i>{item}</i>)}';
  assert.match(refusal(page('export const items = [];', template), 'items', 'rows'), /is exported/);
  assert.match(refusal(page('const items = [];\nexport { items };', template), 'items', 'rows'), /is exported/);
  assert.match(refusal(page('const Items = [];', '<Items />'), 'Items', 'Rows'), /used as a tag/);
  assert.match(refusal(page('const items = [;', template), 'items', 'rows'), /syntax error/);
  // An HTML comment is markup the JavaScript reader has no form for.
  const unreadable = page('const items = [];', '{items.length > 0 ? other(<a><!-- x --></a>, items) : null}');
  assert.match(refusal(unreadable, 'items', 'rows'), /can’t be read to rename it safely/);
});

test('the same code without the name in it is no reason to refuse', () => {
  const source = page('const items = [];', '{other(<a><!-- x --></a>)}\n<p>{items.length}</p>');
  assert.equal(renamed(source, 'items', 'rows'), page('const rows = [];', '{other(<a><!-- x --></a>)}\n<p>{rows.length}</p>'));
});

const LOOPED = page(`${STATS}\nconst other = [];\nconst { prop } = Astro.props;`, '{statsEntries2.map((item) => <i>{item}</i>)}');

test('the head is a rename when only the source name changed', () => {
  assert.deepEqual(headCheck(LOOPED, 'stats.map((item) => ('), { kind: 'rename', rename: { from: 'statsEntries2', to: 'stats' } });
});

test('a name read twice in the head is renamed with the rest of the file', () => {
  const source = page('const list = [];', '{list.filter((row) => list.includes(row)).map((item) => <i>{item}</i>)}');
  assert.deepEqual(headCheck(source, 'rows.filter((row) => list.includes(row)).map((item) => ('), { kind: 'rename', rename: { from: 'list', to: 'rows' } });
  assert.equal(renamed(source, 'list', 'rows'), source.replaceAll('list', 'rows'));
});

test('a name inside the head’s expression is found as well as one at its front', () => {
  const source = page('const list = [];', '{Object.values(list).map((item) => <i>{item}</i>)}');
  assert.deepEqual(headCheck(source, 'Object.values(rows).map((item) => ('), { kind: 'rename', rename: { from: 'list', to: 'rows' } });
});

test('naming an existing list in the head is refused, and points at the Source menu', () => {
  const check = headCheck(LOOPED, 'other.map((item) => (');
  assert.deepEqual(check, { kind: 'problem', message: '“other” already exists in this file. To loop over it, choose it in the Source menu.' });
});

test('an outer loop’s item is a name that exists in that scope', () => {
  const source = page('const groups = [];\nconst list = [];', '{groups.map((group) => (\n  <ul>{list.map((item) => <i>{item}</i>)}</ul>\n))}');
  const file = fileOf(source);
  const inner = loopOf(file).children[0].children[0];
  assert.equal(inner.kind, 'map');
  const check = checkLoopHead(file, { id: inner.id, before: inner.head, after: 'group.map((item) => (' });
  assert.deepEqual(check, { kind: 'problem', message: '“group” already exists in this file. To loop over it, choose it in the Source menu.' });
});

test('an outer loop’s item in a head is that loop’s, so editing past it is an ordinary edit', () => {
  const source = page('const groups = [];', '{groups.map((group) => (\n  <ul>{group.rows.map((item) => <i>{item}</i>)}</ul>\n))}');
  const file = fileOf(source);
  const inner = loopOf(file).children[0].children[0];
  assert.deepEqual(checkLoopHead(file, { id: inner.id, before: inner.head, after: 'group.cells.map((item) => (' }), { kind: 'edit' });
  assert.deepEqual(checkLoopHead(file, { id: inner.id, before: inner.head, after: 'groups.map((item) => (' }), { kind: 'edit' });
  assert.equal(checkLoopHead(file, { id: inner.id, before: inner.head, after: 'nothing.map((item) => (' }).kind, 'problem');
});

test('a head reading an undeclared name would crash the page, and is refused', () => {
  const prop = page('const { list } = Astro.props;', '{Astro.props.list.map((item) => <i>{item}</i>)}');
  assert.equal(headCheck(prop, 'list.map((item) => (').kind, 'edit');
  const check = headCheck(LOOPED, 'statsEntries2.filter((row) => missing(row)).map((item) => (');
  assert.deepEqual(check, {
    kind: 'problem',
    message: '“missing” isn’t declared in this file, so the page would crash. Declare it in the frontmatter, or choose a list in the Source menu.',
  });
});

test('reading what is already declared or global is an ordinary edit', () => {
  for (const after of [
    'statsEntries2.slice(0, 3).map((item) => (',
    'Object.keys(prop).map((item) => (',
    'statsEntries2.map((item, index) => (',
    'statsEntries2.map((row) => (',
  ]) {
    assert.deepEqual(headCheck(LOOPED, after), { kind: 'edit' }, after);
  }
});

test('an undeclared name the head already read is not news', () => {
  const source = page('const a = 1;', '{legacy.map((item) => <i>{item}</i>)}');
  assert.deepEqual(headCheck(source, 'legacy.slice(1).map((item) => ('), { kind: 'edit' });
});

test('a head that does not parse is refused, with reserved words and bad names named', () => {
  const message = 'This code doesn’t parse. A loop reads like items.map((item) => (.';
  for (const after of ['statsEntries2.map((item) => ', 'statsEntries2.map((item => (', 'statsEntries2..map((item) => (', '']) {
    assert.deepEqual(headCheck(LOOPED, after), { kind: 'problem', message }, after);
  }
  assert.match(headCheck(LOOPED, 'class.map((item) => (').message, /reserved word/);
  assert.match(headCheck(LOOPED, '2stats.map((item) => (').message, /isn’t a valid variable name/);
  assert.match(headCheck(LOOPED, 'my-stats.map((item) => (').message, /isn’t a valid variable name/);
});

test('a function callback and a block body are heads like any other', () => {
  const source = page('const items = [];', '{items.map(function (item) { return <i>{item}</i>; })}');
  const file = fileOf(source);
  const loop = loopOf(file);
  assert.deepEqual(checkLoopHead(file, { id: loop.id, before: loop.head, after: loop.head.replace('items', 'rows') }), {
    kind: 'rename',
    rename: { from: 'items', to: 'rows' },
  });
});

test('Markdown pages keep the edit they had', () => {
  const file = { source: '', model: { nodes: [], format: 'mdx', hadFrontmatter: false } };
  assert.deepEqual(checkLoopHead(file, { id: 'n0', before: 'a.map((b) => (', after: 'c.map((b) => (' }), { kind: 'edit' });
});

test('a loop the file does not hold yet is not judged against it', () => {
  const file = fileOf(page('const a = 1;', '<p/>'));
  assert.deepEqual(checkLoopHead(file, { id: 'n99', before: 'a.map((b) => (', after: 'outerItem.map((b) => (' }), { kind: 'edit' });
});

test('a statement tells a rename from a change to the rest of the line', () => {
  const before = "const stats = await getCollection('stats');";
  assert.deepEqual(statementRename('stats', before, "const rows = await getCollection('stats');"), { kind: 'rename', to: 'rows' });
  assert.deepEqual(statementRename('stats', before, "const stats = await getCollection('other');"), { kind: 'same' });
  assert.deepEqual(statementRename('stats', before, "let stats = await getCollection('stats');"), { kind: 'same' });
  assert.deepEqual(statementRename('stats', before, "const rows = await getCollection('other');"), { kind: 'mixed' });
  assert.deepEqual(statementRename('stats', before, ''), { kind: 'same' });
});

test('a rename is one write and one undo step, and undoing it restores the file', async () => {
  const source = page(`${STATS}\nconst n = statsEntries2.length;`, '<p>{statsEntries2.length}</p>\n{statsEntries2.map((item) => <i>{item}</i>)}');
  const file = fileOf(source);
  const rename = { from: 'statsEntries2', to: 'stats' };
  const plan = planVariableRename(file, rename);
  const gesture = variableRenameGesture(file, rename, plan.hunks);
  const requests = [];
  let bytes = source;
  const record = { outcome: { tag: 'pending', waiting: 1, applied: [] } };
  const send = async (request) => {
    requests.push(request);
    assert.equal(request.edit.tag, 'code-patch');
    const before = bytes;
    bytes = applyCodePatch(bytes, request.edit.hunks);
    return { ok: true, value: { checksum: 'c'.repeat(64), source: bytes, inverse: [{ before }] } };
  };
  const origin = { checksum: 'a'.repeat(64), source, model: file.model };
  const sent = await sendGesture({ path: 'src/pages/index.astro', origin, gesture, record, send });
  assert.equal(sent.tag, 'applied');
  assert.equal(requests.length, 1, 'One request, however many places read the name');
  assert.equal(sent.replies.length, 1);
  assert.equal(record.outcome.tag, 'applied');
  assert.equal(record.outcome.applied.length, 1, 'One write for Undo to take back');
  assert.equal(bytes, plan.text);
  assert.equal(record.outcome.applied[0].inverse[0].before, source);
});

test('a rename sent after the file moved is stated against the bytes it reaches', () => {
  const source = page('const items = [];', '<p>{items.length}</p>');
  const file = fileOf(source);
  const rename = { from: 'items', to: 'rows' };
  const gesture = variableRenameGesture(file, rename, planVariableRename(file, rename).hunks);
  const moved = fileOf(page('const items = [];', '<p>{items.length}</p>\n<i>{items[0]}</i>'));
  const [edit] = gesture.request(() => undefined, moved);
  assert.equal(applyCodePatch(moved.source, edit.hunks), page('const rows = [];', '<p>{rows.length}</p>\n<i>{rows[0]}</i>'));
});

test('the model shown until the reply reads the new name', () => {
  const { model } = fileOf(page("import { items } from './a.js';\nconst n = items.length;", '{items.map((item) => <i>{item}</i>)}'));
  const shown = predictedRename(model, { from: 'items', to: 'rows' });
  assert.equal(shown.extraFrontmatter, 'const n = rows.length;');
  assert.deepEqual(
    shown.imports.map((entry) => [entry.name, entry.imported]),
    [['rows', 'items']],
  );
  assert.equal(shown.nodes[0].head, 'rows.map((item) => (');
  assert.equal(model.nodes[0].head, 'items.map((item) => (', 'The shown model is left as it was');
});

test('the invariants the rename relies on crash loudly when broken, each with its own message', () => {
  const failure = (message) => new RegExp(`^Error: Assertion failed: ${message}$`);
  const analysis = readModuleScope('const items = [];');
  assert.throws(() => scopeAt(analysis, analysis.root.to), failure('A position lies before the end of the code it was read from'));
  assert.throws(() => innerNamesAt(analysis, { ...analysis.root, to: analysis.root.to + 1 }), failure('A scope ends inside its parent'));
  assert.throws(() => innerNamesAt(analysis, { ...analysis.root, from: -1 }), failure('A scope starts inside its parent'));
  assert.throws(() => renamedFrontmatter('const items = [];', { from: 'items', to: 'items' }), failure('A rename changes the name'));
  const file = fileOf(page('const items = [];', '<p>{items.length}</p>'));
  assert.throws(
    () => checkLoopHead(file, { id: '', before: 'items.map((item) => (', after: 'rows.map((item) => (' }),
    failure('A loop head belongs to a node'),
  );
  // A model that does not belong to these bytes is a bug in the caller, never a user's input.
  const short = file.source.slice(0, file.model.bodyStart + 2);
  assert.throws(() => readFile({ source: short, model: file.model }), /Assertion failed: A (code range|tag|masked region)/);
});

test('an empty name, which broken code can yield, stands nowhere and ends the search', () => {
  assert.equal(mentions('items', ''), false);
  assert.equal(mentions('items', 'items'), true);
});
