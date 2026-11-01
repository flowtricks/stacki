// Goal: clicking during a local render backlog selects the node the user saw.
// Method: preserve session node handles across text, move and deletion gestures,
// validate the rewritten manifest, and inject outside changes and navigation
// while the disk check is pending. No old numeric path may select a neighbour.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const load = require('../../helpers/rendererModule');
const { PreviewOrigins, judgeRememberedClick } = load('src/features/preview/previewSelection.ts');
const { sameShape } = load('src/features/preview/previewGate.ts');
const { canonicalManifest } = require('#dist/shared/page/previewToken.js');
const digest = (value) => createHash('sha256').update(value).digest('hex');
const file = 'src/components/Example.astro';
const oldChecksum = digest('old');
const newChecksum = digest('new');
const node = (id) => ({ id, kind: 'element', name: 'p', children: [] });
const nodes = [node('first'), node('second')];
const render = (checksum) => {
  const stamps = [
    { file, checksum },
    { file: 'src/pages/index.astro', checksum: digest('page') },
  ];
  return { stamps, token: digest(canonicalManifest(stamps)) };
};
function fixture(nextNodes = nodes) {
  const origins = new PreviewOrigins();
  const previous = { checksum: oldChecksum, model: { nodes }, source: 'old' };
  const origin = { checksum: newChecksum, model: { nodes: nextNodes }, source: 'new' };
  origins.remember(file, previous);
  origins.remember(file, origin);
  const state = {
    editable: true,
    model: origin.model,
    origin,
    save: { tag: 'clean', checksum: newChecksum },
  };
  let shown = { file, state };
  const current = render(oldChecksum);
  const check = async (request) => {
    assert.deepEqual(request, render(newChecksum));
    return { tag: 'current' };
  };
  return {
    origins,
    setShown: (value) => {
      shown = value;
    },
    shown: () => shown,
    judge: (inspect = check, request = current, path = `${file}|0`) => judgeRememberedClick(request.token, request, path, origins, inspect, () => shown),
  };
}

test('saved text can be selected before Astro renders it', async () => {
  assert.deepEqual(await fixture().judge(), { tag: 'current', path: `${file}|0` });
});
test('a click on a reordered same-tag sibling follows its handle', async () => {
  assert.equal(sameShape(nodes, [...nodes].reverse()), false);
  assert.deepEqual(await fixture([...nodes].reverse()).judge(), {
    tag: 'current',
    path: `${file}|1`,
  });
});
test('a removed target never selects the sibling now at its old index', async () => {
  assert.equal((await fixture([nodes[1]]).judge()).tag, 'stale');
});
test('an external change in any stamped file is still rejected', async () => {
  const verdict = { tag: 'stale', reason: 'file-changed', file: 'src/pages/index.astro' };
  assert.deepEqual(await fixture().judge(async () => verdict), verdict);
});
test('a forged token is not laundered when replacing a known stamp', async () => {
  let checked = false;
  const bad = { ...render(oldChecksum), token: digest('forged') };
  const result = await fixture().judge(async () => {
    checked = true;
  }, bad);
  assert.equal(result.reason, 'token-mismatch');
  assert.equal(checked, false);
});
test('navigation while checking disk cancels the selection', async () => {
  const setup = fixture();
  const result = await setup.judge(async () => {
    setup.setShown(undefined);
    return { tag: 'current' };
  });
  assert.equal(result.tag, 'stale');
});
test('another save during the disk check cannot use the previous verdict', async () => {
  const setup = fixture();
  const result = await setup.judge(async () => {
    const shown = setup.shown();
    setup.setShown({ ...shown, state: { ...shown.state, origin: { ...shown.state.origin } } });
    return { tag: 'current' };
  });
  assert.equal(result.tag, 'stale');
});
test('unknown, evicted and other-session origins retain the strict gate', async () => {
  for (const reset of ['unknown', 'evicted', 'session']) {
    const setup = fixture();
    if (reset === 'unknown') {
      setup.origins.remember(file, undefined);
    }
    if (reset === 'session') {
      setup.origins.remember('another', undefined);
    }
    if (reset === 'evicted') {
      for (let index = 0; index < 8; index++) {
        setup.origins.remember(file, { checksum: digest(String(index)), model: { nodes } });
      }
    }
    let checked = false;
    const result = await setup.judge(async () => {
      checked = true;
    });
    assert.equal(result.reason, 'shown-page-differs', reset);
    assert.equal(checked, false);
  }
});

test('the real App retains the rendered origin after saving content', async (context) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { mountApp, gesture, select } = require('../../helpers/appGestures.js');
  const { checkPreviewRender } = require('#dist/electron/preview/previewCheck.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-canvas-selection-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pagePath = path.join(root, 'src/pages/index.astro');
  fs.mkdirSync(path.dirname(pagePath), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  const source = '<main><p>Before</p></main>\n';
  fs.writeFileSync(pagePath, source);
  const stamps = [{ file: 'src/pages/index.astro', checksum: digest(source) }];
  const oldRender = { stamps, token: digest(canonicalManifest(stamps)) };
  const scan = {
    pages: [{ name: 'index.astro', path: pagePath, route: '/' }],
    components: [],
    layouts: [],
    pageFolders: [],
  };
  const app = await mountApp(root, { scan }, 'canvas-selection-recovery', {
    bridge: {
      checkPreview: async ({ projectPath, render }) => checkPreviewRender(projectPath, render),
    },
  });
  context.after(app.unmount);
  await select(app, [0, 0]);
  await gesture(app, async () => __panels.PropsPanel.onSetContent('After'));
  assert.match(fs.readFileSync(pagePath, 'utf8'), /After/);
  assert.equal(__panels.StructurePanel.pageState.save.tag, 'clean');
  const verdict = await __panels.PreviewPane.judgeEvent(oldRender.token, oldRender, {
    kind: 'click',
    path: '0.0',
    outside: false,
  });
  assert.deepEqual(verdict, { tag: 'current', path: '0.0' });
});

test('malformed and foreign paths never become a remembered node', async () => {
  for (const path of ['', '.', ' ', 'other.astro|0', `${file}|0..0`]) {
    assert.equal((await fixture().judge(undefined, render(oldChecksum), path)).tag, 'stale');
  }
});
