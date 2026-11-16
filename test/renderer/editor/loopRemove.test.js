// Goal: setting a loop's Source to None takes the loop away and keeps one copy of
// its body, with everything bound to the loop's item holding the value it showed,
// so no code is left reading a variable that no longer exists. The page's imports
// and frontmatter are never touched by it, and one Undo gives the page back
// byte for byte. A page that fails to render because of an edit (a named import
// that became a default one) is reported with the server's own words.
//
// The root cause of the Stats page error lives here too: pasting a loop carried
// `import { getCollection } from 'astro:content'` over as `import getCollection
// from 'astro:content'`, whose default export does not exist, so every render threw
// `(0, __vite_ssr_import_4__.default) is not a function`.
//
// Method: the real parser and printer read and write generated pages; the removal
// runs through the app's own gesture on the parsed model; the printed result is
// parsed again and every expression in it is checked for the loop's names. Refusals
// and the negative space (raw code reading the item, a nested loop over the item's
// list, spreads, a position name) are each their own case.

const test = require('node:test');
const assert = require('node:assert/strict');
const load = require('../../helpers/rendererModule');
const { parsePage, serializePage } = require('#dist/electron/parse/astroParser.js');

const { removalGesture } = load('src/app/state/appLoopEdits.ts');
const { removedLoopBody, itemSamples, readsLoopItem } = load('src/editor/loopRemove.ts');
const { pasteNeeds, pastedImports } = load('src/app/model/pageGestures.ts');
const { findImportOf } = load('src/editor/dataSource.ts');
const { neededFrontmatter } = load('src/editor/frontmatterMove.ts');
const { extractThrownError } = load('shared/ipc/previewHealth.ts');
const { compileFailureMessage } = load('src/app/model/compileRecovery.ts');

const FRONTMATTER = [
  "import Button from '../components/Button.astro';",
  "import PricingCard from '../components/PricingCard.astro';",
  "import StatWrap from '../components/StatWrap.astro';",
  "import { getCollection } from 'astro:content';",
  "const statsEntries = await getCollection('stats', ({ data }) => data.Number != undefined);",
].join('\n');

const PAGE = `---
${FRONTMATTER}
---
<main>
  <StatWrap>
    {statsEntries.map((item, index) => (
      <div class="stat" data-n={index}>
        <span>{item.data.Number}</span>
        <Button label={item.data.Label} href={item.data.Link} />
        {item.data.Number * 2}
      </div>
    ))}
  </StatWrap>
</main>
`;

const SAMPLES = { 'item.data.Number': '40', 'item.data.Label': 'Customers' };

// The first loop in the tree, found with a bounded walk.
function loopOf(nodes) {
  const pending = [...nodes];
  for (let visited = 0; pending.length > 0 && visited < 1_000; visited++) {
    const node = pending.shift();
    if (node.kind === 'map') {
      return node;
    }
    pending.push(...(node.children ?? []));
  }
  return undefined;
}

// Every piece of code in a printed page that could read the item: text braces, expressions, attributes, tests, heads.
function codeIn(nodes) {
  const found = [];
  const pending = [...nodes];
  for (let visited = 0; pending.length > 0 && visited < 10_000; visited++) {
    const node = pending.shift();
    if (node.kind === 'text') {
      found.push(...[...node.value.matchAll(/\{([^{}]*)\}/g)].map((match) => match[1]));
    } else if (node.kind === 'expr') {
      found.push(node.value);
    } else if (node.kind === 'cond') {
      found.push(node.test);
    } else if (node.kind === 'map') {
      found.push(node.head);
    }
    for (const attr of Object.values(node.props ?? {})) {
      if (attr.type === 'expr' || attr.type === 'spread') {
        found.push(attr.value);
      }
    }
    pending.push(...(node.children ?? []));
  }
  return found;
}

function removed(page, samples = SAMPLES) {
  const model = parsePage(page, { locs: true }).model;
  const loop = loopOf(model.nodes);
  const result = removalGesture(loop, samples);
  return { model, loop, result };
}

test('None removes the loop, keeps one copy of the body, and the bindings hold what they showed', () => {
  const { model, result } = removed(PAGE);
  assert.equal(result.ok, true);
  const after = result.gesture.apply(model);
  const printed = serializePage({ ...after, nodes: after.nodes });
  const expected = `---
${FRONTMATTER}
---
<main>
  <StatWrap>
    <div class="stat" data-n="0">
      <span>40</span>
      <Button label="Customers" href="" />
      {"40" * 2}
    </div>
  </StatWrap>
</main>
`;
  assert.equal(printed, expected);
  assert.deepEqual([result.replaced, result.emptied], [4, 1], 'the position, the number twice, the label; the link had no value');
  // The page parses again, and nothing in it reads the loop's names.
  const again = parsePage(printed, { locs: true }).model;
  assert.equal(loopOf(again.nodes), undefined, 'no loop is left');
  for (const code of codeIn(again.nodes)) {
    assert.equal(readsLoopItem(code, { item: 'item', index: 'index' }), false, code);
  }
});

