// Goal: switching a prop from an expression to the normal field is one undo
// step in the real app and rewrites only that attribute. `content={"text"}`
// becomes `content="text"` (the write the {} toggle makes through the
// Settings panel's onSetProp), and one undo restores the source byte for byte.
// Code the control cannot hold is never written over: the panel's decision
// refuses it before any write, so the file is untouched (pinned in
// test/renderer/props/normalFieldMenu.test.js).
// Method: the real App in jsdom with stub panels (test/helpers/appGestures.js)
// over a temporary project, as test/renderer/app/propReset.test.js does; the
// file is read back after the save and after the undo.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { gesture, mountApp, select, undo } = require('../../helpers/appGestures.js');

const PAGE = ['---', "import Card from '../components/Card.astro';", '---', '<main>', '  <Card heading={"Hi"} tone="#00aa55" />', '</main>', ''].join('\n');
const CARD = [
  '---',
  'interface Props {',
  '  heading?: string;',
  '  tone?: string;',
  '}',
  "const { heading = 'Welcome', tone = '#ff3366' } = Astro.props;",
  '---',
  '<h2 style={`color:${tone}`}>{heading}</h2>',
  '',
].join('\n');

test('Use the normal field rewrites a literal expression, and one undo restores it exactly', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-normal-field-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src', 'pages'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src', 'components'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{"dependencies":{"astro":"*"}}');
  const page = path.join(root, 'src', 'pages', 'index.astro');
  const card = path.join(root, 'src', 'components', 'Card.astro');
  fs.writeFileSync(page, PAGE);
  fs.writeFileSync(card, CARD);
  const scan = {
    pages: [{ name: 'index.astro', path: page, route: '/' }],
    components: [{ name: 'Card', path: card, folder: '' }],
    layouts: [],
    pageFolders: [],
  };
  const bridge = { resolveImport: async () => ({ path: card }), watchProject: async () => ({ ok: true }) };
  const app = await mountApp(root, { scan }, 'normal-field-undo', { bridge });
  context.after(app.unmount);
  await select(app, [0, 0]);
  assert.equal(__panels.PropsPanel.node.name, 'Card', 'the instance is selected');
  assert.deepEqual(__panels.PropsPanel.node.props.heading, { type: 'expr', value: '"Hi"' }, 'the instance holds an expression');
  await gesture(app, async () => {
    __panels.PropsPanel.onSetProp('heading', { type: 'string', value: 'Hi' }, true);
  });
  assert.equal(fs.readFileSync(page, 'utf8'), PAGE.replace('heading={"Hi"}', 'heading="Hi"'), 'only that attribute is rewritten');
  await undo(app);
  assert.equal(fs.readFileSync(page, 'utf8'), PAGE, 'one undo restores it byte for byte');
  assert.equal(fs.readFileSync(card, 'utf8'), CARD, 'the component is never touched');
});

test('Replacing code with the empty value is one undo step too', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-normal-field-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src', 'pages'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src', 'components'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{"dependencies":{"astro":"*"}}');
  const page = path.join(root, 'src', 'pages', 'index.astro');
  const card = path.join(root, 'src', 'components', 'Card.astro');
  fs.writeFileSync(page, PAGE.replace('heading={"Hi"}', 'heading={card.title}'));
  fs.writeFileSync(card, CARD);
  const scan = {
    pages: [{ name: 'index.astro', path: page, route: '/' }],
    components: [{ name: 'Card', path: card, folder: '' }],
    layouts: [],
    pageFolders: [],
  };
  const bridge = { resolveImport: async () => ({ path: card }), watchProject: async () => ({ ok: true }) };
  const app = await mountApp(root, { scan }, 'normal-field-undo', { bridge });
  context.after(app.unmount);
  await select(app, [0, 0]);
  assert.equal(__panels.PropsPanel.node.name, 'Card', 'the instance is selected');
  const CODE_PAGE = PAGE.replace('heading={"Hi"}', 'heading={card.title}');
  assert.deepEqual(__panels.PropsPanel.node.props.heading, { type: 'expr', value: 'card.title' });
  await gesture(app, async () => {
    __panels.PropsPanel.onSetProp('heading', undefined, true);
  });
  assert.equal(fs.readFileSync(page, 'utf8'), CODE_PAGE.replace(' heading={card.title}', ''), 'only the binding is removed');
  await undo(app);
  assert.equal(fs.readFileSync(page, 'utf8'), CODE_PAGE, 'one undo restores the expression byte for byte');
  assert.equal(fs.readFileSync(card, 'utf8'), CARD, 'the component is never touched');
});
