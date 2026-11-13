// Goal: the Settings screens keep their look and their (i) hints work. Look: each section is a small uppercase dim
// heading over a stack of filled rounded cards; a card puts its title (and its (i)) at the left and its control at the
// right end of the same row; an app's permission rows are one line; the page starts right under its header.
// Hints: hovering, or focusing, an (i) shows its text in a visible `[role=tooltip]` drawn inside the open modal dialog.
// Why inside: a modal <dialog> is in the browser's top layer, which paints over everything outside it whatever the
// z-index, so a tip appended to the body was invisible behind Settings (the bug this test pins).
// Method: jsdom has neither layout nor a top layer, so this bundles the real SettingsLayout, Switch, Dropdown and
// InfoHint for the browser, mounts them with React in a modal <dialog> under the app's real stylesheets in a hidden
// Chromium window (as splitButtonStyle.test.js does), moves a real pointer over each (i) with sendInputEvent, waits for
// the tooltip delay, and reads boxes, computed styles and the tooltip. Set STACKI_SETTINGS_SHOTS to a folder to also
// write PNGs (the Editor settings, Roles permissions and Audits rows with a tip showing), so the look can be checked by eye.
const fs = require('fs');
const path = require('path');
const { buildSync } = require('esbuild');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};

const SHEETS = [
  'src/features/style/tokens.css',
  'src/app/styles.css',
  'src/ui/popup.css',
  'src/ui/switch.css',
  'src/ui/dropdown.css',
  'src/ui/infoHint.css',
  'src/app/settings/settings.css',
  'src/app/settings/roles.css',
  'src/features/audits/audits.css',
  'src/features/projectSettings/projectSettings.css',
  'src/features/projectSettings/mcp.css',
];

const TIPS = {
  language: 'Language of menus and labels.',
  track: 'Snapshots each AI turn to show changes and diffs.',
  permission: 'Add a marker class to an element so GA4 reports its clicks exactly.',
  audit: 'Screen readers announce the file name, or nothing, instead of what the image shows.',
};

const ENTRY = `
import { createRoot } from 'react-dom/client';
import { SettingsRow, SettingsSaveRow, SettingsSection } from ${JSON.stringify(repoPath('src/app/settings/SettingsLayout.tsx'))};
import { Switch } from ${JSON.stringify(repoPath('src/ui/Switch.tsx'))};
import Dropdown from ${JSON.stringify(repoPath('src/ui/Dropdown.tsx'))};
import InfoHint from ${JSON.stringify(repoPath('src/ui/InfoHint.tsx'))};

const TIPS = ${JSON.stringify(TIPS)};
const noop = () => {};
const toggle = (label, info, probe) => (
  <SettingsRow label={label} {...(info ? { info } : {})}>
    <Switch label={label} checked={true} disabled={false} onToggle={noop} />
  </SettingsRow>
);
function Page() {
  return (
    <div className="app-settings" style={{ position: 'relative', display: 'block' }}>
      <div className="app-settings-layout">
        <nav className="app-settings-sidebar"><h2>Settings</h2><div className="app-settings-tabs"><button role="tab" aria-selected="true">Editor settings</button><button role="tab">Folders</button></div></nav>
        <div className="app-settings-main">
          <header className="app-settings-header"><h3>Editor settings</h3></header>
          <div className="app-settings-scroll"><div className="app-settings-content">
            <div className="app-settings-panel"><section className="app-preferences">
              <SettingsSaveRow saving="idle" />
              <SettingsSection title="General">
                <SettingsRow label="Language" info={TIPS.language}>
                  <Dropdown ariaLabel="Language" value="system" options={[{ value: 'system', label: 'System default' }]} onChange={noop} />
                </SettingsRow>
                {toggle('Interface sounds')}
              </SettingsSection>
              <SettingsSection title="AI">
                {toggle('Ask before allowing agents in a new project', 'Off: opening AI chat in a project lets Claude and Codex work there.')}
                {toggle('Track changes per turn', TIPS.track)}
              </SettingsSection>
              <SettingsSection title="Privacy" info="What leaves this computer.">
                {toggle('Anonymous usage counts', 'One count on days you open a project.')}
              </SettingsSection>
            </section></div>
            <div className="app-role-group" id="roles">
              <div className="app-role-toggle app-role-app-permission"><span className="app-role-app-permission-text"><span className="app-role-toggle-label">All permissions</span></span><Switch label="All" checked={false} disabled={false} onToggle={noop} /></div>
              <div className="app-role-toggle app-role-app-permission"><span className="app-role-app-permission-text"><span className="app-role-toggle-label">Track elements<InfoHint text={TIPS.permission} /></span></span><Switch label="Track" checked={true} disabled={false} onToggle={noop} /></div>
            </div>
            <div className="audits-settings" id="audits"><div className="app-role-toggle audits-settings-row"><span className="app-role-toggle-icon" aria-hidden="true" /><span className="app-role-app-permission-text"><span className="app-role-toggle-label">Missing alt text<InfoHint text={TIPS.audit} /></span></span><Switch label="Alt" checked={true} disabled={false} onToggle={noop} /></div></div>
          </div></div>
        </div>
      </div>
    </div>
  );
}
const dialog = document.createElement('dialog');
dialog.className = 'popup-dialog';
document.body.append(dialog);
createRoot(dialog).render(<Page />);
dialog.showModal();
`;