test('the frontmatter is exactly as it was: named imports stay named, order stays, nothing is deleted', () => {
  const { model, result } = removed(PAGE);
  const printed = serializePage(result.gesture.apply(model));
  const block = (text) => text.split('---')[1];
  assert.equal(block(printed), block(PAGE));
  assert.match(block(printed), /^import \{ getCollection \} from 'astro:content';$/m);
  assert.ok(!/import getCollection from/.test(printed), 'never a default import');
  assert.ok(block(printed).indexOf('import Button') < block(printed).indexOf('const statsEntries'), 'the statement stays below the imports');
  assert.deepEqual(result.gesture.apply(model).imports, model.imports);
  assert.equal(result.gesture.apply(model).extraFrontmatter, model.extraFrontmatter);
});

test('Undo gives the page back byte for byte: the removal builds a new page and never edits the old one', () => {
  const { model, result } = removed(PAGE);
  const before = JSON.stringify(model);
  const after = result.gesture.apply(model);
  assert.notEqual(after, model);
  assert.equal(JSON.stringify(model), before, 'the model it was applied to is untouched');
  assert.equal(serializePage(model), PAGE, 'and prints as the page was');
  // Applying it again to what it made changes nothing: there is no loop left to remove.
  assert.equal(result.gesture.apply(after), after);
});

test('a value with no sample becomes empty and is counted; with none at all the whole body is empty, never broken', () => {
  const { model, result } = removed(PAGE, {});
  const printed = serializePage(result.gesture.apply(model));
  assert.equal(result.replaced, 1, 'only the position is known');
  assert.equal(result.emptied, 4);
  assert.match(printed, /<span><\/span>/);
  assert.match(printed, /label="" href=""/);
  assert.match(printed, /\{undefined \* 2\}/);
  for (const code of codeIn(parsePage(printed).model.nodes)) {
    assert.equal(readsLoopItem(code, { item: 'item', index: 'index' }), false, code);
  }
});

test('code that reads the item and cannot be flattened stops the removal, and nothing is written', () => {
  const page = PAGE.replace('{item.data.Number * 2}', '<script>console.log(item.data.Number)</script>');
  const { loop, result } = removed(page);
  assert.ok(loop, 'the loop is found');
  assert.equal(result.ok, false);
  assert.equal(removedLoopBody(loop.children, { item: 'item', index: 'index' }, SAMPLES).ok, false);
});

