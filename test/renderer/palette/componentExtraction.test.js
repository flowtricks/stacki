// Goal: creating a component from the selection writes the component file,
// swaps the markup for an instance of it, leaves the user's CSS exactly as it
// was written, and is one undo step.
//
// Three things this holds shut. First, Stacki once rewrote the page's scoped
// `<style>` selectors (`.button {` became `.button, :global(.button) {`) when it
// made a component; the CSS is the user's and is never rewritten, so every
// `<style>` block of the page must come out byte for byte as it went in.
// Second, nothing is copied into the component: the markup moves, the CSS
// stays. Third, ⌘Z put the markup back but left src/components/Button.astro and
// its Components panel entry behind.
//
// Method: the real modules, bundled with esbuild, on a temporary project, with
// main's real handlers in the windowless harness. A page with varied CSS
// (nested `&` rules, a media query, a global block) has its button turned into
// a component the way useCreateComponent does it: component:create, then the
// extraction gesture as one request. The page is checked against the original
// as text: the markup swapped for `<Button />`, the import added, and every
// `<style>` block unchanged. Then undo and redo run through stepWithFiles, the
// function appHistory.ts's stepEdits uses, with the page reverted by main
// exactly as revertedSteps does.
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
      "export { createdComponentFiles, stepWithFiles } from './src/app/model/componentCreation';",
      "export { extractionGesture } from './src/app/model/pageGestures';",
      "export { sendGesture } from './src/editor/pageEdits';",
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
  const input = { projectPath: root, pagePath, name: 'Button', nodes: [node], imports: model.imports, props: [] };
  const created = await harness.invoke('component:create', input);
  const paths = await harness.invoke('page:importPathFor', { pagePath, targetPath: created.path, projectPath: root });
  const extracted = { id: 'g' + '0'.repeat(32), name: 'Button', props: [], place: placeOf(model.nodes, node.id), paths };
  const gesture = modules.extractionGesture(model, node.id, extracted);
  // As the queue leaves a step when it takes the gesture: one write owed.
  const record = { outcome: { tag: 'pending', waiting: 1, applied: [] } };
  const send = async (request) => parsePageEditResult(await harness.invoke('page:edit', request));
  const origin = { checksum: read.checksum, source: read.source, model };
  const outcome = await modules.sendGesture({ path: pagePath, origin, gesture, record, send });
  assert.equal(outcome.tag, 'applied', 'the page took the edit');
  assert.equal(record.outcome.tag, 'applied');
  assert.equal(record.outcome.applied.length, outcome.replies.length, 'every write left its inverse in the one step');
  return { created, input, record, send };
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

// Every `<style>` block of a file, opening tag and body, in source order.
function styleBlocks(text) {
  return [...text.matchAll(/<style\b[^>]*>[\s\S]*?<\/style>/g)].map((match) => match[0]);
}

// ── 1. The user's CSS is never rewritten ────────────────────────────────────

test('making a component leaves every <style> block of the page byte for byte unchanged', async (context) => {
  const setup = await project(context);
  const { created } = await createButton(setup);
  const page = fs.readFileSync(setup.pagePath, 'utf8');

  const blocksBefore = styleBlocks(PAGE);
  assert.equal(blocksBefore.length, 2, 'the fixture has a scoped and a global block');
  assert.deepEqual(styleBlocks(page), blocksBefore, 'every <style> block is exactly as the user wrote it');
  assert.ok(!page.includes(':global('), 'no :global() is written into the page');
  // Negative space: the page changed only where the markup moved and the import went in.
  const restored = page
    .replace("import Button from '../components/Button.astro';\n", '')
    .replace('<Button />', '<a href="#" class="button">Start <span class="cta-label">→</span><em class="cta-note">!</em></a>');
  assert.equal(restored, PAGE, 'the instance and its import are the only changes to the page');

  const component = fs.readFileSync(created.path, 'utf8');
  assert.ok(component.includes('<a href="#" class="button">'), 'the markup moved');
  assert.ok(!component.includes('<style'), 'and no CSS was copied into the component');
  assert.ok(!component.includes(':global('), 'nor any :global() written into it');
  assert.ok(page.includes('<Button />'), 'the page holds the instance');
  assert.match(page, /import Button from '\.\.\/components\/Button\.astro'/, 'and imports it');
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
  assert.equal(undone.length, made.record.outcome.applied.filter((step) => step.inverse.length > 0).length, 'one undo reverts every write of the step');
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
  assert.deepEqual(styleBlocks(createdPage), styleBlocks(PAGE), 'redo leaves the styles as written too');
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
