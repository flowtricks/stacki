// Goal: the things that happen most in the app re-render only what shows them.
// A navigator hover is read by the canvas alone; dev-server output is shown in
// two corners; the canvas re-reports what it rendered after every walk of the
// page, mostly unchanged. Each used to re-render the whole app — every panel,
// the navigator, the style panel — once per row crossed, per chunk of output,
// per report.
// Method: the real App in jsdom over the gesture harness's bridge, every panel
// stubbed by a component that counts its renders. Hover a row, emit a chunk of
// output, and repeat a canvas report with equal content; each time, compare
// the panels' render counts before and after. Then change a report's content,
// which must still reach the panels.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { mountApp, nodeAt, tick } = require('../../helpers/appGestures.js');

const PAGE = '<main>\n  <h1>Heading</h1>\n  <p>Text</p>\n</main>\n';

// Which panels rendered while `run` ran, and how many times.
async function rendersDuring(app, run) {
  const before = { ...global.__renders };
  await app.act(async () => {
    await run();
    await tick();
  });
  const rendered = {};
  for (const [name, count] of Object.entries(global.__renders)) {
    const added = count - (before[name] ?? 0);
    if (added > 0) {
      rendered[name] = added;
    }
  }
  return rendered;
}

test('the busiest updates re-render only their readers', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-render-isolation-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src/pages'), { recursive: true });
  const file = path.join(root, 'src/pages/index.astro');
  fs.writeFileSync(file, PAGE);
  const scan = {
    pages: [{ name: 'index.astro', path: file, route: '/' }],
    components: [],
    layouts: [],
    pageFolders: [],
  };
  let emit = () => {};
  const onDevLog = (listener) => {
    emit = listener;
    return () => {};
  };
  const app = await mountApp(root, { scan }, 'render-isolation', { bridge: { onDevLog } });
  context.after(app.unmount);

  const heading = nodeAt([0, 0]).id;
  const hovered = await rendersDuring(app, () => __panels.StructurePanel.onHoverNode(heading));
  assert.deepEqual(Object.keys(hovered), ['PreviewPane'], 'a hover re-renders the canvas alone');

  const logged = await rendersDuring(app, () => emit('[vite] page reload\n'));
  assert.deepEqual(logged, {}, 'a chunk of dev-server output re-renders no panel');

  const paths = ['0', '0.0'];
  await rendersDuring(app, () => __panels.PreviewPane.onRenderedPaths([...paths]));
  const repeated = await rendersDuring(app, () => __panels.PreviewPane.onRenderedPaths([...paths]));
  assert.deepEqual(repeated, {}, 'an unchanged report re-renders nothing');

  const changed = await rendersDuring(app, () => __panels.PreviewPane.onRenderedPaths([...paths, '0.1']));
  assert.ok(changed['StructurePanel'] > 0, 'a changed report still reaches the navigator');
});
