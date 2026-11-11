// The shared split button (src/ui/SplitButton.tsx) reads as one button wherever
// it is used: the welcome screen's "Open from folder ⌄" and "Start from Lumos ⌄".
//
//   node test/renderer/ui/splitButtonStyle.test.js
//
// Goal: pin the look a user once saw break. Hovering a chevron filled it with the
// app's accent blue beside a grey main half (on the Apps panel's copy, since
// removed), and the chevron was a wide slab rather than a compact segment. So, in every place the button is used:
//   - the welcome pair keeps the size it had before it moved onto the shared
//     component: one line of 12.5px type with 9px block padding (about 35px
//     tall), a chevron sized by its 9px 11px padding (about 37px wide), and
//     10px outer corners. A square chevron
//     (aspect-ratio: 1) once lost its side padding to `.welcome .actions
//     button`, grew with the pair's height, squeezed the label onto two
//     lines, and the buttons rendered about 100px tall;
//   - both segments rest on the same background;
//   - hovering a segment brightens just that segment, in the button's own tone:
//     the hovered chevron is never the accent, and its sibling does not change;
//   - keyboard focus draws a ring, and an open menu keeps both halves in one tone.
//
// Methodology: jsdom has no layout or cascade, so this renders the real
// components with react-dom/server, loads them under the app's stylesheets in
// a hidden Chromium window, and reads computed styles. The stylesheets load in
// both orders: a production bundle can put a feature's sheet before styles.css,
// and the broken hover came from exactly that order, where the base
// `button:hover` rule tied the feature's rule and won. Hover, focus-visible
// and the open state are forced through the DevTools protocol rather than a
// pointer, so nothing depends on timing; transitions are switched off so the
// computed colour is the settled one.
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

// Every place the split button appears, by the selector of its group.
const PLACES = [
  { name: 'welcome primary', group: '#welcome-primary .welcome-split-button' },
  { name: 'welcome secondary', group: '#welcome-secondary .welcome-split-button' },
];

function bundle(pageDirectory, name, entry) {
  const outfile = path.join(pageDirectory, `${name}.cjs`);
  buildSync({
    entryPoints: [repoPath(entry)],
    outfile,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    loader: { '.css': 'empty' },
    logLevel: 'silent',
  });
  return require(outfile);
}

function markup(pageDirectory) {
  const React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const WelcomeSplitButton = bundle(pageDirectory, 'welcome', 'src/features/welcome/WelcomeSplitButton.tsx').default;
  const welcome = (className) =>
    renderToStaticMarkup(
      React.createElement(WelcomeSplitButton, {
        className,
        label: 'Open from folder',
        menuLabel: 'Open from GitHub',
        menuTitle: 'More ways to open a project',
        onClick() {},
        onMenuSelect() {},
      }),
    );
  // The closed menu's popup uses layout effects, which a server render skips; its warning is expected here.
  const consoleError = console.error;
  console.error = () => {};
  const welcomePrimary = welcome('primary');
  const welcomeSecondary = welcome('');
  console.error = consoleError;
  return (
    '<div class="welcome" style="background:#2b0554;padding:20px"><div class="actions"><div class="actions-row">' +
    `<div id="welcome-primary">${welcomePrimary}</div><div id="welcome-secondary">${welcomeSecondary}</div>` +
    '</div></div></div>'
  );
}

// The welcome pair's size before it moved onto the shared component (release
// 1.0.24). The pixels depend on the platform's font, so the pins are built from
// the parts: one line of type, the 9px block and 11px side padding, a 1px edge
// on each side, and the 13px chevron icon. The slack absorbs sub-pixel font
// metrics; a second line of text or a square chevron is far outside it.
const WELCOME_EDGE_PX = 1;
const WELCOME_ICON_PX = 13;
const WELCOME_PADDING_BLOCK_PX = 9;
const WELCOME_PADDING_INLINE_PX = 11;
const WELCOME_SLACK_PX = 2;
const welcomeHeightPxMax = (lineHeightPx) => Math.ceil(lineHeightPx) + 2 * (WELCOME_PADDING_BLOCK_PX + WELCOME_EDGE_PX) + WELCOME_SLACK_PX;
const WELCOME_ARROW_WIDTH_PX_MAX = WELCOME_ICON_PX + 2 * (WELCOME_PADDING_INLINE_PX + WELCOME_EDGE_PX) + WELCOME_SLACK_PX;

// The app's stylesheets, in the two orders a bundle can emit them.
const BASE_SHEETS = ['src/features/style/tokens.css', 'src/app/styles.css'];
// The welcome screen's rules live in styles.css; the Apps sheet stays in so a
// rule of its own can never reach the shared button again.
const FEATURE_SHEETS = ['src/features/apps/apps.css'];
const ORDERS = {
  'base first': [...BASE_SHEETS, ...FEATURE_SHEETS],
  'feature first': ['src/features/style/tokens.css', ...FEATURE_SHEETS, 'src/app/styles.css'],
};

