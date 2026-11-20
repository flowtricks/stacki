// Goal: the Settings panel draws like the other panels, and fits. The root is a short list of full-width ROWS (not
// buttons): transparent at rest, the icon first, the label left-aligned right after it, the muted chevron at the far
// end, the same row height as the Pages list, and the icons on the same left edge as the title's row inset. Each view
// (Secrets, MCP, Instructions) replaces the list under a header with a back chevron and its title. At 260, 340 and
// 600px wide neither the root nor any view overflows sideways, and no row's content spills past its right edge.
// Method: jsdom has no layout, so this bundles the real panel (frame, Secrets and MCP views, Instructions sections)
// for the browser over a fake `window.avb`, mounts it under the app's real stylesheets in a hidden Chromium window at
// each width, clicks each link as a person would, and reads boxes and computed styles. Set STACKI_SETTINGS_SHOTS to a
// folder to also write PNGs of the root and each view at each width.
const fs = require('fs');
const path = require('path');
const { buildSync } = require('esbuild');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const SHEETS = [
  'src/features/style/tokens.css',
  'src/app/styles.css',
  'src/ui/controls.css',
  'src/ui/menu.css',
  'src/ui/panelHeader.css',
  'src/ui/segmentedTabs.css',
  'src/ui/popup.css',
  'src/ui/dropdown.css',
  'src/ui/infoHint.css',
  'src/ui/panelSection.css',
  'src/features/instructions/instructions.css',
  'src/features/projectSettings/projectSettings.css',
  'src/features/projectSettings/mcp.css',
];
const WIDTHS = [260, 340, 600];

const ENTRY = `
import { createRoot } from 'react-dom/client';
import ProjectSettingsPanel from ${JSON.stringify(repoPath('src/features/projectSettings/ProjectSettingsPanel.tsx'))};
import InstructionsSections from ${JSON.stringify(repoPath('src/features/instructions/InstructionsSections.tsx'))};

const digest = 'a'.repeat(64);
const entry = (index, name) => ({ index, name, duplicate: false, multiline: false });
window.avb = {
  listSecrets: async ({ file }) => ({ ok: true, value: { file, revision: digest, exists: true, entries: file === '.env' ? [entry(0, 'STRIPE_SECRET_KEY'), entry(1, 'SANITY_API_READ_TOKEN_PRODUCTION')] : [], invalidLines: 0, ignore: 'ignored' } }),
  readMcp: async () => ({ ok: true, value: { revision: digest, exists: true, servers: [{ name: 'sanity', status: 'server', summary: { transport: 'http', host: 'mcp.sanity.io', headers: [], secretNames: [] } }] } }),
  readMcpCodex: async () => ({ state: 'missing' }),
  listSecretNames: async () => ({ ok: true, value: [] }),
  listInstructions: async () => ({
    files: [
      { path: '.claude/skills/lumos-audit-props/SKILL.md', section: 'skills', sizeBytes: 10, skill: { kind: 'valid', name: 'lumos-audit-props', description: 'Audits props.' } },
      { path: 'AGENTS.md', section: 'rules', sizeBytes: 10 },
      { path: 'LUMOS.md', section: 'docs', sizeBytes: 10 },
    ],
    folders: [],
    truncated: false,
  }),
  onInstructionsChanged: () => () => {},
  projectMetadata: async () => ({ ok: true, value: {} }),
};
function Page() {
  return (
    <div id="host" style={{ width: Number(new URLSearchParams(location.search).get('w')) }}>
      <ProjectSettingsPanel
        projectPath="/project"
        views={['secrets', 'mcp', 'instructions']}
        shortcuts={{ secrets: '⌥E', mcp: '⌥M', instructions: '⌥I' }}
        renderInstructions={(context) => <InstructionsSections projectPath="/project" context={context} />}
      />
    </div>
  );
}
createRoot(document.getElementById('root')).render(<Page />);
`;

