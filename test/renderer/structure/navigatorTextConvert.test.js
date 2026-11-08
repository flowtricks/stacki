// Goal: bare text can be given a tag from the element menu without touching the text
// around it, undo gives the bare text back, and a request a text node cannot honour
// never blocks the page's later edits.
// Method: mount the real app over temporary Astro files and open the canvas menu,
// which is the component the navigator renders too. Each gesture goes through the
// real edit engine and the disk bytes are compared. The menu's rule is checked apart
// on valid and invalid trees, because its refusals have no bytes to compare.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');
const { gesture, mountApp, nodeAt, select, tick } = require('../../helpers/appGestures.js');
const { repoPath } = require('../../helpers/sources.js');

const CODE =
  '<code class="dev_code">// npm install<br />import &#123; Pidgin &#125; from "@pidgin/sdk";<br /><br /> to: "Dana, 4th floor",<br />&#125;);</code>';
const source = [
  '<main>',
  `  ${CODE}`,
  '  <p>Hello <b>bold</b> middle &amp; words <i>slanted</i> tail</p>',
  '  <section>',
  '    First line',
  '    second line',
  '    <b>bold</b>',
  '  </section>',
  '</main>',
  '',
].join('\n');

async function mounted(context, name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `stacki-${name}-`));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src/pages'), { recursive: true });
  const file = path.join(root, 'src/pages/index.astro');
  fs.writeFileSync(file, source);
  const scan = { pages: [{ name: 'index.astro', path: file, route: '/' }], components: [], layouts: [], pageFolders: [] };
  const app = await mountApp(root, { scan }, name);
  context.after(app.unmount);
  return { app, disk: () => fs.readFileSync(file, 'utf8') };
}

// The index of the text run holding these words.
function textIndex(parentPath, words) {
  const index = nodeAt(parentPath).children.findIndex((node) => node.kind === 'text' && node.value.includes(words));
  assert.ok(index >= 0, `a text run holding ${words}`);
  return index;
}

// The path of the page's element of this name: parser whitespace occupies sibling slots.
function elementPath(name) {
  const index = nodeAt([0]).children.findIndex((node) => node.name === name);
  assert.ok(index >= 0, `a ${name} element`);
  return [0, index];
}

const menuItem = (label) => [...document.querySelectorAll('[role="menuitem"]')].find((entry) => entry.firstElementChild?.textContent === label);

async function openMenu(app, nodePath) {
  await app.act(() => __panels.PreviewPane.onContextPath(nodePath.join('.'), { left: 300, top: 200, occurrence: 0, outside: false }));
  await app.act(() => tick());
}

async function convert(app, nodePath, tag) {
  await openMenu(app, nodePath);
  await app.act(() => menuItem('Convert to').click());
  await gesture(app, () => menuItem(tag).click());
}

async function pressUndo(app) {
  await gesture(app, async () => {
    document.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true }));
  });
}

test('Convert to wraps only the run, selects the new element and undoes to bare text', async (context) => {
  const { app, disk } = await mounted(context, 'text-convert');
  const code = elementPath('code');
  const between = [...code, textIndex(code, 'Pidgin')];
  await convert(app, between, 'span');
  assert.equal(disk(), source.replace('import &#123; Pidgin &#125; from "@pidgin/sdk";', '<span>import &#123; Pidgin &#125; from "@pidgin/sdk";</span>'));
  assert.equal(nodeAt(between).name, 'span');
  assert.equal(__panels.StructurePanel.selectedId, nodeAt(between).id, 'the new element is selected');
  await pressUndo(app);
  assert.equal(disk(), source, 'undo restores the bare text byte for byte');
  assert.equal(nodeAt(between).kind, 'text');

  // A space on the run's own line is part of the run, and a div is offered here too.
  const spaced = [...code, textIndex(code, 'Dana')];
  await convert(app, spaced, 'div');
  assert.equal(disk(), source.replace(' to: "Dana, 4th floor",', '<div> to: "Dana, 4th floor",</div>'));
  await pressUndo(app);
  assert.equal(disk(), source);

  // Between inline elements: the elements either side stay as they are.
  const paragraph = elementPath('p');
  await convert(app, [...paragraph, textIndex(paragraph, 'middle')], 'span');
  assert.equal(disk(), source.replace(' middle &amp; words ', '<span> middle &amp; words </span>'));
  await pressUndo(app);
  assert.equal(disk(), source);

  // Lines of their own: the layout stays outside the tag, and a run that opens
  // with it moves the new element one sibling along, behind the blank run.
  const section = elementPath('section');
  const lines = [...section, textIndex(section, 'First line')];
  await convert(app, lines, 'div');
  assert.equal(disk(), source.replace('First line\n    second line', '<div>First line\n    second line</div>'));
  const created = nodeAt(section).children.find((node) => node.name === 'div');
  assert.equal(__panels.StructurePanel.selectedId, created?.id, 'the element is selected behind the blank run');
  await pressUndo(app);
  assert.equal(disk(), source);
});

