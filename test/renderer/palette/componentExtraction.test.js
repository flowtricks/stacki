// Goal: creating a component from the selection keeps the page's styles on
// the markup it moved, and is one undo step.
//
// Two bugs this holds shut. First, the moved markup lost its styles: the page's
// `<style>` is scoped to the page (Astro adds the page's `data-astro-cid-…` to
// every selector), the component's elements carry the component's attribute,
// and a `<a class="button">` styled by the page's `.button { & > span }` came
// out a plain underlined link. The page's CSS is the page's and has to keep
// reaching that markup; nothing is copied into the component. Second, ⌘Z put
// the markup back but left src/components/Button.astro and its Components
// panel entry behind.
//
// Method: the real modules, bundled with esbuild, on a temporary project, with
// main's real handlers in the windowless harness. A page styled like the
// reported one (nested `&` rules, a media query, an ancestor left on the page,
// a global block) is turned into a component the way useCreateComponent does it:
// componentStyles, component:create, then the style and extraction gestures as
// one request. The rewritten selectors are checked as text; then both pages
// are run through Astro's own compiler and its CSS matched in jsdom against the
// page as Astro renders it, before (every element with the page's scope) and
// after (the moved markup with the component's): every element must be matched
// by the same rules, and every element left on the page at the same
// specificity. The Style panel's own source scan, file reads and cascade are
// asked, with the component open on that page, whether `.button` styles its
// `<a>` and where an edit to it goes. Then undo and redo run through
// stepWithFiles, the function appHistory.ts's stepEdits uses, with the page
// reverted by main exactly as revertedSteps does.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');
const { parsePageDiskRead, parsePageEditResult } = require('#dist/shared/ipc/pageSave.js');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const buildDirectory = repoPath('node_modules/.stacki-test/component-extraction');
fs.mkdirSync(buildDirectory, { recursive: true });
const bundle = path.join(buildDirectory, 'component-extraction.bundle.js');
esbuild.buildSync({
  stdin: {
    contents: [
      "export { componentStyles } from './src/app/model/componentStyles';",
      "export { createdComponentFiles, stepWithFiles } from './src/app/model/componentCreation';",
      "export { extractionGesture, styleBlockGestures } from './src/app/model/pageGestures';",
      "export { sequence } from './src/editor/editGestures';",
      "export { sendGesture } from './src/editor/pageEdits';",
      "export { parseRegion } from './src/features/style/model/cssRegions';",
      "export { collectRules } from './src/features/style/model/css';",
      "export { computeRuleModel } from './src/features/style/model/cascade';",
      "export { setHost, getHost } from './src/features/style/model/host';",
      "export { scanAllComponents, loadEmbedDocs, rebuildRules, writeEmbedDocument } from './src/features/style/model/webflow';",
      "export { compileSelectorList } from './src/features/style/model/selectorParse';",
    ].join('\n'),
    resolveDir: ROOT,
    loader: 'ts',
  },
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'silent',
});
const modules = require(bundle);

// The reported page, reduced: the hero's button turned into a component, its
// sibling still on the page.
const PAGE = `---
---
<html lang="en">
  <head>
    <style>
    :root {
      --brand: blue;
    }
    body {
      margin: 0;
    }
    a {
      text-decoration: none;
    }
    .button {
      background-color: var(--brand);
      & > span {
        border-radius: 100vw;
      }
      &:hover > span {
        transform: rotate(-45deg);
      }
      &.secondary {
        background-color: white;
      }
    }
    .cta-label {
      font-weight: 700;
    }
    .hero .cta-note {
      color: red;
    }
    @media (width < 50rem) {
      .button {
        width: 100%;
      }
      .footer {
        padding: 0;
      }
    }
    .unused {
      color: green;
    }
    </style>
    <style is:global>
    .button { outline: none; }
    </style>
  </head>
  <body>
    <section class="hero">
      <a href="#" class="button">Start <span class="cta-label">→</span><em class="cta-note">!</em></a>
      <a href="#" class="button secondary">Meet <span>↗</span></a>
    </section>
    <footer class="footer"></footer>
  </body>
</html>
`;

