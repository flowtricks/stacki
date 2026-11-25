// Goal: nothing is drawn in front of the app, and the first bundle stays small. index.html holds only the
// app's surface colour and #root, the app's script starts at once, and the modules that only a project window or a closed dialog need (the editor shell, Settings, the
// panels) are reached by dynamic import only, so a cold start parses none of them (docs/startup.md).
// Method: index.html is read as text (no spinner or splash markup, colours, immediate start); the real renderer entry is
// bundled with esbuild with code splitting and its metafile gives the entry chunk's STATIC import
// closure, which must not contain the heavy modules; the same closure must still reach the start screen,
// so the check cannot pass by bundling nothing. The surface colour is compared with styles.css and main.ts.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const esbuild = require('esbuild');
const { repoPath } = require('../../helpers/sources.js');

const html = fs.readFileSync(repoPath('index.html'), 'utf8');
const styles = fs.readFileSync(repoPath('src/app/styles.css'), 'utf8');
const main = fs.readFileSync(repoPath('electron/main.ts'), 'utf8');
const marks = fs.readFileSync(repoPath('src/app/startupMarks.ts'), 'utf8');

test('index.html draws nothing before the app: no spinner, splash, skeleton, logo or words', () => {
  const body = html.slice(html.indexOf('<body>'), html.indexOf('</body>'));
  const markup = body.replace(/<script[\s\S]*?<\/script>/g, '');
  const text = markup.replace(/<[^>]*>/g, '').trim();
  assert.equal(text, '', 'no words');
  assert.deepEqual(markup.match(/<(?!\/)[a-z]+/g), ['<body', '<div'], 'the body holds #root and scripts only');
  assert.doesNotMatch(markup, /<img|<svg|<h1|<p>/, 'no logo, no words');
  assert.doesNotMatch(html, /boot-spinner|boot-ring|animation:|@keyframes|transition:/, 'no spinner, no animation, no fade');
  assert.match(body, /<div id="root"><\/div>/);
});

test('the surface colour is the panel colour and the window colour, and the app script is not held back', () => {
  const surface = '#111111';
  assert.ok(html.includes(`background: ${surface}`), 'the page is the dark surface');
  assert.ok(styles.includes(`--bg-panel: ${surface}`), 'which is the panel surface');
  assert.ok(main.includes(`backgroundColor: '${surface}'`), 'which is the window background');
  assert.ok(main.includes('show: false'), 'the window is shown on its first real frame');
  assert.ok(html.includes('<script type="module" src="/src/main.tsx"></script>'), 'the app starts at once, not after an animation frame');
  assert.ok(!html.includes('requestAnimationFrame'), 'no frame is waited for before the app starts');
  assert.ok(marks.includes('reportFirstFrame()'), 'the app tells main when its real shell has painted');
  assert.ok(!marks.includes('boot-spinner'), 'there is no spinner to remove');
});

const HEAVY = [
  'src/app/shell/AppShell.tsx',
  'src/app/settings/Settings.tsx',
  'src/features/ai/AiPanel.tsx',
  'src/features/style/StylePanel.tsx',
  'src/features/code/CodePanel.tsx',
  'src/features/audits/AuditsPanel.tsx',
  'src/features/projectSettings/ProjectSettingsPanel.tsx',
  'src/features/cms/CmsPanel.tsx',
  'src/features/terminal/TerminalPane.tsx',
  'src/features/apps/marketplace/MarketplaceView.tsx',
];

test('the entry chunk statically imports none of the heavy modules', async () => {
  const result = await esbuild.build({
    entryPoints: [repoPath('src/main.tsx')],
    bundle: true,
    splitting: true,
    format: 'esm',
    write: false,
    outdir: 'out',
    metafile: true,
    logLevel: 'silent',
    jsx: 'automatic',
    loader: { '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl', '.woff2': 'dataurl', '.wasm': 'empty', '.glsl': 'text', '.frag': 'text', '.vert': 'text' },
    define: { 'import.meta.env': '{}', 'process.env.NODE_ENV': '"production"' },
  });
  const outputs = result.metafile.outputs;
  const entryKey = Object.keys(outputs).find((key) => outputs[key].entryPoint?.endsWith('src/main.tsx'));
  assert.ok(entryKey, 'the entry chunk exists');
  const seen = new Set();
  const stack = [entryKey];
  const included = new Set();
  while (stack.length > 0) {
    const key = stack.pop();
    if (seen.has(key)) {
      continue;
    }
    assert.ok(seen.size < 500, 'the chunk walk is bounded');
    seen.add(key);
    Object.keys(outputs[key].inputs).forEach((input) => included.add(input));
    for (const edge of outputs[key].imports) {
      if (edge.kind === 'import-statement' && outputs[edge.path] !== undefined) {
        stack.push(edge.path);
      }
    }
  }
  assert.ok(included.has('src/app/App.tsx'), 'the closure reaches the app, so the check is not vacuous');
  assert.ok(included.has('src/app/shell/WelcomeView.tsx'), 'the start screen is in the first bundle');
  for (const heavy of HEAVY) {
    assert.ok(!included.has(heavy), `${heavy} loads on demand, not in the first bundle`);
  }
});
