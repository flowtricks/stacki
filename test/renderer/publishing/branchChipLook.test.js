// Goal: the branch chip beside Publish and the question asked before publishing from another branch look right in the real
// title bar: quiet dim text with no fill on the default branch, an amber filled chip with readable text (at least 4.5:1) anywhere
// else, a long name cut with an ellipsis (the full name stays in the tooltip), no border on the chip, and the dialog's three
// answers all fit inside it.
// Method: jsdom has no layout, so this bundles the real DesktopPublishButton for the browser, mounts it in a `.titlebar` under the
// app's real stylesheets in ONE hidden Chromium window (as settingsLayout.test.js does), and feeds it what real git says about
// throwaway repositories made for the run (the project is never touched). It reads computed styles and boxes. Set
// STACKI_BRANCH_SHOTS to a folder to also write PNGs of the bar on main, on a feature branch, on a detached HEAD, and the dialog.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
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
  'src/ui/skeleton.css',
  'src/features/publishing/publishing.css',
  'src/features/git/branchIndicator.css',
];

const ENTRY = `
import { createRoot } from 'react-dom/client';
import { DesktopPublishButton } from ${JSON.stringify(repoPath('src/app/shell/DesktopPublishButton.tsx'))};

const info = JSON.parse(decodeURIComponent(location.hash.slice(1)));
window.avb = {
  projectMetadata: async () => ({ ok: true, value: {} }),
  publishAvailability: async () => ({ github: 'pending', hosting: 'unconfigured' }),
  publishState: async () => ({ kind: 'idle' }),
  publishStart: async () => ({ kind: 'done', github: true, hosting: false }),
  gitInfo: async () => info,
  gitCheckout: async () => ({ ok: true, restored: false, from: info.branch, parked: false }),
  onFsChanged: () => () => {},
  onAssetsChanged: () => () => {},
  onCmsChanged: () => () => {},
  onCssChanged: () => () => {},
};
createRoot(document.getElementById('root')).render(
  <div className="titlebar" style={{ width: 760 }}>
    <span className="spacer" />
    <DesktopPublishButton projectPath="/project" flushSave={async () => {}} refresh={async () => {}} saveState={undefined} repository={info} onOpenBranches={() => {}} />
  </div>,
);
`;

const PROBE = `const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
app.disableHardwareAcceleration();
app.on('window-all-closed', () => app.quit());
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const cases = JSON.parse(process.env.STACKI_CASES);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 800, height: 420, backgroundColor: '#191919' });
  const js = (code) => win.webContents.executeJavaScript(code);
  const dir = process.env.STACKI_BRANCH_SHOTS;
  const shoot = async (name) => {
    if (dir) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, name + '.png'), (await win.webContents.capturePage()).toPNG());
    }
  };
  const out = {};
  for (const [name, info] of Object.entries(cases)) {
    await win.loadURL('file://' + path.join(__dirname, 'index.html') + '?case=' + Date.now() + '#' + encodeURIComponent(JSON.stringify(info)));
    await sleep(700);
    out[name] = await js(\`(() => {
      const chip = document.querySelector('.stacki-branch-chip');
      const bar = document.querySelector('.titlebar');
      if (!chip) return { chip: false, barText: bar.textContent };
      const s = getComputedStyle(chip);
      const span = chip.querySelector('span');
      const r = chip.getBoundingClientRect();
      const publish = document.querySelector('.stacki-publish-split').getBoundingClientRect();
      return {
        chip: true, state: chip.dataset.state, text: chip.textContent, title: chip.title,
        color: s.color, background: s.backgroundColor, panel: getComputedStyle(bar).backgroundColor,
        border: s.borderTopWidth, radius: s.borderRadius, height: r.height, width: r.width,
        ellipsis: s.overflow + '|' + getComputedStyle(span).textOverflow, clipped: span.scrollWidth > span.clientWidth,
        leftOfPublish: r.right <= publish.left, gap: publish.left - r.right, sameRow: Math.abs((r.top + r.height / 2) - (publish.top + publish.height / 2)) < 2,
        hasIcon: !!chip.querySelector('svg'),
      };
    })()\`);
    await shoot('bar-' + name);
  }
  // The question: open the menu on the feature branch and start a GitHub push.
  await win.loadURL('file://' + path.join(__dirname, 'index.html') + '?case=' + Date.now() + '#' + encodeURIComponent(JSON.stringify(cases.feature)));
  await sleep(700);
  await js("document.querySelector('[aria-label=\\"More publish options\\"]').click()");
  await sleep(300);
  await js("document.querySelector('.stacki-publish-github > button').click()");
  await sleep(900);
  out.dialog = await js(\`(() => {
    const dialog = document.querySelector('.stacki-branch-warning');
    if (!dialog) return { shown: false };
    const box = dialog.getBoundingClientRect();
    const footer = dialog.querySelector('.modal-footer');
    const buttons = [...footer.querySelectorAll('button')].map((button) => ({ text: button.textContent, ...(() => { const r = button.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, clipped: button.scrollWidth > button.clientWidth }; })() }));
    return { shown: true, title: dialog.querySelector('.modal-header').textContent, body: dialog.querySelector('.modal-body').textContent,
      width: box.width, footerRight: footer.getBoundingClientRect().right, boxRight: box.right, buttons,
      checkbox: !!dialog.querySelector('input[type=checkbox]'), border: getComputedStyle(dialog).borderTopWidth };
  })()\`);
  await shoot('dialog');
  console.log(JSON.stringify(out));
  app.quit();
});`;

