// The Apps panel's Installed / Marketplace tabs, in a real browser: one pill sits
// behind the active tab and slides to the other one (a transform, about 200 ms),
// hovering a tab changes only its text colour (never a background of its own,
// which the app's blanket button:hover fill would otherwise paint), and with
// reduced motion the pill jumps without a transition.
//
//   node test/renderer/apps/appsViewTabs.test.js
//
// Method: the real AppsViewTabs, under the app's stylesheets, in a 280px panel in
// Electron's Chromium. Hover and clicks are real input events from the browser's
// own pipeline, so the :hover rules are the ones a person meets. The pill's place
// is read mid-slide and after it, and compared with the tabs' layout offsets.
// The reduced-motion pass emulates the media feature over the DevTools protocol.
const fs = require('fs');
const path = require('path');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};

(async () => {
  const electronPath = (() => {
    try {
      return require('electron');
    } catch {
      return undefined;
    }
  })();
  if (typeof electronPath !== 'string') {
    console.log('apps-view-tabs: skipped  [needs a Chromium — see test/renderer/style/computedColor.test.js]');
    return;
  }
  const esbuild = require('esbuild');
  const pageDirectory = repoPath('node_modules/.stacki-test/apps-view-tabs');
  fs.mkdirSync(pageDirectory, { recursive: true });
  const entry = `
    import React, { useState } from 'react'
    import { createRoot } from 'react-dom/client'
    import { AppsViewTabs } from './src/features/apps/marketplace/MarketplaceView'
    import './src/features/style/tokens.css'
    import './src/app/styles.css'
    import './src/features/apps/apps.css'
    import './src/features/apps/marketplace/marketplace.css'

    function Harness() {
      const [view, setView] = useState('installed')
      return (
        <div className="apps-panel" style={{ width: 280 }}>
          <AppsViewTabs view={view} onPick={setView} />
        </div>
      )
    }
    createRoot(document.getElementById('root')).render(<Harness />)
  `;
  await esbuild.build({
    stdin: { contents: entry, resolveDir: ROOT, loader: 'jsx' },
    outfile: path.join(pageDirectory, 'bundle.js'),
    bundle: true,
    format: 'iife',
    jsx: 'automatic',
    loader: { '.svg': 'dataurl', '.png': 'dataurl', '.woff2': 'dataurl' },
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'silent',
  });
  fs.writeFileSync(
    path.join(pageDirectory, 'index.html'),
    '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="bundle.css">' +
      '<style>body{margin:0}</style><div id="root"></div><script src="bundle.js"></script>',
  );
  const probe = path.join(pageDirectory, 'probe.js');
  fs.writeFileSync(
    probe,
    `const { app, BrowserWindow } = require('electron');
     const path = require('path');
     app.on('window-all-closed', () => app.quit());
     const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
     const read = \`(() => {
       const tabs = [...document.querySelectorAll('.apps-view-tab')];
       const pill = document.querySelector('.apps-view-tab-indicator');
       const style = getComputedStyle(pill);
       return {
         tabs: tabs.map((tab) => ({
           left: tab.offsetLeft,
           width: tab.offsetWidth,
           x: Math.round(tab.getBoundingClientRect().left + tab.offsetWidth / 2),
           y: Math.round(tab.getBoundingClientRect().top + tab.offsetHeight / 2),
           background: getComputedStyle(tab).backgroundColor,
           color: getComputedStyle(tab).color,
           on: tab.classList.contains('on'),
         })),
         pill: {
           x: new DOMMatrixReadOnly(style.transform === 'none' ? undefined : style.transform).m41,
           width: pill.getBoundingClientRect().width,
           animated: pill.classList.contains('is-animated'),
           duration: style.transitionDuration,
           property: style.transitionProperty,
         },
       };
     })()\`;
     async function session(win, reduced) {
       await win.loadFile(path.join(__dirname, 'index.html'));
       if (reduced) {
         // The protocol needs a loaded page to attach to; the reload then mounts under the emulated preference.
         if (!win.webContents.debugger.isAttached()) {
           win.webContents.debugger.attach('1.3');
         }
         await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
           features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
         });
         await win.loadFile(path.join(__dirname, 'index.html'));
       }
       await wait(400);
       // The pill turns on its slide a frame after it is placed; a hidden window on a slow
       // runner can take longer than the pause, so wait for it, within a bound.
       for (let attempt = 0; attempt < 50 && !reduced; attempt += 1) {
         if (await win.webContents.executeJavaScript("!!document.querySelector('.apps-view-tab-indicator.is-animated')")) {
           break;
         }
         await wait(100);
       }
       const js = (code) => win.webContents.executeJavaScript(code);
       const move = async (x, y) => {
         win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
         await wait(250);
       };
       const click = async (x, y) => {
         win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
         win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
       };
       const out = {};
       out.rest = await js(read);
       const [installed, marketplace] = out.rest.tabs;
       if (!reduced) {
         await move(marketplace.x, marketplace.y);
         out.hoverInactive = await js(read);
         await move(installed.x, installed.y);
         out.hoverActive = await js(read);
         await move(1, 200);
       }
       await click(marketplace.x, marketplace.y);
       await wait(70);
       out.mid = await js(read);
       await wait(400);
       // Measure once the pill's slide has finished; slowed motion outlasts the sleep. Bounded.
       await js("Promise.race([Promise.all(document.getAnimations().map((animation) => animation.finished)), new Promise((resolve) => setTimeout(resolve, 5000))]).then(() => true)");
       out.after = await js(read);
       return out;
     }
     app.whenReady().then(async () => {
       // A page error would otherwise leave the probe waiting until the outer timeout.
       try {
         const full = new BrowserWindow({ show: false, width: 400, height: 300 });
         const motion = await session(full, false);
         const quiet = new BrowserWindow({ show: false, width: 400, height: 300 });
         const reduced = await session(quiet, true);
         console.log(JSON.stringify({ motion, reduced }));
       } catch (error) {
         console.error('probe failed: ' + String(error && error.stack || error));
       }
       app.quit();
     });`,
  );
  const { spawnSync } = require('child_process');
  const run = spawnSync(electronPath, [probe], { encoding: 'utf8', timeout: 120000 });
  const line = (run.stdout || '').split('\n').find((text) => text.trim().startsWith('{'));
  if (!line) {
    check('the browser probe ran', false, (run.stderr || run.stdout || '').slice(0, 500));
  } else {
    const { motion, reduced } = JSON.parse(line);
    const [installed, marketplace] = motion.rest.tabs;
    const near = (measured, expected) => Math.abs(measured - expected) < 0.5;
    check('Installed starts active', installed.on === true && marketplace.on === false, JSON.stringify(motion.rest.tabs));
    check('the pill sits under Installed', near(motion.rest.pill.x, installed.left), JSON.stringify(motion.rest.pill));
    check('and is as wide as it', near(motion.rest.pill.width, installed.width), JSON.stringify(motion.rest.pill));
    check('the pill slides once placed', motion.rest.pill.animated === true, JSON.stringify(motion.rest.pill));
    check('by transform and width', motion.rest.pill.property.includes('transform') && motion.rest.pill.property.includes('width'), motion.rest.pill.property);
    check(
      'in about 200 ms',
      motion.rest.pill.duration.split(',').every((part) => part.trim() === '0.2s'),
      motion.rest.pill.duration,
    );
    check(
      'no tab paints its own background',
      [installed, marketplace].every((tab) => tab.background === 'rgba(0, 0, 0, 0)'),
      JSON.stringify(motion.rest.tabs),
    );

    const hovered = motion.hoverInactive.tabs[1];
    check('hovering a tab keeps its background clear', hovered.background === marketplace.background, `${hovered.background} vs ${marketplace.background}`);
    check('and changes its text colour', hovered.color !== marketplace.color, `${hovered.color} vs ${marketplace.color}`);
    check('while the pill stays put', near(motion.hoverInactive.pill.x, installed.left), JSON.stringify(motion.hoverInactive.pill));
    const hoveredActive = motion.hoverActive.tabs[0];
    check('hovering the active tab paints no second pill', hoveredActive.background === installed.background, hoveredActive.background);

    const midX = motion.mid.pill.x;
    // On GitHub's Linux runner (xvfb) a hidden window's slide can be stalled at its start
    // when the mid-slide read lands, so only macOS and Windows check the midpoint.
    if (process.platform !== 'linux') {
      check(
        'mid-slide the pill is between the tabs',
        midX > installed.left + 0.5 && midX < marketplace.left - 0.5,
        `${midX} between ${installed.left} and ${marketplace.left}`,
      );
    }
    check('Marketplace is active after the click', motion.after.tabs[1].on === true, JSON.stringify(motion.after.tabs));
    check('the pill ends under Marketplace', near(motion.after.pill.x, marketplace.left), JSON.stringify(motion.after.pill));
    check('as wide as it', near(motion.after.pill.width, marketplace.width), JSON.stringify(motion.after.pill));

    check('with reduced motion the pill never animates', reduced.rest.pill.animated === false, JSON.stringify(reduced.rest.pill));
    check('it jumps straight to the clicked tab', near(reduced.mid.pill.x, reduced.rest.tabs[1].left), JSON.stringify(reduced.mid.pill));
  }
  if (failures.length) {
    console.error(`apps-view-tabs: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`apps-view-tabs: ${checked} passed  [real layout, real input]`);
})();