const PROBE = `const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
app.disableHardwareAcceleration();
app.on('window-all-closed', () => app.quit());
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1000, height: 760 });
  await win.loadFile(path.join(__dirname, 'index.html'));
  await sleep(400);
  const js = (code) => win.webContents.executeJavaScript(code);
  const measured = await js(\`(() => {
    const box = (element) => element.getBoundingClientRect();
    const style = (element) => getComputedStyle(element);
    const row = document.querySelector('.app-settings-row');
    const rows = [...document.querySelectorAll('.app-settings-section')[0].querySelectorAll('.app-settings-row')];
    const heading = document.querySelector('.app-settings-section-header h4');
    const text = row.querySelector('.app-settings-row-text');
    const control = row.querySelector('.app-settings-row-control');
    const permission = [...document.querySelectorAll('.app-role-app-permission')];
    const firstSection = document.querySelector('.app-settings-section');
    const sections = document.querySelectorAll('.app-settings-section');
    return {
      rowBg: style(row).backgroundColor, rowRadius: style(row).borderRadius, rowHeight: box(row).height,
      textLeft: box(text).left - box(row).left, controlRightGap: box(row).right - box(control).right,
      controlWidthShare: box(control).width / box(row).width, rowGap: box(rows[1]).top - box(rows[0]).bottom,
      headingTransform: style(heading).textTransform, headingSize: style(heading).fontSize, headingWeight: style(heading).fontWeight,
      sectionGap: box(sections[1]).top - box(sections[0]).bottom,
      permissionHeights: permission.map((element) => Math.round(box(element).height)),
      permissionTitleRight: permission.map((element) => box(element.querySelector('.app-role-toggle-label')).right <= box(element.querySelector('button[role=switch]')).left),
      topGap: box(firstSection).top - box(document.querySelector('.app-settings-header')).bottom,
      sidebarLeft: box(document.querySelector('.app-settings-sidebar h2')).left,
      modal: document.querySelector('dialog').matches(':modal'),
    };
  })()\`);
  const dir = process.env.STACKI_SETTINGS_SHOTS;
  const shoot = async (name) => {
    if (dir) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, name + '.png'), (await win.webContents.capturePage()).toPNG());
    }
  };
  // Each (i) is found by the row it belongs to; the pointer is a real one, moved in steps.
  const targets = {
    language: '.app-settings-row:nth-of-type(1) .settings-info',
    track: '.app-settings-section:nth-of-type(2) .app-settings-row:nth-of-type(2) .settings-info',
    permission: '#roles .settings-info',
    audit: '#audits .settings-info',
  };
  const tips = {};
  for (const [name, selector] of Object.entries(targets)) {
    const point = await js(\`(() => { const e = document.querySelector(\${JSON.stringify(selector)}); if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()\`);
    if (!point) { tips[name] = { missing: true }; continue; }
    win.webContents.sendInputEvent({ type: 'mouseMove', x: point.x - 30, y: point.y });
    win.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
    await sleep(900);
    tips[name] = await js(\`(() => {
      const tip = document.querySelector('[role=tooltip]');
      if (!tip) return { shown: false };
      const r = tip.getBoundingClientRect();
      const s = getComputedStyle(tip);
      return { shown: true, text: tip.textContent, left: r.left, top: r.top, width: r.width, height: r.height, z: s.zIndex,
        inDialog: tip.closest('dialog') !== null, visible: s.visibility === 'visible' && s.display !== 'none' && Number(s.opacity) > 0,
        inViewport: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight };
    })()\`);
    await shoot('settings-tip-' + name);
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 5, y: 5 });
    await sleep(100);
  }
  // Keyboard focus shows the tip with no wait.
  win.webContents.focus();
  await js(\`document.querySelector(\${JSON.stringify(targets.track)}).focus()\`);
  await sleep(50);
  const focusTip = await js(\`(() => { const tip = document.querySelector('[role=tooltip]'); return tip ? { shown: true, text: tip.textContent } : { shown: false }; })()\`);
  await shoot('settings-tip-focus');
  console.log(JSON.stringify({ measured, tips, focusTip }));
  app.quit();
});`;

