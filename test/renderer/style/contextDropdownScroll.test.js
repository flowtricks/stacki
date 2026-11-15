// Goal: the style-context dropdown is compact and scrolls like a native menu. Its Follow canvas
// size strip and its "Add query" footer are pinned outside the scrolling rows (rows never slide
// under them), only the rows scroll (one scrollbar, no chaining to the page behind), and the list
// never moves by itself: not on open, not when the pointer crosses a partly hidden row, not when
// its options re-render, The list is flat (no group cards), rows are
// 32px, every row ends in the same 16px check slot, left and right insets match when nothing
// scrolls, the trigger is one line, and the typical list (Base, three width queries, an Other section, Add
// query) fits in about 300px without a scrollbar. The cap is 36rem (80vh), shrinking to the room.
//
// Method: layout is a browser question, so this runs in a real Electron window (the pattern of
// popoverDropdown.test.js; skipped without Electron). It mounts the real Select with rows shaped as
// the context dropdown builds them, under the real tokens and stylesheets, then measures rects and
// scrollTop. Presses are dispatched events; every wait polls observable state
// (test/helpers/waitFor.js). Nothing is wall-clock dependent and no real project is touched. Set
// STACKI_DROPDOWN_SHOTS=<directory> to also save screenshots of the typical, long and pinned lists.

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
  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test/context-scroll');
  fs.mkdirSync(buildDirectory, { recursive: true });
  const entry = `
    import React, { useState } from 'react'
    import { createRoot } from 'react-dom/client'
    import Select from './src/features/style/components/Select'
    import './src/features/style/tokens.css'
    import './src/features/style/utilities.css'
    import './src/features/style/embedEditor.css'

    const pencil = { icon: <span>p</span>, label: 'Edit', onSelect: () => {} }
    const build = (rev, shape, pinned) => {
      const options = [{ value: '__follow', label: 'Follow canvas size', icon: <span>pin</span>, header: true, switch: true, checked: !pinned }]
      options.push({ value: '', label: 'Base', icon: <span>h</span> })
      const heading = (value, label) => ({ value, label, heading: true })
      options.push(heading('g0', '.grid'))
      const rows = [['≥ 64rem', 'w0'], ['≥ 48rem', 'w1'], ['≥ 30rem', 'w2']]
      for (const [label, value] of rows) {
        options.push({ value, label, title: '@media (width ' + label + ')', icon: <span>r</span>, marked: true, action: pencil, ...(value === 'w0' ? { triggerPrefix: 'Grid .grid' } : {}) })
      }
      if (shape === 'long') {
        for (let g = 1; g <= 9; g += 1) {
          options.push(heading('g' + g, 'src/styles/s' + g + '.css'))
          options.push({ value: 'l' + g, label: 'Laptop', detail: '< 64rem', icon: <span>l</span>, marked: rev >= 0 })
          options.push({ value: 'k' + g, label: 'Tablet', detail: '< 48rem', icon: <span>t</span>, marked: true })
        }
      }
      options.push(heading('other', 'Other'))
      options.push({ value: 'o1', label: '@media (prefers-reduced-motion: reduce)', subline: ['*, ::before, ::after'], marked: true })
      options.push({ value: '__add', label: 'Add query', footer: true })
      return options
    }

    function Harness() {
      const [value, setValue] = useState('w0')
      const [pinned, setPinned] = useState(false)
      window.__pin = setPinned
      const [rev, setRev] = useState(0)
      const [shape, setShape] = useState('long')
      window.__rev = setRev
      window.__shape = setShape
      return (
        <div className="embed-editor_root" style={{ width: 320, margin: '40px 20px' }}>
          <Select className="embed-editor_context-select" value={value} options={build(rev, shape, pinned)} onChange={(next) => { if (next === '__follow') { setPinned((was) => !was) } else { setValue(next) } }} ariaLabel="Context" />
        </div>
      )
    }
    createRoot(document.getElementById('root')).render(<Harness />)
  `;
  await esbuild.build({
    stdin: { contents: entry, resolveDir: ROOT, loader: 'jsx' },
    outfile: path.join(buildDirectory, 'bundle.js'),
    bundle: true,
    format: 'iife',
    jsx: 'automatic',
    logLevel: 'silent',
  });
  fs.writeFileSync(
    path.join(buildDirectory, 'index.html'),
    '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="bundle.css">' +
      '<style>body{margin:0;background:#111;height:2000px}</style><div id="root"></div><script src="bundle.js"></script>',
  );
  const electronPath = (() => {
    try {
      return require('electron');
    } catch {
      return undefined;
    }
  })();
  if (typeof electronPath !== 'string') {
    console.log('context-dropdown-scroll: skipped, no Electron to lay it out in');
    return;
  }

  const scriptPath = path.join(buildDirectory, 'probe.js');
  fs.writeFileSync(
    scriptPath,
    `const { app, BrowserWindow } = require('electron');
     app.on('window-all-closed', () => app.quit());
     app.whenReady().then(async () => {
       const win = new BrowserWindow({ show: false, width: 700, height: 600 });
       win.webContents.on('console-message', (...a) => console.error('CONSOLE ' + JSON.stringify(a).slice(0, 400)));
       await win.loadFile(${JSON.stringify(path.join(buildDirectory, 'index.html'))});
       const js = (code) => win.webContents.executeJavaScript(code).catch((error) => { console.error('PROBE FAIL ' + String(error).slice(0, 300) + ' IN ' + code.slice(0, 120)); throw error; });
       const { MOTION_SETTLED_EXPRESSION, waitFor: pollUntil } = require(${JSON.stringify(repoPath('test/helpers/waitFor.js'))});
       const settled = (what) => pollUntil({ what, read: () => js(MOTION_SETTLED_EXPRESSION), until: (still) => still });
       await pollUntil({ what: 'trigger drawn', read: () => js("document.querySelector('.u-select-button') !== null"), until: (drawn) => drawn });
       // Helpers inside the page. The scroller is the nearest scrolling ancestor of the first row.
       await js(\`window.__q = {
         scroller() {
           const region = document.querySelector('.u-select-list > .u-select-scroll');
           if (region) return region;
           let el = document.querySelector('.u-select-list [role=option]');
           while (el && el.parentElement) { el = el.parentElement; const o = getComputedStyle(el).overflowY; if ((o === 'auto' || o === 'scroll') && el.scrollHeight > el.clientHeight) return el; if (el.classList.contains('u-select-list')) break; }
           return document.querySelector('.u-select-list');
         },
         footer() { return document.querySelector('.u-select-option.is-footer'); },
         rects() {
           const s = window.__q.scroller(), f = window.__q.footer(), l = document.querySelector('.u-select-list');
           const inRegion = [...s.querySelectorAll('[role=option]')].filter((o) => !o.classList.contains('is-footer') && !o.classList.contains('is-header'));
           const last = inRegion[inRegion.length - 1].getBoundingClientRect();
           const sr = s.getBoundingClientRect(), fr = f.getBoundingClientRect(), lr = l.getBoundingClientRect();
           return { scrollTop: s.scrollTop, scrollMax: s.scrollHeight - s.clientHeight, scrollerBottom: sr.bottom, scrollerIsList: s === l,
             footerTop: fr.top, footerBottom: fr.bottom, lastGroupBottom: last.bottom, lastGroupTop: last.top, listTop: lr.top, listBottom: lr.bottom, listHeight: lr.height };
         },
       }; true\`);
       const out = {};
       await js("document.querySelector('.u-select-button').click(); true");
       await pollUntil({ what: 'list open', read: () => js("document.querySelector('.u-select-list') !== null"), until: (open) => open });
       await settled('menu opened');
       out.open = await js('window.__q.rects()');
       out.listStyle = await js("(() => { const s = window.__q.scroller(); const c = getComputedStyle(s); return { overscroll: c.overscrollBehaviorY, overflowY: c.overflowY, gutter: c.scrollbarGutter } })()");
       out.scrollers = await js("(() => { let n = 0; for (const el of document.querySelectorAll('.u-select-list, .u-select-list *')) { const o = getComputedStyle(el).overflowY; if ((o === 'auto' || o === 'scroll') && el.scrollHeight > el.clientHeight) n += 1; } return n })()");
       // Scroll to the end: the last card must end above the footer.
       await js("(() => { const s = window.__q.scroller(); s.scrollTop = s.scrollHeight; return true })()");
       out.end = await js('window.__q.rects()');
       // Hover a row that is partly hidden at the foot: the list must not move.
       await js("(() => { const s = window.__q.scroller(); s.scrollTop = 40; return true })()");
       const before = await js('window.__q.rects().scrollTop');
       await js("(() => { const rows = [...document.querySelectorAll('.u-select-list [role=option]')].filter((r) => !r.classList.contains('is-footer')); const s = window.__q.scroller().getBoundingClientRect(); const part = rows.find((r) => { const b = r.getBoundingClientRect(); return b.bottom > s.bottom - 2 && b.top < s.bottom; }) || rows[rows.length - 1]; part.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); part.dispatchEvent(new MouseEvent('mouseenter')); return true })()");
       out.hoverMoved = await pollUntil({ what: 'hover settled', read: () => js('window.__q.rects().scrollTop'), until: () => true }).then(() => js('window.__q.rects().scrollTop')).then((after) => after - before);
       // Re-render with new option arrays while open: scrollTop must hold.
       await js("(() => { window.__q.scroller().scrollTop = 60; window.__rev(1); return true })()");
       await pollUntil({ what: 'rerendered', read: () => js('window.__q.rects().scrollTop'), until: () => true });
       out.afterRerender = await js('window.__q.rects().scrollTop');
       // The cap: the typical list fits whole at 900px tall; at 500px the list shrinks, scrolls,
       // and keeps its footer inside the window.
       const reopen = async (height, shape) => {
         await js("document.querySelector('.u-select-list') !== null && document.querySelector('.u-select-button').click(); true");
         await pollUntil({ what: 'list closed', read: () => js("document.querySelector('.u-select-list') === null"), until: (closed) => closed });
         win.setContentSize(700, height);
         await pollUntil({ what: 'window resized', read: () => js('window.innerHeight'), until: (inner) => inner === height });
         await js('window.__shape(' + JSON.stringify(shape) + '); true');
         await js("document.querySelector('.u-select-button').click(); true");
         await pollUntil({ what: 'list open again', read: () => js("document.querySelector('.u-select-list') !== null"), until: (open) => open });
         await settled('menu opened again');
         return js(\`(() => { const r = window.__q.rects(); const l = document.querySelector('.u-select-list').getBoundingClientRect(); const inset = (el) => { const e = el.getBoundingClientRect(), p = document.querySelector('.u-select-list').getBoundingClientRect(); return { left: e.left - p.left, right: p.right - e.right } }; return { ...r, base: inset(document.querySelector('.u-select-list [role=option]')), second: inset(document.querySelectorAll('.u-select-scroll [role=option]')[1]), rowHeight: document.querySelectorAll('.u-select-scroll [role=option]')[0].offsetHeight, checkWidths: [...document.querySelectorAll('.u-select-list [role=option] .u-select-check')].map((c) => c.offsetWidth), cards: document.querySelectorAll('.u-select-group').length, headerOutside: document.querySelector('.u-select-header') !== null && !document.querySelector('.u-select-scroll').contains(document.querySelector('.u-select-header')), trigger: (() => { const t = document.querySelector('.u-select-button').getBoundingClientRect(); return { height: t.height, oneLine: document.querySelector('.u-select-button .has-prefix') !== null && document.querySelector('.u-select-button .has-overline') === null } })(), dotTitles: [...document.querySelectorAll('.u-select-dot')].every((d) => d.title === 'Has styles here' && d.getAttribute('aria-label') === 'Has styles here'), maxHeight: getComputedStyle(document.querySelector('.u-select-list')).maxHeight, windowHeight: window.innerHeight, listTopNow: l.top, listBottomNow: l.bottom } })()\`);
       };
       out.typical900 = await reopen(900, 'typical');
       out.long900 = await reopen(900, 'long');
       out.long500 = await reopen(500, 'long');
       // Pinning from the strip: the switch row toggles in place without closing.
       await js("document.querySelector('.u-select-header [role=option]').click(); true");
       await pollUntil({ what: 'switch off', read: () => js("document.querySelector('.u-select-header [role=option]').getAttribute('aria-selected')"), until: (selected) => selected === 'false' });
       out.switchStayedOpen = await js("document.querySelector('.u-select-list') !== null");
       const shots = process.env.STACKI_DROPDOWN_SHOTS;
       if (shots) {
         const fs = require('fs');
         const shoot = async (name) => { const image = await win.webContents.capturePage(); fs.writeFileSync(require('path').join(shots, name + '.png'), image.toPNG()); };
         await js("document.querySelector('.u-select-list') !== null && document.querySelector('.u-select-button').click(); true");
         await pollUntil({ what: 'list closed before shots', read: () => js("document.querySelector('.u-select-list') === null"), until: (closed) => closed });
         win.setContentSize(700, 700);
         await pollUntil({ what: 'resized', read: () => js('window.innerHeight'), until: (inner) => inner === 700 });
         // A window resize closes an open popover, and its event lands a frame late: let it pass first.
         await js('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
         for (const [name, shape, pinned] of [['typical', 'typical', false], ['long', 'long', false], ['pinned', 'typical', true]]) {
           await js('window.__shape(' + JSON.stringify(shape) + '); window.__pin(' + pinned + '); true');
           await js("document.querySelector('.u-select-list') === null && document.querySelector('.u-select-button').click(); true");
           await pollUntil({ what: 'list open for shot', read: () => js("document.querySelector('.u-select-list') !== null"), until: (open) => open });
           await settled('menu opened for shot');
           await js('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
           await shoot(name);
           await js("document.querySelector('.u-select-button').click(); true");
           await pollUntil({ what: 'list closed after shot', read: () => js("document.querySelector('.u-select-list') === null"), until: (closed) => closed });
         }
       }
       console.log(JSON.stringify(out));
       app.quit();
     });`,
  );

  const { spawnSync } = require('child_process');
  const run = spawnSync(electronPath, [scriptPath], { encoding: 'utf8', timeout: 90000 });
  const line = (run.stdout || '').split('\n').find((candidate) => candidate.trim().startsWith('{'));
  if (!line) {
    check('the probe ran in a browser', false, (run.stderr || run.stdout || '').slice(0, 600));
  } else {
    const out = JSON.parse(line);
    check('the list opens at the top, not scrolled by itself', out.open.scrollTop === 0, `scrollTop ${out.open.scrollTop}`);
    check('the footer is not inside the scrolling region', out.open.scrollerIsList === false, JSON.stringify(out.open));
    check('the footer sits below the scrolling region', out.open.footerTop >= out.open.scrollerBottom - 0.5, JSON.stringify(out.open));
    check('the list scrolls (the fixture is taller than the cap)', out.open.scrollMax > 0, JSON.stringify(out.open));
    check('only one region scrolls', out.scrollers === 1, `${out.scrollers} scrolling regions`);
    check('scrolling does not chain to the page behind', out.listStyle.overscroll === 'contain', out.listStyle.overscroll);
    check(
      'no reserved gutter: a list that does not scroll has equal insets left and right',
      Math.abs(out.typical900.base.left - out.typical900.base.right) <= 1,
      JSON.stringify(out.typical900.base),
    );
    check('and so do its rows below the first', Math.abs(out.typical900.second.left - out.typical900.second.right) <= 1, JSON.stringify(out.typical900.second));
    check('the list is flat: no group cards', out.typical900.cards === 0, `${out.typical900.cards} cards`);
    check('the Follow canvas size strip is pinned outside the scrolling rows', out.typical900.headerOutside === true);
    check('rows are 32px', Math.abs(out.typical900.rowHeight - 32) <= 0.5, `${out.typical900.rowHeight}`);
    check(
      'every row ends in the same 16px check slot',
      out.typical900.checkWidths.every((width) => width === 16),
      JSON.stringify(out.typical900.checkWidths),
    );
    check(
      'the trigger is one line, as tall as the other controls',
      out.typical900.trigger.oneLine === true && out.typical900.trigger.height <= 36,
      JSON.stringify(out.typical900.trigger),
    );
    check('a dot says what it means, for the pointer and for a screen reader', out.typical900.dotTitles === true);
    check('the typical list (with its Follow strip and Other section) fits in about 300px', out.typical900.listHeight <= 310, `${out.typical900.listHeight}`);
    check('the switch row toggles in place', out.switchStayedOpen === true);
    check('at the end the last group is fully visible above the footer', out.end.lastGroupBottom <= out.end.footerTop + 0.5, JSON.stringify(out.end));
    check('and fully visible inside the scroller', out.end.lastGroupBottom <= out.end.scrollerBottom + 0.5, JSON.stringify(out.end));
    check('hovering a partly hidden row does not move the list', out.hoverMoved === 0, `moved ${out.hoverMoved}`);
    check(
      'the typical list (Base, three width queries, an Other section, the footer) has no scrollbar at 900px tall',
      out.typical900.scrollMax === 0,
      JSON.stringify(out.typical900),
    );
    check('the cap is 36rem at 900px tall (80vh is 720px)', out.long900.maxHeight === '576px', out.long900.maxHeight);
    check(
      'a list taller than the cap scrolls inside it, footer still below the rows',
      out.long900.scrollMax > 0 && out.long900.footerTop >= out.long900.scrollerBottom - 0.5,
      JSON.stringify(out.long900),
    );
    check(
      'at 500px tall the list shrinks to the room and scrolls',
      out.long500.scrollMax > 0 && out.long500.listHeight < out.long900.listHeight,
      JSON.stringify(out.long500),
    );
    check(
      'and keeps 8px to the window edge with its footer visible',
      out.long500.footerBottom <= out.long500.windowHeight - 8 + 0.5 && out.long500.listTopNow >= 8 - 0.5,
      JSON.stringify(out.long500),
    );
    check('re-rendering the options keeps the scroll position', out.afterRerender === 60, `scrollTop ${out.afterRerender}`);
  }

  if (failures.length) {
    console.error(`context-dropdown-scroll: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`context-dropdown-scroll: ${checked} passed  [real layout]`);
})();
