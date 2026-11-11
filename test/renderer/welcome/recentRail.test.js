// The start screen's recents rail stays where the user scrolls it.
//
//   node test/renderer/welcome/recentRail.test.js
//
// Goal: the row of project cards used to slide over on its own and would not
// rest at its left edge. The cause was CSS scroll snapping: each card snapped
// its start to the scrollport's start, which ignores the rail's 24px padding,
// so the first card's snap point was 24px in and Chromium re-snapped there
// after every layout change (a thumbnail being retaken, a resize). The same
// rule set `scrollbar-width`, which makes Chromium ignore the app's
// ::-webkit-scrollbar styling and draw its native grey bar.
//
// Method, in two halves:
//   1. The stylesheet. jsdom has no layout, so the snap behaviour itself can't
//      be observed; instead the rail's rules are read from styles.css and the
//      properties that caused it are checked to be gone, and the custom
//      scrollbar is checked to be inset by the same padding as the cards.
//   2. The component. WelcomeScreen is rendered with a fake rail geometry. Its
//      scrollLeft is instrumented so any write is recorded: nothing in the
//      screen may set it, including while thumbnails are retaken and the cards
//      re-render. The trailing fade attribute is checked to follow the scroll
//      position, including the negative space (at the end, and with no
//      overflow at all), and the pure edge helper's assertions are pinned.
//   3. The macOS overlay bar. The stylesheet must hide it at rest without
//      giving up its space; the screen must ask for it on darwin only; and the
//      watcher, run on a bare rail with a short delay, must show it while
//      scrolling, over the bar strip and through a thumb drag, then hide it
//      once the delay passes.

const fs = require('fs');
const path = require('path');
const { repoPath } = require('../../helpers/sources.js');

const PLATFORM_NULL = JSON.parse('null');
const PIXEL = 'data:image/png;base64,' + 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk' + 'YAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};
const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

// Every declaration block whose selector list mentions `.recent-rail`, joined.
// Comments are dropped first so the explanation of the old bug can't satisfy
// or fail a check.
const railRules = (css) => {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const blocks = [];
  const rule = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  while ((match = rule.exec(withoutComments)) !== null) {
    if (match[1].includes('.recent-rail')) {
      blocks.push({ selector: match[1].trim(), body: match[2] });
    }
  }
  return blocks;
};