(() => {
  const electronPath = (() => {
    try {
      return require('electron');
    } catch {
      return undefined;
    }
  })();
  if (typeof electronPath !== 'string') {
    console.log('settings-layout: skipped  [needs a Chromium]');
    return;
  }
  const directory = repoPath('node_modules/.stacki-test/settings-layout');
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
    loader: { '.css': 'empty' },
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'silent',
  });
  fs.writeFileSync(path.join(directory, 'app.css'), SHEETS.map((file) => fs.readFileSync(path.join(ROOT, file), 'utf8')).join('\n'));
  fs.writeFileSync(
    path.join(directory, 'index.html'),
    '<!doctype html><meta charset=utf-8><link rel="stylesheet" href="app.css"><style>body{margin:0;background:#0d0d0d}*,*::before,*::after{transition:none!important}.app-settings{margin:20px!important;width:900px!important;height:700px!important}</style><script defer src="entry.js"></script>',
  );
  fs.writeFileSync(path.join(directory, 'probe.js'), PROBE);
  const { spawnSync } = require('child_process');
  // The variable must be absent, not empty: on Windows an empty value still counts as set and Electron then
  // runs as plain Node, where `app` is undefined.
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const run = spawnSync(electronPath, [path.join(directory, 'probe.js')], {
    encoding: 'utf8',
    timeout: 120000,
    env: environment,
  });
  const line = (run.stdout || '').split('\n').find((text) => text.trim().startsWith('{'));
  if (!line) {
    check('the browser probe ran', false, (run.stderr || run.stdout || '').slice(0, 800));
  } else {
    const { measured: match, tips, focusTip } = JSON.parse(line);
    const detail = JSON.stringify(match);
    check('the page is in a modal dialog (the top layer)', match.modal === true, detail);
    check('a row is a filled card', match.rowBg !== 'rgba(0, 0, 0, 0)' && match.rowBg !== 'transparent', detail);
    check('a row has rounded corners', match.rowRadius === '8px', detail);
    check('a row is at least 44px tall and not stacked', match.rowHeight >= 44 && match.rowHeight < 70, detail);
    check('the title sits at the left padding', match.textLeft >= 11 && match.textLeft <= 17, detail);
    check('the control ends the row at the right', match.controlRightGap >= 11 && match.controlRightGap <= 17, detail);
    check('the dropdown does not span the row', match.controlWidthShare < 0.5, detail);
    check('cards are 8px apart', match.rowGap === 8, detail);
    check('sections are 24px apart', match.sectionGap === 24, detail);
    check(
      'a section heading is small, uppercase and semibold',
      match.headingTransform === 'uppercase' && match.headingSize === '11px' && Number(match.headingWeight) >= 600,
      detail,
    );
    check(
      'permission rows are one line each',
      match.permissionHeights.every((height) => height <= 36),
      detail,
    );
    check('a permission title and its (i) sit left of its switch', match.permissionTitleRight.every(Boolean), detail);
    check('the page starts close under the header', match.topGap >= 0 && match.topGap <= 40, detail);
    check('the sidebar title is inset from the dialog edge', match.sidebarLeft >= 20, detail);
    // Hover needs pointer input that GitHub's Linux (xvfb) and Windows hidden windows never deliver (see
    // appUiKitTooltip), so the hover checks run on macOS only; the keyboard-focus check below runs everywhere.
    const hoverTips = process.platform === 'darwin' ? Object.entries(TIPS) : [];
    for (const [name, text] of hoverTips) {
      const tip = tips[name];
      const why = JSON.stringify(tip);
      check(`${name}: hovering the (i) shows a tooltip`, tip?.shown === true, why);
      if (tip?.shown === true) {
        check(`${name}: the tooltip says the hint`, tip.text === text, why);
        check(`${name}: it is drawn inside the modal dialog, so the top layer cannot hide it`, tip.inDialog === true, why);
        check(`${name}: it is visible, has a size and is inside the window`, tip.visible && tip.width > 40 && tip.height > 10 && tip.inViewport, why);
        check(`${name}: it is above popups`, Number(tip.z) >= 10001, why);
      }
    }
    check('keyboard focus on the (i) shows its tooltip at once', focusTip?.shown === true && focusTip.text === TIPS.track, JSON.stringify(focusTip));
  }
  if (failures.length) {
    console.error(`settings-layout: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`settings-layout: ${checked} passed  [real layout]`);
})();