// WCAG relative luminance contrast of a CSS rgb()/rgba() text colour over a fill that is itself over the bar.
const parse = (value) => value.match(/[\d.]+/g).map(Number);
const over = (top, bottom) => {
  const [red, green, blue, alpha = 1] = top;
  return [red * alpha + bottom[0] * (1 - alpha), green * alpha + bottom[1] * (1 - alpha), blue * alpha + bottom[2] * (1 - alpha)];
};
const luminance = ([red, green, blue]) => {
  const channel = (value) => {
    const scaled = value / 255;
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
};
const contrast = (first, second) => {
  const [hi, lo] = [luminance(first), luminance(second)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
function realInfo(scratch, name, setup) {
  const directory = fs.mkdtempSync(path.join(scratch, `${name}-`));
  git(directory, 'init', '-q', '-b', 'main', '.');
  git(directory, 'config', 'user.email', 'test@example.com');
  git(directory, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(directory, 'a.txt'), 'x\n');
  git(directory, 'add', '-A');
  git(directory, 'commit', '-qm', 'first');
  setup(directory);
  const branch = git(directory, 'rev-parse', '--abbrev-ref', 'HEAD');
  return {
    isRepo: true,
    branch,
    branches: git(directory, 'branch', '--format=%(refname:short)').split('\n').filter(Boolean),
    remote: 'https://github.com/example/site.git',
    dirty: false,
    ahead: 0,
    parked: [],
    head: git(directory, 'rev-parse', 'HEAD'),
    trunk: 'main',
    defaultBranch: 'main',
  };
}

(() => {
  const electronPath = (() => {
    try {
      return require('electron');
    } catch {
      return undefined;
    }
  })();
  if (typeof electronPath !== 'string') {
    console.log('branch-chip-look: skipped  [needs a Chromium]');
    return;
  }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-branch-look-'));
  const cases = {
    main: realInfo(scratch, 'main', () => {}),
    feature: realInfo(scratch, 'feature', (directory) => git(directory, 'checkout', '-q', '-b', 'feature/x')),
    long: realInfo(scratch, 'long', (directory) =>
      git(directory, 'checkout', '-q', '-b', 'feature/a-really-long-branch-name-that-keeps-going-and-going-forever'),
    ),
    detached: realInfo(scratch, 'detached', (directory) => git(directory, 'checkout', '-q', '--detach')),
    none: { isRepo: false },
  };
  const directory = repoPath('node_modules/.stacki-test/branch-chip-look');
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
  fs.writeFileSync(
    path.join(directory, 'index.html'),
    `<!doctype html><meta charset=utf-8>${SHEETS.map((file) => `<link rel="stylesheet" href="file://${path.join(ROOT, file)}">`).join('')}<style>body{margin:0;background:#191919}*,*::before,*::after{transition:none!important;animation:none!important}.titlebar{margin:24px}</style><div id="root"></div><script defer src="entry.js"></script>`,
  );
  fs.writeFileSync(path.join(directory, 'probe.js'), PROBE);
  // The variable must be absent, not empty: on Windows an empty value still counts as set and Electron then
  // runs as plain Node, where `app` is undefined.
  const environment = { ...process.env, STACKI_CASES: JSON.stringify(cases) };
  delete environment.ELECTRON_RUN_AS_NODE;
  const run = spawnSync(electronPath, [path.join(directory, 'probe.js')], {
    encoding: 'utf8',
    timeout: 120000,
    env: environment,
  });
  fs.rmSync(scratch, { recursive: true, force: true });
  const line = (run.stdout || '').split('\n').find((text) => text.trim().startsWith('{'));
  if (!line) {
    check('the browser probe ran', false, (run.stderr || run.stdout || '').slice(0, 800));
  } else {
    const result = JSON.parse(line);
    const quiet = result.main;
    const warn = result.feature;
    check(
      'main: the chip is drawn with an icon, left of Publish on the same row',
      quiet.chip && quiet.hasIcon && quiet.leftOfPublish && quiet.sameRow,
      JSON.stringify(quiet),
    );
    check(
      'main: quiet state, no fill, no border',
      quiet.state === 'quiet' && /rgba\(0, 0, 0, 0\)|transparent/.test(quiet.background) && quiet.border === '0px',
      JSON.stringify(quiet),
    );
    check('main: dim text still reads at 4.5:1', contrast(parse(quiet.color), parse(quiet.panel)) >= 4.5, JSON.stringify(quiet));
    check('main: the tooltip names the branch', quiet.title === 'Current branch: main' && quiet.text === 'main', JSON.stringify(quiet));
    check(
      'feature: warning state with an amber fill and no border',
      warn.state === 'warning' && !/rgba\(0, 0, 0, 0\)/.test(warn.background) && warn.border === '0px',
      JSON.stringify(warn),
    );
    const fill = over(parse(warn.background), parse(warn.panel));
    check(
      'feature: the text is at least 4.5:1 against its fill',
      contrast(parse(warn.color), fill) >= 4.5,
      `${contrast(parse(warn.color), fill)} ${JSON.stringify(warn)}`,
    );
    check('feature: the name and the full-name tooltip', warn.text === 'feature/x' && warn.title === 'Current branch: feature/x', JSON.stringify(warn));
    check(
      'chips are 24px tall like the Publish button',
      Math.round(quiet.height) === 24 && Math.round(warn.height) === 24,
      JSON.stringify([quiet.height, warn.height]),
    );
    check('the chip sits a few pixels from Publish, not on it', warn.gap >= 4 && warn.gap <= 16, JSON.stringify(warn));
    const long = result.long;
    check(
      'a long name is cut with an ellipsis and the chip stays at its cap',
      long.clipped && long.ellipsis.includes('ellipsis') && long.width <= 161,
      JSON.stringify(long),
    );
    check('a long name keeps its whole text in the tooltip', long.title.endsWith('going-and-going-forever'), JSON.stringify(long));
    const detached = result.detached;
    check('detached HEAD: a warning that says so', detached.state === 'warning' && detached.text === 'Detached HEAD', JSON.stringify(detached));
    check('no repository: no chip at all', result.none.chip === false, JSON.stringify(result.none));
    const dialog = result.dialog;
    check('the question appears on the feature branch', dialog.shown === true && dialog.title === 'Publish from feature/x?', JSON.stringify(dialog));
    if (dialog.shown) {
      check('the question offers "don\'t warn again"', dialog.checkbox === true, JSON.stringify(dialog));
      check(
        'all three answers fit inside it, unclipped and on one row',
        dialog.buttons.length === 3 &&
          dialog.buttons.every((button) => button.right <= dialog.footerRight + 0.5 && !button.clipped && button.top === dialog.buttons[0].top),
        JSON.stringify(dialog),
      );
    }
  }
  if (failures.length) {
    console.error(`branch-chip-look: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`branch-chip-look: ${checked} passed`);
})();