const PROBE = `const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
app.disableHardwareAcceleration();
const { pollUntil, waitFor } = require(${JSON.stringify(repoPath('test/helpers/waitFor.js'))});
process.on('unhandledRejection', (error) => {
  console.error('probe failed: ' + String((error && error.stack) || error));
  app.exit(1);
});
const WIDTHS = ${JSON.stringify(WIDTHS)};
app.whenReady().then(async () => {
  const results = [];
  const win = new BrowserWindow({ show: false, width: 800, height: 600 });
  for (const width of WIDTHS) {
    await win.loadURL('file://' + path.join(__dirname, 'index.html') + '?w=' + width);
    const js = (code) => win.webContents.executeJavaScript(code);
    await waitFor({ what: 'the root links', read: () => js("document.querySelectorAll('.settings-link').length"), until: (count) => count === 3 });
    const dir = process.env.STACKI_SETTINGS_SHOTS;
    const shoot = async (name) => {
      if (dir) {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, name + '-' + width + '.png'), (await win.webContents.capturePage()).toPNG());
      }
    };
    const overflow = "(() => { const b = document.querySelector('.panel-body'); const h = document.querySelector('#host'); return { body: b.scrollWidth - b.clientWidth, host: h.scrollWidth - h.clientWidth }; })()";
    const root = await js(\`(() => {
      const box = (e) => e.getBoundingClientRect();
      const link = document.querySelector('.settings-link');
      const icon = link.querySelector('.icon');
      const label = link.querySelector('.label');
      const chevron = link.lastElementChild;
      const title = document.querySelector('.panel-header h2');
      const style = getComputedStyle(link);
      return {
        bg: style.backgroundColor, textAlign: getComputedStyle(label).textAlign, justify: style.justifyContent, height: box(link).height,
        gapIconLabel: box(label).left - box(icon).right, chevronGap: box(link).right - box(chevron).right,
        labelsAfterIcon: [...document.querySelectorAll('.settings-link')].every((l) => Math.abs(l.querySelector('.label').getBoundingClientRect().left - l.querySelector('.icon').getBoundingClientRect().right - 8) < 1.5),
        titleLeft: box(title).left, iconLeft: box(icon).left, rows: document.querySelectorAll('.settings-link').length,
        hintBeforeChevron: [...document.querySelectorAll('.settings-link')].every((l) => { const k = l.querySelector('.settings-link-key'); return k !== null && k.getBoundingClientRect().right <= l.lastElementChild.getBoundingClientRect().left && k.getBoundingClientRect().left > l.querySelector('.label').getBoundingClientRect().left; }),
        chevronColor: getComputedStyle(chevron).color, labelColor: getComputedStyle(label).color,
      };
    })()\`);
    const rootOverflow = await js(overflow);
    await shoot('settings-root');
    const views = {};
    for (const [index, name] of ['secrets', 'mcp', 'instructions'].entries()) {
      await js(\`document.querySelectorAll('.settings-link')[\${index}].click()\`);
      await waitFor({ what: name + ' view', read: () => js("document.querySelector('.settings-link') === null && document.querySelector('.panel-header button') !== null"), until: (shown) => shown });
      await pollUntil({ what: name + ' drawn', read: () => js("document.querySelector('.panel-body').textContent.length > 20"), until: (drawn) => drawn });
      views[name] = {
        title: await js("document.querySelector('.panel-header h2').textContent"),
        back: await js("(() => { const b = document.querySelector('.panel-header button'); const r = b.getBoundingClientRect(); const t = document.querySelector('.panel-header h2').getBoundingClientRect(); return { left: r.left, before: r.right <= t.left + 1 }; })()"),
        overflow: await js(overflow),
        spill: await js("[...document.querySelectorAll('.panel-body *')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.right > document.querySelector('#host').getBoundingClientRect().right + 1; }).slice(0, 3).map((e) => e.className || e.tagName)"),
      };
      await shoot('settings-' + name);
      await js("document.querySelector('.panel-header button').click()");
      await waitFor({ what: 'back at the root', read: () => js("document.querySelectorAll('.settings-link').length"), until: (count) => count === 3 });
    }
    results.push({ width, root, rootOverflow, views });
  }
  console.log(JSON.stringify(results));
  app.quit();
});`;

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};

