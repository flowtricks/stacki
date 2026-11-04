// Goal: Reset to default on an instance's prop is one undo step in the real
// app. The Settings panel's reset writes the prop's removal as one immediate
// change (test/renderer/props/propInstanceUX.test.js pins that); here the app
// turns that write into the attribute's removal on disk, leaving every other
// byte alone, and ⌘Z puts the attribute back exactly.
// Method: the real App in jsdom with stub panels (test/helpers/appGestures.js)
// over a temporary project. The instance is selected through the navigator's
// callback, the reset is driven through the Settings panel's onSetProp exactly
// as the panel calls it, and the file is read back after the save and after
// the undo.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { gesture, mountApp, select, undo } = require('../../helpers/appGestures.js');

const PAGE = ['---', "import Card from '../components/Card.astro';", '---', '<main>', '  <Card heading="Hi" tone="#00aa55" />', '</main>', ''].join('\n');
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

test('Reset to default removes the attribute, and one undo restores it', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-prop-reset-'));
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
  const app = await mountApp(root, { scan }, 'prop-reset', { bridge });
  context.after(app.unmount);
  await select(app, [0, 0]);
  assert.equal(__panels.PropsPanel.node.name, 'Card', 'the instance is selected');
  assert.deepEqual(__panels.PropsPanel.node.props.heading, { type: 'string', value: 'Hi' });
  await gesture(app, async () => {
    __panels.PropsPanel.onSetProp('heading', undefined, true);
  });
  assert.equal(fs.readFileSync(page, 'utf8'), PAGE.replace(' heading="Hi"', ''), 'only the attribute is removed');
  assert.equal(__panels.PropsPanel.node.props.heading, undefined, 'the panel sees it unset');
  await undo(app);
  assert.equal(fs.readFileSync(page, 'utf8'), PAGE, 'one undo restores it byte for byte');
  assert.deepEqual(__panels.PropsPanel.node.props.heading, { type: 'string', value: 'Hi' });
  // A colour reset is the same write.
  await gesture(app, async () => {
    __panels.PropsPanel.onSetProp('tone', undefined, true);
  });
  assert.equal(fs.readFileSync(page, 'utf8'), PAGE.replace(' tone="#00aa55"', ''));
  await undo(app);
  assert.equal(fs.readFileSync(page, 'utf8'), PAGE);
  assert.equal(fs.readFileSync(card, 'utf8'), CARD, 'the component is never touched');
});