test('text offers Convert to and elements keep Wrap in', async (context) => {
  const { app } = await mounted(context, 'text-convert-menu');
  const code = elementPath('code');
  await openMenu(app, [...code, textIndex(code, 'npm install')]);
  assert.equal(menuItem('Wrap in'), undefined, 'text has no tag to wrap');
  // Selecting the run scrolls the navigator to its row, which must not take the menu away.
  await app.act(() => document.body.dispatchEvent(new app.window.Event('scroll')));
  await app.act(() => tick());
  assert.ok(menuItem('Convert to'), 'the menu outlives the navigator reveal');
  await app.act(() => menuItem('Convert to').click());
  assert.equal(menuItem('div').disabled, false);
  assert.equal(menuItem('span').disabled, false);

  await openMenu(app, code);
  assert.ok(menuItem('Wrap in'));
  assert.equal(menuItem('Convert to'), undefined, 'an element is not offered a conversion');

  // A <div> would close the paragraph it sits in, so only span is offered there.
  const paragraph = elementPath('p');
  await openMenu(app, [...paragraph, textIndex(paragraph, 'middle')]);
  await app.act(() => menuItem('Convert to').click());
  assert.equal(menuItem('div').disabled, true);
  assert.equal(menuItem('span').disabled, false);
});

test('a class typed on bare text is refused and the page keeps saving', async (context) => {
  const { app, disk } = await mounted(context, 'text-class');
  const code = elementPath('code');
  const run = [...code, textIndex(code, 'Dana')];
  await select(app, run);
  let outcome;
  await gesture(app, async () => {
    outcome = await __panels.StylePanel.onAddClass('codey', 'after');
  });
  assert.equal(outcome.tag, 'refused');
  assert.match(outcome.message, /no tag to hold a class/);
  assert.equal(disk(), source);
  await gesture(app, () => __panels.PropsPanel.onSetText(' to: "Dana, 5th floor",'));
  assert.equal(disk(), source.replace('4th floor', '5th floor'), 'the next text edit saves');
});

test('an attribute edit that reaches a text node is withdrawn, not left at the head of the queue', async (context) => {
  const { app, disk } = await mounted(context, 'text-attribute');
  const code = elementPath('code');
  const run = [...code, textIndex(code, 'Dana')];
  await select(app, run);
  await gesture(app, () => __panels.PropsPanel.onSetProp('title', { type: 'string', value: 'x' }, true));
  assert.equal(disk(), source);
  await gesture(app, () => __panels.PropsPanel.onSetText(' to: "Dana, 5th floor",'));
  assert.equal(disk(), source.replace('4th floor', '5th floor'), 'the refused edit does not block the next one');
});

test('the menu rule refuses text that cannot take a tag', async () => {
  const directory = fs.mkdtempSync(repoPath('node_modules/.stacki-test/text-convert-rule-'));
  const outfile = path.join(directory, 'wrapRules.js');
  await esbuild.build({ entryPoints: [repoPath('src/editor/wrapRules.ts')], outfile, bundle: true, format: 'cjs', platform: 'node', logLevel: 'silent' });
  const { canConvertText } = require(outfile);
  const text = (id, value) => ({ id, kind: 'text', value });
  const element = (id, name, children) => ({ id, kind: 'element', name, props: {}, children });
  const inside = (name) => [element('n0', name, [text('n0.0', 'words')])];
  for (const name of ['div', 'code', 'span', 'h1', 'li', 'a']) {
    assert.equal(canConvertText(inside(name), 'n0.0', 'span'), true, `span inside ${name}`);
    assert.equal(canConvertText(inside(name), 'n0.0', 'div'), true, `div inside ${name}`);
  }
  assert.equal(canConvertText([text('n0', 'top level')], 'n0', 'div'), true);
  for (const name of ['title', 'textarea', 'option', 'ul', 'tr']) {
    assert.equal(canConvertText(inside(name), 'n0.0', 'span'), false, `span inside ${name}`);
    assert.equal(canConvertText(inside(name), 'n0.0', 'div'), false, `div inside ${name}`);
  }
  // A paragraph above closes for a div however deep the run sits.
  const deep = [element('n0', 'p', [element('n0.0', 'b', [text('n0.0.0', 'words')])])];
  assert.equal(canConvertText(deep, 'n0.0.0', 'div'), false);
  assert.equal(canConvertText(deep, 'n0.0.0', 'span'), true);
  // Only words convert: not a blank run, a tag, or a node that is gone.
  assert.equal(canConvertText([element('n0', 'div', [text('n0.0', ' \n ')])], 'n0.0', 'span'), false);
  assert.equal(canConvertText(inside('div'), 'n0', 'span'), false);
  assert.equal(canConvertText(inside('div'), 'missing', 'span'), false);
});