(() => {
  const electronPath = (() => {
    try {
      return require('electron');
    } catch {
      return undefined;
    }
  })();
  if (typeof electronPath !== 'string') {
    console.log('settings-panel-layout: skipped  [needs a Chromium]');
    return;
  }
  const directory = repoPath('node_modules/.stacki-test/settings-panel-layout');
  fs.mkdirSync(directory, { recursive: true });
  const entry = path.join(directory, 'entry.tsx');
  fs.writeFileSync(entry, ENTRY);
  buildSync({
    entryPoints: [entry],
    outfile: path.join(directory, 'entry.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    jsx: 'automatic',
    loader: { '.css': 'empty', '.svg': 'empty' },
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'silent',
  });
  fs.writeFileSync(path.join(directory, 'app.css'), SHEETS.map((file) => fs.readFileSync(path.join(ROOT, file), 'utf8')).join('\n'));
  fs.writeFileSync(
    path.join(directory, 'index.html'),
    '<!doctype html><meta charset=utf-8><link rel="stylesheet" href="app.css"><style>body{margin:0;background:#0d0d0d;color:#ddd}*,*::before,*::after{transition:none!important}#host{height:560px;display:flex;flex-direction:column;background:var(--bg-panel)}</style><div id="root"></div><script defer src="entry.js"></script>',
  );
  fs.writeFileSync(path.join(directory, 'probe.js'), PROBE);
  const { spawnSync } = require('child_process');
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const run = spawnSync(electronPath, [path.join(directory, 'probe.js')], { encoding: 'utf8', timeout: 180000, env: environment });
  const line = (run.stdout || '').split('\n').find((text) => text.trim().startsWith('['));
  if (!line) {
    check('the browser probe ran', false, (run.stderr || run.stdout || '').slice(0, 800));
  } else {
    for (const { width, root, rootOverflow, views } of JSON.parse(line)) {
      const at = `${width}px`;
      const detail = JSON.stringify(root);
      check(`${at}: the root lists three rows`, root.rows === 3, detail);
      check(`${at}: a row is transparent at rest, not a card`, root.bg === 'rgba(0, 0, 0, 0)' || root.bg === 'transparent', detail);
      check(`${at}: the label is left-aligned`, root.textAlign !== 'center' && root.justify !== 'center', detail);
      check(`${at}: the label follows its icon by the list gap`, root.labelsAfterIcon === true, detail);
      check(`${at}: the row is the list's height`, root.height >= 28 && root.height <= 34, detail);
      check(`${at}: the chevron ends the row`, root.chevronGap >= 4 && root.chevronGap <= 14, detail);
      check(`${at}: each row shows its chord, muted, before the chevron`, root.hintBeforeChevron === true, detail);
      check(`${at}: the chevron is muted against the label`, root.chevronColor !== root.labelColor, detail);
      check(`${at}: icons sit within the title's row inset`, Math.abs(root.iconLeft - root.titleLeft) <= 12, detail);
      check(`${at}: the root does not scroll sideways`, rootOverflow.body <= 0 && rootOverflow.host <= 0, JSON.stringify(rootOverflow));
      for (const [name, view] of Object.entries(views)) {
        const why = JSON.stringify(view);
        check(`${at}: ${name} opens under its title`, view.title.length > 0 && view.title !== 'Settings', why);
        check(`${at}: ${name} has a back chevron before its title`, view.back.before === true, why);
        check(`${at}: ${name} does not scroll sideways`, view.overflow.body <= 0 && view.overflow.host <= 0, why);
        check(`${at}: nothing in ${name} spills past the panel`, view.spill.length === 0, why);
      }
    }
  }
  if (failures.length > 0) {
    console.error(`settings-panel-layout: ${failures.length} of ${checked} checks failed\n${failures.join('\n')}`);
    process.exitCode = 1;
  } else {
    console.log(`settings-panel-layout: ${checked} checks passed`);
  }
})();
