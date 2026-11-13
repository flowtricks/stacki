// Goal: the first frame is a spinner on the dark surface and the first bundle stays small. index.html
// paints one ring on the app's dark colour before any script runs, the app's script starts after that frame,
// and the modules that only a project window or a closed dialog need (the editor shell, Settings, the
// panels) are reached by dynamic import only, so a cold start parses none of them (docs/startup.md).
// Method: index.html is read as text (spinner, colours, deferred start); the real renderer entry is
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

test('index.html paints one ring on the dark surface before any script, outside #root', () => {
  const spinner = html.indexOf('id="boot-spinner"');
  assert.ok(spinner >= 0, 'the spinner is in the HTML itself');
  assert.ok(spinner < html.indexOf('<script'), 'and precedes every script, so it needs no JS to appear');
  assert.ok(spinner < html.indexOf('<div id="root">'), 'it is a sibling of #root, so the first render does not cut it off');
  const markup = html.slice(html.lastIndexOf('<div', spinner), html.indexOf('<script', spinner));
  assert.doesNotMatch(markup.replace(/<[^>]*>/g, '').trim(), /\S/, 'no text, no logo');
  assert.equal((markup.match(/class="boot-ring"/g) ?? []).length, 1, 'one ring');
  assert.match(html, /animation: boot-spin/, 'it turns, in CSS alone');
  assert.match(html, /prefers-reduced-motion: reduce/, 'and holds still when asked');
  assert.match(html, /transition: opacity 120ms/, 'it fades out');
  assert.doesNotMatch(html, /<img|<svg|<h1|<p>/, 'no logo, no words');
});

test('the dark surface is the panel colour and the window colour, and the app starts after a frame', () => {
  const surface = '#111111';
  assert.ok(html.includes(`background: ${surface}`), 'the page is the dark surface');
  assert.ok(styles.includes(`--bg-panel: ${surface}`), 'which is the panel surface');
  assert.ok(main.includes(`backgroundColor: '${surface}'`), 'which is the window background');
  assert.ok(main.includes('show: false'), 'the window is shown on its first frame');
  assert.ok(html.includes("void import('/src/main.tsx')"), 'the app is imported after a frame');
  assert.ok(!html.includes('<script type="module" src='), 'no eager module script');
  assert.ok(marks.includes("getElementById('boot-spinner')"), 'the app removes the spinner once it has painted');
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
  assert.ok(included.has('src/app/shell/ShellSkeleton.tsx'), 'and so is the project window skeleton');
  for (const heavy of HEAVY) {
    assert.ok(!included.has(heavy), `${heavy} loads on demand, not in the first bundle`);
  }
});