async function project(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-component-extraction-'));
  fs.mkdirSync(path.join(root, 'src/pages'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src/components'), { recursive: true });
  fs.mkdirSync(path.join(root, 'user'));
  fs.writeFileSync(path.join(root, 'package.json'), '{"dependencies":{"astro":"*"}}');
  const { mainHarness } = await import('../../helpers/mainHarness.ts');
  const harness = mainHarness(path.join(root, 'user'));
  context.after(() => {
    harness.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const pagePath = path.join(root, 'src/pages/index.astro');
  fs.writeFileSync(pagePath, PAGE);
  return { root, harness, pagePath };
}

// Every node of a tree with where it sits, walked without recursion.
function placed(nodes) {
  const out = [];
  const pending = nodes.map((node, index) => ({ node, parentId: undefined, index }));
  while (pending.length > 0) {
    const next = pending.shift();
    out.push(next);
    (next.node.children ?? []).forEach((child, index) => pending.push({ node: child, parentId: next.node.id, index }));
  }
  return out;
}

const findNode = (nodes, wanted) => placed(nodes).find((entry) => wanted(entry.node))?.node;

const isHeroButton = (node) => node.kind === 'element' && node.name === 'a' && node.props?.class?.value === 'button';

// What useCreateComponent does, step for step, against main's real handlers.
async function createButton({ root, harness, pagePath }) {
  const read = parsePageDiskRead(await harness.invoke('page:read', pagePath));
  assert.ok(read.editable);
  const model = read.model;
  const node = findNode(model.nodes, isHeroButton);
  assert.ok(node, 'the hero button is in the page');
  const styles = modules.componentStyles(model, node.id);
  const input = { projectPath: root, pagePath, name: 'Button', nodes: [node], imports: model.imports, props: [] };
  const created = await harness.invoke('component:create', input);
  const paths = await harness.invoke('page:importPathFor', { pagePath, targetPath: created.path, projectPath: root });
  const extracted = { id: 'g' + '0'.repeat(32), name: 'Button', props: [], place: placeOf(model.nodes, node.id), paths };
  const extraction = modules.extractionGesture(model, node.id, extracted);
  const restyled = modules.styleBlockGestures(model, styles.pageBlocks);
  const gesture = restyled === undefined ? extraction : modules.sequence(restyled, extraction);
  // As the queue leaves a step when it takes the gesture: one write owed.
  const record = { outcome: { tag: 'pending', waiting: 1, applied: [] } };
  const send = async (request) => parsePageEditResult(await harness.invoke('page:edit', request));
  const origin = { checksum: read.checksum, source: read.source, model };
  const outcome = await modules.sendGesture({ path: pagePath, origin, gesture, record, send });
  assert.equal(outcome.tag, 'applied', 'the page took the edit');
  assert.equal(record.outcome.tag, 'applied');
  assert.equal(record.outcome.applied.length, outcome.replies.length, 'every write left its inverse in the one step');
  return { created, input, styles, record, send };
}

function placeOf(nodes, id) {
  const entry = placed(nodes).find((candidate) => candidate.node.id === id);
  return entry === undefined ? undefined : { parentId: entry.parentId, index: entry.index };
}

// The inverses of `applied`, newest first, as revertedSteps sends them; the
// inverses of those writes, for the other direction.
async function reverted(send, pagePath, applied) {
  const done = [];
  for (const step of [...applied].reverse()) {
    if (step.inverse.length === 0) {
      continue;
    }
    const answer = await send({ pagePath, authoredChecksum: step.checksum, edit: { tag: 'revert', hunks: step.inverse } });
    assert.ok(answer.ok, 'main reverted the write');
    done.push({ checksum: answer.value.checksum, inverse: answer.value.inverse });
  }
  return done;
}

// ── 1. The page's styles keep reaching the moved markup ─────────────────────

test('the selectors that matched the moved markup are opened with :global(), and nothing else changes', async (context) => {
  const setup = await project(context);
  const { created } = await createButton(setup);
  const component = fs.readFileSync(created.path, 'utf8');
  const page = fs.readFileSync(setup.pagePath, 'utf8');

  assert.ok(component.includes('<a href="#" class="button">'), 'the markup moved');
  assert.ok(!component.includes('<style'), 'and no CSS was copied into the component');
  assert.ok(page.includes('<Button />'), 'the page holds the instance');
  assert.match(page, /import Button from '\.\.\/components\/Button\.astro'/, 'and imports it');

  const opened = [
    '    a, :global(a) {',
    '    .button, :global(.button) {',
    '      & > span, & > :global(span) {',
    '      &:hover > span, &:hover > :global(span) {',
    '    .cta-label, :global(.cta-label) {',
    '    .hero .cta-note, .hero :global(.cta-note) {',
    '      .button, :global(.button) {',
  ];
  for (const line of opened) {
    assert.ok(page.includes(`${line}\n`), `opened: ${line.trim()}`);
  }
  // Only the selector lines changed: everything else is byte for byte as written.
  const before = new Set(PAGE.split('\n'));
  const changed = page.split('\n').filter((line) => !before.has(line) && /\{$/.test(line));
  assert.equal(changed.length, opened.length, `only the opened selectors changed: ${JSON.stringify(changed)}`);
  for (const kept of ['      &.secondary {', '      .footer {', '    :root {', '    body {', '    .unused {']) {
    assert.ok(page.includes(`${kept}\n`), `left as written: ${kept.trim()}`);
  }
  assert.ok(page.includes('<style is:global>\n    .button { outline: none; }'), 'a global block is untouched');
});

// Every element of the page as Astro renders it, the rules of `css` (Astro's
// compiled output) that match it and at what specificity: { element: { rule: specificity } }.
function cascadeOf(css, document) {
  const postcss = require('postcss');
  const out = new Map();
  const elements = [...document.querySelectorAll('body *')];
  elements.forEach((element) => out.set(element, new Map()));
  const flat = (selector, parents) =>
    parents === undefined
      ? selector.split(/,\s*/)
      : parents.flatMap((parent) => selector.split(/,\s*/).map((member) => (member.includes('&') ? member.replaceAll('&', parent) : `${parent} ${member}`)));
  // A test page nests three levels; the bound is the tree's own.
  const TEST_LIMITS = { cssDepthMax: 64 };
  const walk = (container, parents, context, depth = 0) => {
    assert.ok(depth <= TEST_LIMITS.cssDepthMax, 'the test CSS nests within the bound');
    for (const node of container.nodes ?? []) {
      if (node.type === 'rule') {
        const members = flat(node.selector, parents);
        const declarations = node.nodes.filter((child) => child.type === 'decl').map(String);
        if (declarations.length > 0) {
          const rule = `${context}${declarations.join(';')}`;
          for (const element of elements) {
            const weights = members.filter((member) => element.matches(member)).map((member) => modules.compileSelectorList(member)[0].specificity.join('.'));
            if (weights.length > 0) {
              out.get(element).set(rule, weights.sort().at(-1));
            }
          }
        }
        walk(node, members, context, depth + 1);
      } else if (node.type === 'atrule' && node.nodes) {
        walk(node, parents, `${context}@${node.params} `, depth + 1);
      }
    }
  };
  walk(postcss.parse(css), undefined, '');
  return out;
}

test('Astro renders the page and the moved markup with the same rules, the page at the same specificity', async (context) => {
  const setup = await project(context);
  await createButton(setup);
  const { transform } = await import('@astrojs/compiler-rs');
  const compile = async (text) => (await transform(text, { filename: setup.pagePath, scopedStyleStrategy: 'attribute' })).css.join('\n');
  const before = await compile(PAGE);
  const after = await compile(fs.readFileSync(setup.pagePath, 'utf8'));
  const scope = /\[(data-astro-cid-[a-z0-9]+)\]/.exec(before)?.[1];
  assert.ok(scope, 'the page compiles to scoped rules');

  // The page as it renders: Astro's scope on every element it writes. After the
  // move, the button's elements carry the component's scope instead.
  const { JSDOM } = require('jsdom');
  const body = /<body>([\s\S]*)<\/body>/.exec(PAGE)[1];
  const dom = new JSDOM(`<body>${body}</body>`);
  const document = dom.window.document;
  const moved = new Set([document.querySelector('a.button:not(.secondary)'), ...document.querySelectorAll('a.button:not(.secondary) *')]);
  const scoped = (inComponent) => {
    for (const element of document.querySelectorAll('body *')) {
      element.removeAttribute(scope);
      element.removeAttribute('data-astro-cid-button');
      element.setAttribute(inComponent && moved.has(element) ? 'data-astro-cid-button' : scope, '');
    }
  };
  scoped(false);
  const was = cascadeOf(before, document);
  scoped(true);
  const is = cascadeOf(after, document);
  scoped(false);
  const pageNow = cascadeOf(after, document);

  for (const element of document.querySelectorAll('body *')) {
    const label = element.outerHTML.slice(0, 60);
    const rulesWere = [...was.get(element).keys()].sort();
    const rulesAre = [...is.get(element).keys()].sort();
    assert.deepEqual(rulesAre, rulesWere, `the same rules reach ${label}`);
    if (moved.has(element)) {
      assert.ok(rulesWere.length > 0, `${label} was styled by the page`);
    } else {
      assert.deepEqual([...is.get(element)].sort(), [...was.get(element)].sort(), `at the same specificity: ${label}`);
    }
    // Before the move, with every element still the page's: nothing changed at all.
    assert.deepEqual([...pageNow.get(element)].sort(), [...was.get(element)].sort(), `the rewrite alone changes nothing for ${label}`);
  }
  const span = document.querySelector('.cta-label');
  assert.ok(
    [...is.get(span).keys()].some((rule) => rule.includes('border-radius: 100vw')),
    'the nested & > span rule reaches the moved span',
  );
});

test('the Style panel, with the component open on the page, finds the page’s .button rule and edits it there', async (context) => {
  const setup = await project(context);
  const { created } = await createButton(setup);
  const read = parsePageDiskRead(await setup.harness.invoke('page:read', created.path));
  assert.ok(read.editable);
  const button = findNode(read.model.nodes, (node) => node.kind === 'element' && node.name === 'a');
  assert.ok(button);
  // The panel's file reads and writes, answered by main, with the project open.
  await setup.harness.invoke('project:scan', setup.root);
  globalThis.window = {
    avb: {
      readStyleFile: (payload) => setup.harness.invoke('style:readFile', payload),
      writeStyleFile: (payload) => setup.harness.invoke('style:writeFile', payload),
    },
  };
  context.after(() => {
    delete globalThis.window;
  });
  modules.setHost({
    ...modules.getHost(),
    projectPath: setup.root,
    nodes: read.model.nodes,
    selectedId: button.id,
    files: [],
    astroFiles: [],
    openFilePath: created.path,
    openFileKind: 'component',
    contextPagePath: setup.pagePath,
  });
  const sources = await modules.scanAllComponents();
  const { docs, errors } = await modules.loadEmbedDocs(sources);
  assert.deepEqual(errors, []);
  const rules = modules.rebuildRules(docs);
  const byId = new Map();
  const parents = new Map();
  for (const entry of placed(read.model.nodes)) {
    byId.set(entry.node.id, entry.node);
    parents.set(entry.node.id, entry.parentId);
  }
  const view = {
    truncated: true,
    parentKey: (key) => parents.get(key),
    childKeys: (key) => (byId.get(key)?.children ?? []).map((child) => child.id),
    snapshot: async (key) => {
      const node = byId.get(key);
      if (node?.kind !== 'element') {
        return undefined;
      }
      const classes = String(node.props?.class?.value ?? '')
        .split(/\s+/)
        .filter(Boolean);
      return { tag: node.name, webflowType: '', id: undefined, classes, classList: classes, attributes: { class: classes.join(' ') } };
    },
  };
  const ruleModel = await modules.computeRuleModel(rules, { rootKey: button.id, view });
  const hit = ruleModel.base.find((entry) => entry.matchedSelectors.some((selector) => selector.text === '.button'));
  assert.ok(hit, `the panel lists .button for a.button (it listed ${JSON.stringify(ruleModel.base.map((entry) => entry.label))})`);
  assert.equal(hit.rule.embedKey, `astro:${setup.pagePath}`, 'from the page');
  assert.ok(!rules.some((rule) => rule.selectorText.includes('.unused')), 'a page rule that does not reach the component is not offered');

  // An edit to it is an edit to the page's own rule.
  const document = docs.find((entry) => entry.source.key === hit.rule.embedKey);
  hit.rule.node.append({ prop: 'letter-spacing', value: '0.1em' });
  const written = await modules.writeEmbedDocument(document);
  assert.equal(written.ok, true);
  const page = fs.readFileSync(setup.pagePath, 'utf8');
  assert.match(page, /\.button, :global\(\.button\) \{\n\s+background-color: var\(--brand\);[\s\S]*?letter-spacing: 0\.1em/, 'the page rule took the edit');
  assert.ok(!fs.readFileSync(created.path, 'utf8').includes('letter-spacing'), 'and the component file did not');
});

// ── 2. One undo step ────────────────────────────────────────────────────────

// The file half the app builds, wired to main's real handlers.
function filesFor(setup, made, answers) {
  const asked = { count: 0 };
  const files = modules.createdComponentFiles(
    {
      discard: async ({ checksum, force }) =>
        (await setup.harness.invoke('component:discard', { projectPath: setup.root, path: made.created.path, checksum, force })).outcome,
      create: async () => (await setup.harness.invoke('component:create', made.input)).checksum,
      confirmDelete: async () => {
        asked.count += 1;
        return answers.deleteEdited;
      },
      rescan: async () => {},
    },
    made.created.checksum,
  );
  return { files, asked };
}

test('one undo takes back the page edit and the file; one redo brings both back', async (context) => {
  const setup = await project(context);
  const made = await createButton(setup);
  const { files, asked } = filesFor(setup, made, { deleteEdited: false });
  const createdPage = fs.readFileSync(setup.pagePath, 'utf8');
  const createdComponent = fs.readFileSync(made.created.path, 'utf8');

  let undone = [];
  const undo = await modules.stepWithFiles('undo', files, async () => {
    undone = await reverted(made.send, setup.pagePath, made.record.outcome.applied);
    return 'whole';
  });
  assert.deepEqual(undo, { tag: 'stepped', page: 'whole' });
  assert.equal(fs.readFileSync(setup.pagePath, 'utf8'), PAGE, 'the page is restored byte for byte, its styles too');
  assert.ok(!fs.existsSync(made.created.path), 'and the component file is gone');
  assert.equal(asked.count, 0, 'an untouched file goes without a question');

  const redo = await modules.stepWithFiles('redo', files, async () => {
    await reverted(made.send, setup.pagePath, undone);
    return 'whole';
  });
  assert.deepEqual(redo, { tag: 'stepped', page: 'whole' });
  assert.equal(fs.readFileSync(made.created.path, 'utf8'), createdComponent, 'redo writes the component again');
  assert.equal(fs.readFileSync(setup.pagePath, 'utf8'), createdPage, 'and the page edit');
});

test('a component edited since is kept unless the person says to delete it', async (context) => {
  const setup = await project(context);
  const made = await createButton(setup);
  const { files, asked } = filesFor(setup, made, { deleteEdited: false });
  const edited = fs.readFileSync(made.created.path, 'utf8').replace('Start', 'Begin');
  fs.writeFileSync(made.created.path, edited);

  let undone = [];
  await modules.stepWithFiles('undo', files, async () => {
    undone = await reverted(made.send, setup.pagePath, made.record.outcome.applied);
    return 'whole';
  });
  assert.equal(asked.count, 1, 'the person is asked');
  assert.equal(fs.readFileSync(made.created.path, 'utf8'), edited, 'kept, with the edit in it');
  assert.equal(fs.readFileSync(setup.pagePath, 'utf8'), PAGE, 'the page is restored either way');

  // Redo finds the kept file there to import, and writes nothing over it.
  await modules.stepWithFiles('redo', files, async () => {
    await reverted(made.send, setup.pagePath, undone);
    return 'whole';
  });
  assert.equal(fs.readFileSync(made.created.path, 'utf8'), edited, 'redo leaves the kept file alone');
  assert.ok(fs.readFileSync(setup.pagePath, 'utf8').includes('<Button />'), 'and replays the page');

  const sure = filesFor(setup, made, { deleteEdited: true });
  await sure.files.undo();
  assert.equal(sure.asked.count, 1);
  assert.ok(!fs.existsSync(made.created.path), 'told to, Undo deletes the edited file');
});

test('the file follows the page: kept while part of it still imports it, taken back when a redo fails', async (context) => {
  const setup = await project(context);
  const made = await createButton(setup);
  const { files } = filesFor(setup, made, { deleteEdited: false });

  const part = await modules.stepWithFiles('undo', files, async () => 'part');
  assert.deepEqual(part, { tag: 'stepped', page: 'part' });
  assert.ok(fs.existsSync(made.created.path), 'a page still importing it keeps the file');

  await modules.stepWithFiles('undo', files, async () => 'whole');
  assert.ok(!fs.existsSync(made.created.path), 'the rest undone, it goes');

  const none = await modules.stepWithFiles('redo', files, async () => 'none');
  assert.deepEqual(none, { tag: 'stepped', page: 'none' });
  assert.ok(!fs.existsSync(made.created.path), 'a page that would not replay takes the file back');

  // Someone made a Button meanwhile: redo can't write it, and touches nothing.
  fs.writeFileSync(made.created.path, '<p>theirs</p>\n');
  let replayed = false;
  const refused = await modules.stepWithFiles('redo', files, async () => {
    replayed = true;
    return 'whole';
  });
  assert.equal(refused.tag, 'refused');
  assert.match(refused.message, /already a component called Button/);
  assert.equal(replayed, false, 'the page is not replayed over a file it did not write');
  assert.equal(fs.readFileSync(made.created.path, 'utf8'), '<p>theirs</p>\n', 'and their file is untouched');
});

test('component:discard deletes only a component file', async (context) => {
  const setup = await project(context);
  const outside = path.join(setup.root, 'src/pages/index.astro');
  await assert.rejects(
    setup.harness.invoke('component:discard', { projectPath: setup.root, path: outside, checksum: 'a'.repeat(64), force: true }),
    /Only a component file/,
  );
  assert.ok(fs.existsSync(outside), 'a page is never deleted through it');
  const missing = path.join(setup.root, 'src/components/Nope.astro');
  const answer = await setup.harness.invoke('component:discard', { projectPath: setup.root, path: missing, checksum: 'a'.repeat(64) });
  assert.deepEqual(answer, { outcome: 'missing' });
});