test('a nested loop over the item’s own list is emptied and counted; one naming the item again keeps its own', () => {
  const page = `---
${FRONTMATTER}
---
<ul>
  {statsEntries.map((item) => (
    <li>
      {item.data.tags.map((tag) => (<i>{tag}</i>))}
      {other.map((item) => (<b>{item.title}</b>))}
    </li>
  ))}
</ul>
`;
  const { model, result } = removed(page);
  assert.equal(result.ok, true);
  assert.equal(result.emptied, 1);
  const printed = serializePage(result.gesture.apply(model));
  assert.match(printed, /\[\]\.map\(\(tag\) => \(/);
  assert.match(printed, /\{other\.map\(\(item\) => \(/, 'the inner loop’s own item is not ours');
  assert.match(printed, /\{item\.title\}/);
  assert.ok(!/tags/.test(printed), 'the item’s own list is gone from the code');
});

test('a spread of the item is dropped and counted, and attributes that never read it are kept', () => {
  const page = `---
${FRONTMATTER}
---
<div>
  {statsEntries.map((item) => (<a href="/x" {...item.data.attrs} id={other}>{item.data.Label}</a>))}
</div>
`;
  const { model, result } = removed(page, { 'item.data.Label': 'Go' });
  const printed = serializePage(result.gesture.apply(model));
  assert.match(printed, /<a href="\/x" id=\{other\}>Go<\/a>/);
  assert.equal(result.emptied, 1);
});

test('a loop with a head the editor cannot split is not removed', () => {
  const page = `---
${FRONTMATTER}
---
<div>{statsEntries.map(function (item) { return <p>{item.data.Label}</p>; })}</div>
`;
  const model = parsePage(page, { locs: true }).model;
  const loop = loopOf(model.nodes);
  if (loop !== undefined) {
    assert.equal(removalGesture(loop, SAMPLES).ok, false);
  }
  assert.equal(removalGesture({ kind: 'element', id: 'x', name: 'div', props: {}, children: [] }, SAMPLES).ok, false, 'only a loop is removed');
});

test('what the first item shows is read from the data tree, leaf by leaf, from the loop’s own list', () => {
  const leaf = (path, preview) => ({ path, key: path.split('.').pop(), kind: 'text', preview, children: undefined });
  const tree = [
    {
      path: 'statsEntries',
      key: 'statsEntries',
      kind: 'list',
      preview: '2 items',
      children: [
        {
          path: 'statsEntries[0]',
          key: '0',
          kind: 'object',
          preview: '',
          children: [
            {
              path: 'statsEntries[0].data',
              key: 'data',
              kind: 'object',
              preview: '',
              children: [leaf('statsEntries[0].data.Number', '40'), leaf('statsEntries[0].data.Label', 'Customers'), leaf('statsEntries[0].data.Empty', '')],
            },
          ],
        },
        {
          path: 'statsEntries[1]',
          key: '1',
          kind: 'object',
          preview: '',
          children: [{ path: 'statsEntries[1].data', key: 'data', kind: 'object', preview: '', children: [leaf('statsEntries[1].data.Number', '7')] }],
        },
      ],
    },
  ];
  assert.deepEqual(itemSamples(tree, ['nothing', 'statsEntries'], 'item'), { 'item.data.Number': '40', 'item.data.Label': 'Customers' });
  assert.deepEqual(itemSamples(tree, ['missing'], 'item'), {});
  assert.deepEqual(itemSamples(undefined, ['statsEntries'], 'item'), {});
});

test('an expression keeps running over values, and a bare name stays a name', () => {
  const page = `---
${FRONTMATTER}
---
<p>{statsEntries.map((item) => (<b class={item.data.on ? 'a' : 'b'} title={other}>{item.data.on && 'yes'}</b>))}</p>
`;
  const { model, result } = removed(page, { 'item.data.on': 'true' });
  const printed = serializePage(result.gesture.apply(model));
  assert.match(printed, /class=\{"true" \? 'a' : 'b'\}/);
  assert.match(printed, /title=\{other\}/);
  assert.match(printed, /\{"true" && 'yes'\}/);
});

// ---------------------------------------------------------------------------
// The root cause: a pasted loop carried a named import over as a default one.
// ---------------------------------------------------------------------------

test('a named import carried across a paste stays named, and a default one stays a default', async () => {
  const clipImports = [
    { name: 'getCollection', imported: 'getCollection', named: true, path: 'astro:content', quote: "'", at: 161 },
    { name: 'Button', path: '../components/Button.astro', quote: "'", at: 0 },
  ];
  const clip = {
    node: { kind: 'map', id: 'g1', head: 'statsEntries.map((item) => (', children: [] },
    frontmatter: "const statsEntries = await getCollection('stats');",
    imports: clipImports,
    pagePath: undefined,
  };
  const model = { imports: [], extraFrontmatter: '', nodes: [] };
  const needs = await pasteNeeds(clip, model, { insertables: [], resolveImportPath: async () => ({}), currentPath: () => undefined });
  const carried = needs.carriedImports.find((entry) => entry.name === 'getCollection');
  assert.ok(carried, 'the import comes across');
  assert.equal(carried.named, true);
  assert.equal(carried.imported, 'getCollection');
  assert.equal(carried.at, undefined, 'where it sat in the other page means nothing here');
  const pasted = pastedImports(needs)(model);
  const printed = serializePage({ ...pasted, nodes: [], hadFrontmatter: true });
  assert.match(printed, /import \{ getCollection \} from 'astro:content';/);
  assert.ok(!/import getCollection from/.test(printed));
});

test('the dependencies a statement reads keep the way they bind, found in the import list or in the frontmatter text', () => {
  const fromList = neededFrontmatter({
    names: ['getCollection'],
    frontmatter: '',
    imports: [{ name: 'getCollection', imported: 'getCollection', named: true, path: 'astro:content', quote: "'" }],
    has: () => false,
  });
  assert.deepEqual(fromList.imports, [{ name: 'getCollection', path: 'astro:content', imported: 'getCollection', named: true }]);
  const fromText = neededFrontmatter({ names: ['getCollection'], frontmatter: "import { getCollection } from 'astro:content';", has: () => false });
  assert.deepEqual(fromText.imports, [{ name: 'getCollection', path: 'astro:content', imported: 'getCollection', named: true }]);
  assert.deepEqual(findImportOf("import { getCollection as gc } from 'astro:content';", 'gc'), {
    name: 'gc',
    spec: 'astro:content',
    named: true,
    imported: 'getCollection',
  });
  assert.deepEqual(
    findImportOf("import Button from '../Button.astro';", 'Button'),
    { name: 'Button', spec: '../Button.astro' },
    'a default import has no named form',
  );
  assert.equal(findImportOf("import { a } from 'x';", 'b'), undefined);
});

// ---------------------------------------------------------------------------
// Recovery: the page the server could not render says why, and offers Undo.
// ---------------------------------------------------------------------------

test('a server-side TypeError from a bad import is named in the notice, with where it came from', () => {
  const log = [
    '12:01:02 [200] /',
    '12:01:05 [ERROR] TypeError: (0, __vite_ssr_import_4__.default) is not a function',
    '    at /project/src/pages/index.astro:2:1',
    '    at async renderToString',
    '12:01:06 [200] /other',
  ].join('\n');
  const thrown = extractThrownError(log);
  assert.match(thrown, /__vite_ssr_import_4__\.default\) is not a function/);
  const message = compileFailureMessage({ kind: 'server-error', status: 500, thrown, logTail: log });
  assert.match(message, /index\.astro:2:1/);
  assert.equal(compileFailureMessage({ kind: 'ok', status: 200, thrown, logTail: log }), undefined, 'a healthy page says nothing');
});