const PROBE = `const { app, BrowserWindow } = require('electron');
const path = require('path');
const PLACES = ${JSON.stringify(PLACES)};
const ORDERS = ${JSON.stringify(Object.keys(ORDERS))};
app.disableHardwareAcceleration();
app.on('window-all-closed', () => app.quit());
app.whenReady().then(async () => {
  const results = {};
  for (const [orderIndex, order] of ORDERS.entries()) {
    results[order] = await measure(path.join(__dirname, 'index-' + orderIndex + '.html'));
  }
  console.log(JSON.stringify(results));
  app.quit();
});
async function measure(page) {
  const win = new BrowserWindow({ show: false, width: 800, height: 600 });
  await win.loadFile(page);
  const cdp = win.webContents.debugger;
  // The Linux preflight's slow-motion profile may already hold the protocol; share it.
  if (!cdp.isAttached()) {
    cdp.attach('1.3');
  }
  await cdp.sendCommand('DOM.enable');
  await cdp.sendCommand('CSS.enable');
  const { root } = await cdp.sendCommand('DOM.getDocument', { depth: -1 });
  const node = async (selector) => (await cdp.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector })).nodeId;
  const force = async (selector, classes) => cdp.sendCommand('CSS.forcePseudoState', { nodeId: await node(selector), forcedPseudoClasses: classes });
  const read = (group) => win.webContents.executeJavaScript(\`(() => {
    const group = document.querySelector(\${JSON.stringify(group)});
    const [main, arrow] = group.querySelectorAll(':scope > button');
    const style = (element) => getComputedStyle(element);
    const box = (element) => element.getBoundingClientRect();
    return {
      mainBg: style(main).backgroundColor,
      arrowBg: style(arrow).backgroundColor,
      arrowOutline: style(arrow).outlineStyle + ' ' + style(arrow).outlineWidth,
      arrowWidth: Math.round(box(arrow).width),
      arrowHeight: Math.round(box(arrow).height),
      mainHeight: Math.round(box(main).height),
      mainFontSize: style(main).fontSize,
      mainLineHeight: (() => {
        // 'normal' has no number: measure one line of the label's own type.
        const probe = document.createElement('span');
        probe.textContent = 'Open';
        probe.style.font = style(main).font;
        probe.style.lineHeight = style(main).lineHeight;
        probe.style.display = 'block';
        document.body.append(probe);
        const height = probe.getBoundingClientRect().height;
        probe.remove();
        return height;
      })(),
      mainRadius: style(main).borderRadius,
      arrowPadding: style(arrow).padding,
      arrowRadius: style(arrow).borderRadius,
      iconOffset: Math.round(box(arrow.querySelector('svg')).left + box(arrow.querySelector('svg')).width / 2 - box(arrow).left - box(arrow).width / 2),
    };
  })()\`);
  const accent = await win.webContents.executeJavaScript(
    \`(() => { const probe = document.createElement('i'); probe.style.background = 'var(--accent)'; document.body.append(probe); const value = getComputedStyle(probe).backgroundColor; probe.remove(); return value; })()\`,
  );
  const result = { accent, places: {} };
  for (const place of PLACES) {
    const arrow = place.group + ' > .welcome-split-arrow';
    const main = place.group + ' > button:first-child';
    const rest = await read(place.group);
    await force(arrow, ['hover']);
    const arrowHover = await read(place.group);
    await force(arrow, []);
    await force(main, ['hover']);
    const mainHover = await read(place.group);
    await force(main, []);
    await force(arrow, ['focus', 'focus-visible']);
    const arrowFocus = await read(place.group);
    await force(arrow, []);
    // The open state as the popup marks it: the menu present, its phase open.
    await win.webContents.executeJavaScript(\`(() => {
      const menu = document.createElement('div');
      menu.className = 'popup-surface welcome-split-menu';
      menu.dataset.popupPhase = 'open';
      document.querySelector(\${JSON.stringify(place.group)}).append(menu);
    })()\`);
    const open = await read(place.group);
    await force(arrow, ['hover']);
    const openArrowHover = await read(place.group);
    await force(arrow, []);
    await win.webContents.executeJavaScript(\`document.querySelector(\${JSON.stringify(place.group)} + ' > .welcome-split-menu').remove()\`);
    result.places[place.name] = { rest, arrowHover, mainHover, arrowFocus, open, openArrowHover };
  }
  cdp.detach();
  // The window stays until the app quits: closing the last one would quit it mid-run.
  return result;
}`;

