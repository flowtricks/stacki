// The panel holds still while a popup is open.
//
//   node test/popup-scroll.js
//
// A menu or a colour picker is positioned against its anchor at the moment it
// opens, and then stays where it was put. Scroll the panel underneath and the
// field slides away while the popup doesn't, until the two are in different
// places and the popup is pointing at nothing.
//
// So the panel stops scrolling while one is open. What counts as "one" is asked
// by role — every menu, picker and modal in the panel already says what it is —
// which means a popup added later obeys the rule without being listed anywhere.
// Tooltips are excluded on purpose: they appear on hover, and a panel that
// froze because the pointer paused over a segment would be worse than the
// problem being solved.

const fs = require('fs');
const path = require('path');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};

(async () => {
  const esbuild = require('esbuild');
  const buildDir = path.join(__dirname, '..', 'node_modules', '.stacki-test');
  fs.mkdirSync(buildDir, { recursive: true });
  const out = path.join(buildDir, 'popup-scroll.bundle.js');
  await esbuild.build({
    entryPoints: [path.join(__dirname, '..', 'src', 'ui', 'usePopupOpen.js')],
    outfile: out,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    external: ['react'],
    logLevel: 'silent',
  });

  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  global.window = dom.window;
  global.document = dom.window.document;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  global.MutationObserver = dom.window.MutationObserver;

  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = React;
  const usePopupOpen = require(out).default;

  // Stands in for the panel: a host with the scroller inside it, exactly as
  // StylePanel renders them.
  const Panel = () => {
    const host = React.useRef(null);
    const open = usePopupOpen(host);
    return React.createElement(
      'div',
      { ref: host, className: `style-panel-host ${open ? 'is-locked' : ''}` },
      React.createElement('div', { className: 'embed-editor_root' }, 'panel')
    );
  };

  const root = createRoot(dom.window.document.getElementById('root'));
  await act(async () => {
    root.render(React.createElement(Panel));
  });
  const host = () => dom.window.document.querySelector('.style-panel-host');
  const locked = () => host().className.includes('is-locked');
  // The observers are async; jsdom delivers records on a microtask.
  const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) });

  const put = async (where, html) => {
    const node = dom.window.document.createElement('div');
    node.innerHTML = html;
    const el = node.firstElementChild;
    where.appendChild(el);
    await settle();
    return el;
  };

  check('nothing open, nothing locked', !locked());

  // --- portaled to <body>, which is where a picker or a modal lands ------------
  const picker = await put(dom.window.document.body, '<div role="dialog" aria-label="Color picker"></div>');
  check('a colour picker locks the panel', locked());
  picker.remove();
  await settle();
  check('and closing it lets go', !locked());

  // A modal portals a backdrop with the dialog INSIDE it, so the thing that
  // counts is not always the node that was added.
  const backdrop = await put(
    dom.window.document.body,
    '<div class="embed-editor_bg-modal-backdrop"><div role="dialog"></div></div>'
  );
  check('a dialog nested in a backdrop counts too', locked());
  backdrop.remove();
  await settle();
  check('and unlocks with it', !locked());

  // --- rendered inline, which is where the display/direction menus land --------
  const inline = await put(
    dom.window.document.querySelector('.embed-editor_root'),
    '<div role="menu"></div>'
  );
  check('a menu inside the panel locks it', locked());
  inline.remove();
  await settle();
  check('and closing that one unlocks', !locked());

  const list = await put(dom.window.document.body, '<div role="listbox"></div>');
  check('so does a listbox', locked());
  list.remove();
  await settle();

  // --- what must NOT lock -------------------------------------------------------
  const tip = await put(dom.window.document.body, '<div role="tooltip">Grid lays out…</div>');
  check('a hover tooltip does not lock anything', !locked());
  tip.remove();
  await settle();

  const group = await put(
    dom.window.document.querySelector('.embed-editor_root'),
    '<div role="group"><button role="radio">Block</button></div>'
  );
  check('nor does an ordinary control', !locked());
  group.remove();
  await settle();

  // --- two at once --------------------------------------------------------------
  const first = await put(dom.window.document.body, '<div role="menu"></div>');
  const second = await put(dom.window.document.body, '<div role="dialog"></div>');
  check('two popups still lock', locked());
  first.remove();
  await settle();
  check('and closing one of them does not unlock while the other is up', locked());
  second.remove();
  await settle();
  check('only the last one to close unlocks', !locked());

  await act(async () => { root.unmount() });

  // --- the rule that does the work ---------------------------------------------
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8');
  check(
    'the locked panel stops scrolling',
    /\.style-panel-host\.is-locked > \* \{ overflow-y: hidden; \}/.test(css)
  );
  check(
    'and its gutter is reserved, so losing the bar costs no layout',
    /scrollbar-gutter:\s*stable/.test(css)
  );
  const panel = fs.readFileSync(path.join(__dirname, '..', 'src', 'panels', 'StylePanel.jsx'), 'utf8');
  check('the panel asks', /usePopupOpen\(hostRef\)/.test(panel));
  check('and wears the answer', /popupOpen \? 'is-locked' : ''/.test(panel));

  if (failures.length) {
    console.error(`\npopup-scroll: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`popup-scroll: ${checked} passed  [style panel, locked under a popup]`);
  process.exit(0);
})();