(async () => {
  // 1. The stylesheet.
  const css = fs.readFileSync(repoPath('src/app/styles.css'), 'utf8');
  const rules = railRules(css);
  const allBodies = rules.map((rule) => rule.body).join('\n');
  check('the rail has rules to check', rules.length >= 3, `${rules.length}`);
  check('the rail does not snap', !/scroll-snap-type/.test(allBodies));
  check('its cards declare no snap alignment', !/scroll-snap-align/.test(allBodies));
  check('the rail leaves scrollbar-width unset, so ::-webkit-scrollbar styling applies', !/scrollbar-width/.test(allBodies));
  const rail = rules.find((rule) => rule.selector === '.recent-rail');
  const padding = rail && /padding:\s*\S+\s+(\d+px)/.exec(rail.body);
  check('the rail has inline padding', Boolean(padding), rail ? rail.body : 'no .recent-rail rule');
  const track = rules.find((rule) => rule.selector === '.recent-rail::-webkit-scrollbar-track');
  const trackMargin = track && /margin:\s*0\s+(\d+px)/.exec(track.body);
  check('the scrollbar track is inset', Boolean(trackMargin), track ? track.body : 'no track rule');
  check('by the same side padding as the cards', padding && trackMargin && padding[1] === trackMargin[1], `${padding?.[1]} vs ${trackMargin?.[1]}`);
  check('the rail recolours the shared thumb token for its light backdrop', /--scrollbar-thumb:/.test(rail ? rail.body : ''));
  const fade = rules.find((rule) => rule.selector.includes("[data-more='end']"));
  check('the trailing fade only applies while there is more to the right', Boolean(fade) && /mask-image/.test(fade.body));
  check('and the plain rail has no fade', !/mask-image/.test(rail ? rail.body : ''));
  const globalThumb = /(^|\n)::-webkit-scrollbar-thumb\s*\{([^}]*)\}/.exec(css.replace(/\/\*[\s\S]*?\*\//g, ''));
  const overlay = rules.find((rule) => rule.selector === ".recent-rail[data-scrollbar='overlay']");
  check('the overlay bar is hidden at rest', Boolean(overlay) && /--recent-rail-thumb-alpha:\s*0\s*;/.test(overlay.body), overlay?.body);
  check('and fades by transitioning its visibility', Boolean(overlay) && /transition:\s*--recent-rail-thumb-alpha/.test(overlay.body));
  const shown = rules.find((rule) => rule.selector === ".recent-rail[data-scrollbar='overlay'][data-scrolling]");
  check('the overlay bar shows while scrolling', Boolean(shown) && /--recent-rail-thumb-alpha:\s*1\s*;/.test(shown.body), shown?.body);
  check('the visibility is a registered property, so it can transition', /@property --recent-rail-thumb-alpha\s*\{[^}]*syntax:\s*'<number>'/.test(css));
  check(
    'reduced motion shows and hides it without a fade',
    /prefers-reduced-motion: reduce\)\s*\{\s*\.recent-rail\[data-scrollbar='overlay'\]\s*\{\s*transition:\s*none/.test(css),
  );
  check(
    'hiding never changes the bar size, so the cards never move',
    !rules.some((rule) => rule.selector.includes('data-scrolling') && /height|display|overflow/.test(rule.body)),
  );
  check('the shared thumb reads its colour from a theme token', Boolean(globalThumb) && /var\(--scrollbar-thumb\)/.test(globalThumb[2]));

  // 2. The component.
  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test');
  fs.mkdirSync(buildDirectory, { recursive: true });
  const bundlePath = path.join(buildDirectory, 'recent-rail.bundle.js');
  const helperPath = path.join(buildDirectory, 'recent-rail-helper.bundle.js');
  const shared = { bundle: true, format: 'cjs', platform: 'node', jsx: 'automatic', external: ['react', 'react-dom', 'react/jsx-runtime'], logLevel: 'silent' };
  await esbuild.build({ ...shared, entryPoints: [repoPath('src/features/welcome/WelcomeScreen.tsx')], outfile: bundlePath });
  await esbuild.build({ ...shared, entryPoints: [repoPath('src/features/welcome/recentRail.ts')], outfile: helperPath });

  const { railHasMoreEnd } = require(helperPath);
  check('more to the right when the end is out of view', railHasMoreEnd(0, 400, 800) === true);
  check('nothing more at the end', railHasMoreEnd(400, 400, 800) === false);
  check('a sub-pixel short of the end counts as the end', railHasMoreEnd(399.5, 400, 800) === false);
  check('nothing more when the cards fit', railHasMoreEnd(0, 800, 800) === false);
  let thrown = '';
  try {
    railHasMoreEnd(Number.NaN, 400, 800);
  } catch (error) {
    thrown = String(error);
  }
  check('a non-finite scroll position is a programmer error', thrown.includes('recentRail: scrollLeft must be finite'), thrown);

  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  require('../../helpers/popupDom').installPopupDOM(dom.window);
  global.window = dom.window;
  global.document = dom.window.document;
  global.Node = dom.window.Node;
  global.navigator = dom.window.navigator;
  global.MutationObserver = dom.window.MutationObserver;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.Element.prototype.scrollIntoView = function scrollIntoView() {};
  dom.window.HTMLCanvasElement.prototype.getContext = () => PLATFORM_NULL;
  global.WebGLRenderingContext = dom.window.WebGLRenderingContext = function WebGLRenderingContext() {};

  // The test DOM lays nothing out. Every element reports a rail-like geometry, and
  // scrollLeft writes are recorded instead of applied.
  const geometry = { clientWidth: 400, scrollWidth: 1000 };
  const scrollLeftWrites = [];
  let scrollLeft = 0;
  Object.defineProperty(dom.window.HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => geometry.clientWidth });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollWidth', { configurable: true, get: () => geometry.scrollWidth });
  Object.defineProperty(dom.window.Element.prototype, 'scrollLeft', {
    configurable: true,
    get: () => scrollLeft,
    set: (value) => {
      scrollLeftWrites.push(value);
    },
  });
  dom.window.Element.prototype.scrollTo = function scrollTo(...args) {
    scrollLeftWrites.push(JSON.stringify(args));
  };

  let releaseThumb;
  dom.window.avb = {
    platform: 'linux',
    listRecents: async () => [
      { path: '/p/a', name: 'a', thumb: PIXEL, stale: false, canRefresh: true, openedAt: 3 },
      { path: '/p/b', name: 'b', thumb: PIXEL, stale: true, canRefresh: true, openedAt: 2 },
      { path: '/p/c', name: 'c', thumb: PIXEL, stale: false, canRefresh: true, openedAt: 1 },
    ],
    removeRecent: async () => ({ ok: true }),
    refreshThumb: async () => {
      await new Promise((resolve) => {
        releaseThumb = resolve;
      });
      return { ok: true, thumb: PIXEL, stale: false };
    },
  };

  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = React;
  const WelcomeScreen = require(bundlePath).default;
  const container = dom.window.document.getElementById('root');
  const reactRoot = createRoot(container);
  await act(async () => {
    reactRoot.render(React.createElement(WelcomeScreen, { onOpen: () => {}, showToast: () => {} }));
    await settle(30);
  });

  const railElement = container.querySelector('.recent-rail');
  check('the rail renders', Boolean(railElement));
  check('a rail that runs past the window fades its trailing edge', railElement?.getAttribute('data-more') === 'end', railElement?.outerHTML.slice(0, 80));

  // The user scrolls to the end: the fade goes, so the last card shows whole.
  scrollLeft = geometry.scrollWidth - geometry.clientWidth;
  await act(async () => {
    railElement.dispatchEvent(new dom.window.Event('scroll'));
    await settle();
  });
  check('at the end there is no fade', !railElement.hasAttribute('data-more'));

  // And back to the start, flush at the padding edge.
  scrollLeft = 0;
  await act(async () => {
    railElement.dispatchEvent(new dom.window.Event('scroll'));
    await settle();
  });
  check('back at the start the fade returns', railElement.getAttribute('data-more') === 'end');

  // A stale thumbnail is retaken while the user is mid-row; the cards
  // re-render. Nothing may move the row.
  scrollLeft = 137;
  check('a stale thumbnail is being retaken', typeof releaseThumb === 'function');
  await act(async () => {
    releaseThumb?.();
    await settle(30);
  });
  check('the same rail element survives the re-render', container.querySelector('.recent-rail') === railElement);
  check('nothing in the screen ever writes the scroll position', scrollLeftWrites.length === 0, JSON.stringify(scrollLeftWrites));

  // With no overflow at all there is nothing to fade.
  geometry.scrollWidth = geometry.clientWidth;
  await act(async () => {
    railElement.dispatchEvent(new dom.window.Event('scroll'));
    await settle();
  });
  check('cards that fit are not faded', !railElement.hasAttribute('data-more'));
  geometry.scrollWidth = 1000;

  // Off macOS the bar is the always-visible thin one: scrolling never toggles it.
  check('off macOS the rail keeps the classic bar', railElement.getAttribute('data-scrollbar') === 'classic', railElement.getAttribute('data-scrollbar'));
  await act(async () => {
    railElement.dispatchEvent(new dom.window.Event('scroll'));
    await settle();
  });
  check('and scrolling does not mark it as scrolling', !railElement.hasAttribute('data-scrolling'));

  await act(async () => {
    reactRoot.unmount();
    await settle(10);
  });

  // On macOS the screen asks for the overlay bar.
  dom.window.avb.platform = 'darwin';
  const macRoot = createRoot(container);
  await act(async () => {
    macRoot.render(React.createElement(WelcomeScreen, { onOpen: () => {}, showToast: () => {} }));
    await settle(30);
  });
  const macRail = container.querySelector('.recent-rail');
  check('on macOS the rail uses the overlay bar', macRail?.getAttribute('data-scrollbar') === 'overlay', macRail?.getAttribute('data-scrollbar'));
  check('which is hidden at rest', !macRail?.hasAttribute('data-scrolling'));
  await act(async () => {
    macRoot.unmount();
    await settle(10);
  });

  // The overlay's timing, on a bare rail with a short delay so the test does
  // not wait a real second. The default is pinned separately.
  const { watchRailEdges, railScrollbarFor, RAIL_SCROLLBAR_HIDE_DELAY_MS } = require(helperPath);
  check('the bar lingers about a second, as macOS does', RAIL_SCROLLBAR_HIDE_DELAY_MS === 1000);
  check('darwin is the overlay platform', railScrollbarFor('darwin') === 'overlay');
  check('Windows keeps the classic bar', railScrollbarFor('win32') === 'classic');
  check('Linux keeps the classic bar', railScrollbarFor('linux') === 'classic');
  const bare = dom.window.document.createElement('div');
  dom.window.document.body.append(bare);
  // A 120px rail whose bottom 10px is the scrollbar strip.
  Object.defineProperty(bare, 'offsetHeight', { configurable: true, get: () => 120 });
  Object.defineProperty(bare, 'clientHeight', { configurable: true, get: () => 110 });
  bare.getBoundingClientRect = () => ({ top: 0, bottom: 120, left: 0, right: 400, width: 400, height: 120 });
  const hideDelayMs = 40;
  const stop = watchRailEdges(bare, { scrollbar: 'overlay', hideDelayMs });
  const scrolling = () => bare.hasAttribute('data-scrolling');
  const pointer = (type, clientY, target = bare) => target.dispatchEvent(new dom.window.MouseEvent(type, { clientY, bubbles: true }));
  check('hidden before any scroll', !scrolling());
  bare.dispatchEvent(new dom.window.Event('scroll'));
  check('shown as soon as the rail scrolls', scrolling());
  await settle(hideDelayMs / 2);
  bare.dispatchEvent(new dom.window.Event('scroll'));
  await settle(hideDelayMs / 2 + 10);
  check('a further scroll restarts the delay', scrolling());
  await settle(hideDelayMs);
  check('hidden once the delay passes with no scroll', !scrolling());
  pointer('pointermove', 60);
  check('the pointer over the cards does not show it', !scrolling());
  pointer('pointermove', 115);
  check('the pointer over the bar strip shows it', scrolling());
  pointer('pointerleave', 115);
  check('and leaving hides it again', !scrolling());
  pointer('pointerdown', 115);
  bare.dispatchEvent(new dom.window.Event('scroll'));
  await settle(hideDelayMs + 20);
  pointer('pointerleave', 115);
  check('a thumb drag keeps it visible past the delay', scrolling());
  pointer('pointerup', 300, dom.window.document.body);
  check('letting go anywhere ends the drag and hides it', !scrolling());
  pointer('pointerdown', 60);
  check('a press on a card is not a drag', !scrolling());
  stop();
  bare.dispatchEvent(new dom.window.Event('scroll'));
  check('stopping the watcher stops the bar', !scrolling());
  const classic = dom.window.document.createElement('div');
  dom.window.document.body.append(classic);
  const stopClassic = watchRailEdges(classic, { scrollbar: 'classic' });
  classic.dispatchEvent(new dom.window.Event('scroll'));
  check('a classic rail is never marked as scrolling', !classic.hasAttribute('data-scrolling'));
  stopClassic();
  thrown = '';
  try {
    watchRailEdges(classic, { scrollbar: 'overlay', hideDelayMs: -1 });
  } catch (error) {
    thrown = String(error);
  }
  check('a negative hide delay is a programmer error', thrown.includes('recentRail: hide delay must not be negative'), thrown);

  if (failures.length) {
    console.error(`\nrecentRail: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`recentRail: ${checked} passed`);
})();