(() => {
  const electronPath = (() => {
    try {
      return require('electron');
    } catch {
      return undefined;
    }
  })();
  if (typeof electronPath !== 'string') {
    console.log('split-button-style: skipped  [needs a Chromium — see test/renderer/style/computedColor.test.js]');
    return;
  }
  const pageDirectory = repoPath('node_modules/.stacki-test/split-button-style');
  fs.mkdirSync(pageDirectory, { recursive: true });
  const body = markup(pageDirectory);
  for (const [orderIndex, sheets] of Object.values(ORDERS).entries()) {
    fs.writeFileSync(path.join(pageDirectory, `app-${orderIndex}.css`), sheets.map((file) => fs.readFileSync(path.join(ROOT, file), 'utf8')).join('\n'));
    fs.writeFileSync(
      path.join(pageDirectory, `index-${orderIndex}.html`),
      `<!doctype html><meta charset=utf-8><link rel="stylesheet" href="app-${orderIndex}.css">` +
        '<style>body{margin:0;background:#1a1a1a}*,*::before,*::after{transition:none!important}</style>' +
        body,
    );
  }
  const probe = path.join(pageDirectory, 'probe.js');
  fs.writeFileSync(probe, PROBE);
  const { spawnSync } = require('child_process');
  const run = spawnSync(electronPath, [probe], { encoding: 'utf8', timeout: 120000 });
  const line = (run.stdout || '').split('\n').find((text) => text.trim().startsWith('{'));
  if (!line) {
    check('the browser probe ran', false, (run.stderr || run.stdout || '').slice(0, 500));
  } else {
    const results = JSON.parse(line);
    for (const order of Object.keys(ORDERS)) {
      checkOrder(order, results[order]);
    }
  }
  if (failures.length) {
    console.error(`split-button-style: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`split-button-style: ${checked} passed  [real layout]`);
})();

function checkOrder(order, { accent, places }) {
  for (const place of PLACES) {
    const measured = places[place.name];
    const { rest, arrowHover, mainHover, arrowFocus, open, openArrowHover } = measured;
    const detail = JSON.stringify(measured);
    const name = `${order}, ${place.name}`;
    check(`${name}: the chevron is as tall as the main half`, rest.arrowHeight === rest.mainHeight, detail);
    const heightPxMax = welcomeHeightPxMax(rest.mainLineHeight);
    check(`${name}: the label stays on one line`, rest.mainHeight <= heightPxMax, `${rest.mainHeight}px > ${heightPxMax}px`);
    check(
      `${name}: the chevron is sized by its padding`,
      rest.arrowWidth <= WELCOME_ARROW_WIDTH_PX_MAX,
      `${rest.arrowWidth}px > ${WELCOME_ARROW_WIDTH_PX_MAX}px`,
    );
    check(`${name}: the chevron keeps its side padding`, rest.arrowPadding === '9px 11px', rest.arrowPadding);
    check(`${name}: the label is welcome-sized type`, rest.mainFontSize === '12.5px', rest.mainFontSize);
    check(`${name}: the main half rounds its outer corners`, rest.mainRadius === '10px 0px 0px 10px', rest.mainRadius);
    check(`${name}: the chevron rounds its outer corners`, rest.arrowRadius === '0px 10px 10px 0px', rest.arrowRadius);
    check(`${name}: the chevron icon is centred`, Math.abs(rest.iconOffset) <= 1, `off by ${rest.iconOffset}px`);
    check(`${name}: both halves rest on one background`, rest.mainBg === rest.arrowBg, `${rest.mainBg} vs ${rest.arrowBg}`);
    check(`${name}: the hovered chevron is not the accent`, arrowHover.arrowBg !== accent, arrowHover.arrowBg);
    check(`${name}: hovering the chevron changes its fill`, arrowHover.arrowBg !== rest.arrowBg, arrowHover.arrowBg);
    check(`${name}: hovering the chevron leaves the main half`, arrowHover.mainBg === rest.mainBg, `${arrowHover.mainBg} vs ${rest.mainBg}`);
    check(`${name}: hovering the main half leaves the chevron`, mainHover.arrowBg === rest.arrowBg, `${mainHover.arrowBg} vs ${rest.arrowBg}`);
    check(`${name}: the hovered main half is not the accent`, mainHover.mainBg !== accent, mainHover.mainBg);
    check(`${name}: keyboard focus on the chevron draws a ring`, !arrowFocus.arrowOutline.startsWith('none'), arrowFocus.arrowOutline);
    check(`${name}: keyboard focus keeps the chevron off the accent fill`, arrowFocus.arrowBg !== accent, arrowFocus.arrowBg);
    check(`${name}: open, both halves share one background`, open.mainBg === open.arrowBg, `${open.mainBg} vs ${open.arrowBg}`);
    check(`${name}: open, the hovered chevron is not the accent`, openArrowHover.arrowBg !== accent, openArrowHover.arrowBg);
    check(`${name}: open, hovering the chevron leaves the main half`, openArrowHover.mainBg === open.mainBg, `${openArrowHover.mainBg} vs ${open.mainBg}`);
  }
}
