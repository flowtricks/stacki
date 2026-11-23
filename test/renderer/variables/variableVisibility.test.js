// Goal: the Variables panel lets a person hide a variable from the suggestion dropdowns with one click on an eye over
// the end of its value cell, and the choice lives in the project's tracked `.stacki/variables.json`.
//
//   node test/renderer/variables/variableVisibility.test.js
//
// Method: mount the real VariablesView over a throwaway fixture project (never a user's project) whose metadata
// transport is the real main-process reader and writer, so the file on disk is what is asserted. Events are dispatched
// (no real pointer) and waits poll observable state (test/helpers/waitFor.js). Steps: the eye's visibility is the
// stylesheet's alone (:hover, :focus-visible, aria-pressed, no fill, absolute over the value cell, which reserves its
// end); every layout (plain, colour, chip, curve, matrix) has one eye per value cell and none in a name cell; the icon
// is an eye while visible and an eye with a line through it while hidden, always shown for hidden variables; one click
// writes the file once and flips the eye at once, a keyboard activation too; hover, focus and no-op presses write
// nothing; no popup exists; two quick writes both land; a corrupt file is reported, never written over, and the eye
// rolls back.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { repoPath } = require('../../helpers/sources.js');
const { waitFor } = require('../../helpers/waitFor.js');
const { installToastLog } = require('../../helpers/toastLog.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};
const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

const STYLESHEET = `:root {
  /* Swatches */
  --light-100: #ffffff;
  --dark-900: #1f1d1e;

  /* Typography */
  --h1: 3rem;
  --h1-min: 2;
  --h2: 2rem;
  --h2-min: 1.5;

  /* Opening motion */
  --open-duration: 0.3s;
  --open-ease: cubic-bezier(0.2, 0.8, 0.2, 1);
  --hover-duration: var(--open-duration);
  --accent-fill: #336699;
}
`;

(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-vars-visibility-'));
  fs.mkdirSync(path.join(directory, 'src', 'styles'), { recursive: true });
  const file = path.join(directory, 'src', 'styles', 'tokens.css');
  fs.writeFileSync(file, STYLESHEET);
  const variablesFile = path.join(directory, '.stacki', 'variables.json');

  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test');
  fs.mkdirSync(buildDirectory, { recursive: true });
  const bundlePath = path.join(buildDirectory, 'vars-visibility.bundle.js');
  await esbuild.build({
    stdin: {
      contents: `export { default } from './src/features/variables/VariablesView';
export { subscribeErrorToasts } from './src/ui/errorNotices';
export { forgetHiddenVariables, hiddenVariablesStore, getHiddenVariables } from './src/ipc/hiddenVariables';`,
      resolveDir: repoPath('.'),
      loader: 'ts',
    },
    outfile: bundlePath,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    logLevel: 'silent',
  });

  const cssVars = require('#dist/electron/project/cssVars.js');
  const metadata = require('#dist/electron/project/projectMetadata.js');

  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  require('../../helpers/popupDom').installPopupDOM(dom.window);
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  global.Element = dom.window.Element;
  global.HTMLElement = dom.window.HTMLElement;
  global.Node = dom.window.Node;
  global.HTMLInputElement = dom.window.HTMLInputElement;

  const toasts = [];
  const writes = [];
  dom.window.avb = {
    cssVariables: async () => cssVars.readVariables(directory),
    addCssVariables: async () => ({ ok: true }),
    setCssVariable: async ({ projectPath, ...edit }) => cssVars.setVariable(directory, edit),
    moveCssVariables: async () => ({ ok: true }),
    renameCssVariables: async ({ renames }) => cssVars.renameVariables(directory, { renames }),
    setCssSectionTitle: async () => ({ ok: true }),
    removeCssSection: async () => ({ ok: true }),
    addCssSection: async () => ({ ok: true }),
    moveCssHeading: async () => ({ ok: true }),
    writeStyleFile: async () => ({ ok: true }),
    onCssChanged: () => () => {},
    listStyleFiles: async () => ({ files: [{ path: file, rel: 'src/styles/tokens.css', name: 'tokens.css' }] }),
    listAstroStyleFiles: async () => ({ files: [] }),
    readStyleFile: async () => ({ css: fs.readFileSync(file, 'utf8') }),
    // The project settings transport, backed by the real main-process reader and writer.
    projectMetadata: async ({ kind }) => metadata.readProjectMetadata(directory, kind),
    writeProjectMetadata: async ({ write }) => {
      writes.push(write);
      return metadata.writeProjectMetadata(directory, write);
    },
  };

  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = require('react');
  const bundle = require(bundlePath);
  const VariablesView = bundle.default;

  const container = dom.window.document.getElementById('root');
  const reactRoot = createRoot(container);
  const all = (selector) => [...container.querySelectorAll(selector)];
  const body = dom.window.document.body;
  const nameCell = (name) => all('.vars-name').find((cell) => cell.querySelector('.vars-name-text')?.textContent === name);
  // The gear of a variable: over the end of its value cell, found by the variable it is named for.
  const eye = (name) => all('.vars-cell-host .vars-visibility').find((button) => button.getAttribute('data-variable') === `--${name}`);
  const disk = () => (fs.existsSync(variablesFile) ? fs.readFileSync(variablesFile, 'utf8') : undefined);
  const event = (type, init = {}) => new dom.window.MouseEvent(type, { bubbles: true, ...init });

  const show = async () =>
    act(async () => {
      reactRoot.render(
        React.createElement(VariablesView, {
          project: { path: directory },
          selected: { file: 'src/styles/tokens.css', index: 0 },
          hidden: false,
          onClose: () => {},
          showToast: (message) => toasts.push(message),
          onRecordUndo: () => {},
        }),
      );
      await settle(60);
    });

  await show();
  check(
    'the sheet lists the variables',
    !!nameCell('light-100') && !!nameCell('dark-900'),
    all('.vars-name-text')
      .map((cell) => cell.textContent)
      .join('|'),
  );
  check('no file exists before the first hide', disk() === undefined && !fs.existsSync(path.join(directory, '.stacki')));

  // --- the eye's visibility is the stylesheet's, so nothing in script can leave it stuck ---------------------------
  const css = fs.readFileSync(repoPath('src/app/styles.css'), 'utf8');
  const source = fs.readFileSync(repoPath('src/features/variables/VariableNameCell.tsx'), 'utf8');
  check(
    'no popup, gear, settings or name-mark class is left in the source',
    !/Popup|GearIcon|vars-name-settings|vars-name-tools|vars-name-hidden|aria-haspopup/.test(source),
  );
  check('and none in the stylesheet', !/vars-settings-|vars-name-settings|vars-name-tools|vars-name-hidden/.test(css));
  check('not shown, the eye is transparent and deaf to the pointer', /\.vars-visibility\s*{[^}]*opacity:\s*0;[^}]*pointer-events:\s*none;/.test(css));
  check(
    'shown by :hover on the value cell and :focus-visible on the button',
    /\.vars-cell-host:hover \.vars-visibility,\s*\.vars-visibility:focus-visible\s*{[^}]*opacity:\s*1;[^}]*pointer-events:\s*auto;/.test(css),
  );
  check(
    'a hidden variable keeps its eye on screen, dimmed, and clickable',
    /\.vars-visibility\[aria-pressed='true'\]\s*{[^}]*opacity:\s*0\.55;[^}]*pointer-events:\s*auto;/.test(css),
  );
  check('a row being dragged hides it', /\.vars-row\.is-dragging \.vars-visibility\s*{[^}]*opacity:\s*0;/.test(css));
  check('a touch screen always shows it', /@media \(hover: none\)\s*{\s*\.vars-visibility\s*{[^}]*opacity:\s*1;/.test(css));
  check('no script drives it: no hover, pointer or focus handlers', !/onMouseEnter|onMouseLeave|onFocus|onBlur|onPointer/.test(source));
  check(
    'no fill: the button, its hover and its wrapper set no background colour',
    !/\.vars-visibility[^{]*{[^}]*background:\s*(rgba|var|#|linear)/.test(css) && !/\.vars-cell-tools[^{]*{[^}]*background/.test(css),
  );
  check(
    'hover and press change the colour; focus-visible has a ring',
    /\.vars-visibility:hover\s*{[^}]*color:/.test(css) && /\.vars-visibility:focus-visible\s*{[^}]*outline:/.test(css),
  );
  check(
    'the eye is absolute inside the value cell wrapper, out of flow and centred',
    /\.vars-cell-host\s*{[^}]*position:\s*relative;/.test(css) &&
      /\.vars-cell-tools\s*{[^}]*position:\s*absolute;[^}]*top:\s*50%;[^}]*inset-inline-end:\s*0\.125rem;/.test(css),
  );
  check(
    "the value cell reserves the eye's width at its end, always, so the value stops short and nothing shifts",
    /\.vars-cell-host > \.var-cell\s*{[^}]*padding-inline-end:\s*1\.5rem;/.test(css),
  );
  check('sizes are in rem, not px', !/\.vars-(cell-(host|tools)|visibility)[^{]*{[^}]*(width|height|padding|right|top|margin)[^;]*\dpx/.test(css));
  check(
    'visible: an eye, not pressed, labelled to hide',
    eye('light-100')?.getAttribute('aria-pressed') === 'false' &&
      eye('light-100')?.getAttribute('aria-label') === 'Hide from variable suggestions' &&
      eye('light-100')?.title === 'Hide from variable suggestions',
  );
  const iconMarkup = (name) => eye(name)?.querySelector('svg')?.innerHTML;
  const shownIcon = iconMarkup('light-100');
  check('it draws an icon', !!shownIcon);
  await act(async () => {
    nameCell('light-100').dispatchEvent(event('mouseover', { relatedTarget: body }));
    nameCell('light-100').dispatchEvent(event('mouseout', { relatedTarget: body }));
    nameCell('dark-900').querySelector('.vars-rename').focus();
    eye('dark-900').focus();
    eye('dark-900').blur();
  });
  check('hovering and focusing write nothing', disk() === undefined && writes.length === 0);
  check('and open no popup, dialog or menu', !body.querySelector('[role="dialog"], [role="menu"], [data-popup], .vars-settings-popup'));

  const waitForHidden = (name, hidden) =>
    waitFor({
      what: `${name} reads ${hidden ? 'hidden' : 'shown'}`,
      read: () => eye(name)?.getAttribute('aria-pressed'),
      until: (value) => value === String(hidden),
    });
  const writtenOnce = async (before, what) => {
    await settle(150);
    check(`${what}: written once`, writes.length - before === 1, String(writes.length - before));
  };

  // --- one click: hide ---------------------------------------------------------------------------
  let writesBefore = writes.length;
  await act(async () => {
    eye('light-100').dispatchEvent(event('click'));
  });
  check('the eye flips at once, before the write lands', eye('light-100')?.getAttribute('aria-pressed') === 'true');
  check('into an eye with a line through it', iconMarkup('light-100') !== shownIcon && !!iconMarkup('light-100'));
  check(
    'labelled to show again',
    eye('light-100')?.getAttribute('aria-label') === 'Show in variable suggestions' && eye('light-100')?.title === 'Show in variable suggestions',
  );
  await waitFor({ what: 'the hide is written', read: () => disk(), until: (value) => /--light-100/.test(value || '') });
  await writtenOnce(writesBefore, 'one click');
  const hiddenOnce = '{\n  "version": 1,\n  "hiddenFromSuggestions": [\n    "--light-100"\n  ]\n}\n';
  check('it writes .stacki/variables.json', disk() === hiddenOnce, String(disk()));
  check('and the eye stays hidden once the file agrees', eye('light-100')?.getAttribute('aria-pressed') === 'true');
  check(
    'the name cell carries no mark: the value-cell eye is the only sign',
    !nameCell('light-100').querySelector('.vars-name-hidden, svg + svg, [role="img"]') && eye('light-100')?.getAttribute('aria-pressed') === 'true',
  );
  check('the variable is still listed and editable', !!nameCell('light-100') && all('input.var-input').length > 0);
  check('the other variable is untouched', eye('dark-900')?.getAttribute('aria-pressed') === 'false');
  check('the cached set answers at once', bundle.getHiddenVariables(directory).has('--light-100'));
  check(
    'a hidden variable shows its eye always: the dimmed rule applies to it alone',
    eye('light-100')?.matches("[aria-pressed='true']") && !eye('dark-900')?.matches("[aria-pressed='true']"),
  );

  // --- one click: show ---------------------------------------------------------------------------
  writesBefore = writes.length;
  await act(async () => {
    eye('light-100').dispatchEvent(event('click'));
  });
  check('the eye flips back at once', eye('light-100')?.getAttribute('aria-pressed') === 'false' && iconMarkup('light-100') === shownIcon);
  await waitFor({ what: 'the show is written', read: () => disk(), until: (value) => /\[\]/.test(value || '') });
  await writtenOnce(writesBefore, 'the second click');
  check('the file keeps its shape, empty', disk() === '{\n  "version": 1,\n  "hiddenFromSuggestions": []\n}\n', String(disk()));
  check('and the eye goes back to the eye', eye('light-100')?.getAttribute('aria-pressed') === 'false');

  // --- keyboard: Enter and Space are a native click on a button -------------------------------------
  writesBefore = writes.length;
  await act(async () => {
    eye('dark-900').focus();
    eye('dark-900').click();
  });
  check('Enter or Space (a native click) flips it', eye('dark-900')?.getAttribute('aria-pressed') === 'true');
  await waitFor({ what: 'the keyboard hide is written', read: () => disk(), until: (value) => /--dark-900/.test(value || '') });
  await writtenOnce(writesBefore, 'the keyboard activation');
  check('and the eye keeps focus', dom.window.document.activeElement === eye('dark-900'));
  await act(async () => eye('dark-900').click());
  await waitFor({ what: 'the keyboard show is written', read: () => disk(), until: (value) => /\[\]/.test(value || '') });
  await waitForHidden('dark-900', false);

  // --- every layout: the eye is over the end of the value cell, never in the name cell -------------------------
  const hosts = () => all('.vars-cell-host');
  const cells = all('.vars-scroll-rows .var-cell:not(.empty)');
  check('the sheet draws value cells', cells.length >= 10, String(cells.length));
  check(
    'every value cell is wrapped in the one shared host, with its eye after the value (Tab: value, then eye)',
    cells.every((cell) => {
      const host = cell.parentElement;
      return host?.classList.contains('vars-cell-host') && host.lastElementChild?.classList.contains('vars-cell-tools') && host.firstElementChild === cell;
    }),
  );
  check(
    'each host has exactly one eye, inside its tools box',
    hosts().every((host) => host.querySelectorAll('.vars-visibility').length === 1 && !!host.querySelector(':scope > .vars-cell-tools > .vars-visibility')),
  );
  check(
    'so there is one eye per value cell and none anywhere else',
    all('.vars-visibility').length === cells.length && all('.vars-name .vars-visibility, .vars-fixed .vars-visibility').length === 0,
  );
  const kinds = {
    'a plain list row (light-100)': 'light-100',
    'a colour swatch row (dark-900)': 'dark-900',
    'a duration row (open-duration)': 'open-duration',
    'a curve row (open-ease)': 'open-ease',
    'a chip value row (hover-duration)': 'hover-duration',
    'a matrix value cell (h1)': 'h1',
    'a matrix part cell (h2-min)': 'h2-min',
  };
  for (const [what, name] of Object.entries(kinds)) {
    const button = eye(name);
    check(`${what} has its eye over the end of its value cell`, !!button && button.closest('.vars-cell-host')?.querySelector(':scope > .var-cell') !== null);
  }
  const valueMarkup = hosts().map((host) => host.querySelector(':scope > .var-cell').outerHTML);
  writesBefore = writes.length;
  await act(async () => {
    eye('h2').dispatchEvent(event('click'));
  });
  await waitFor({ what: 'h2 is written hidden', read: () => disk(), until: (value) => /--h2"/.test(value || '') });
  await writtenOnce(writesBefore, 'a matrix column');
  check(
    'a matrix eye acts on its own variable: h2, not h1',
    JSON.parse(disk()).hiddenFromSuggestions.join() === '--h2' && eye('h1')?.getAttribute('aria-pressed') === 'false',
    String(disk()),
  );
  check(
    'and left the value cells untouched',
    hosts()
      .map((host) => host.querySelector(':scope > .var-cell').outerHTML)
      .join() === valueMarkup.join(),
  );
  await act(async () => {
    eye('h2').dispatchEvent(event('click'));
  });
  await waitFor({ what: 'h2 is shown again', read: () => disk(), until: (value) => /\[\]/.test(value || '') });

  // --- rename and the row are not broken by the button --------------------------------------------
  await act(async () => {
    nameCell('dark-900').querySelector('.vars-rename').dispatchEvent(event('click'));
  });
  check('a click on the name still opens the rename field', all('.vars-rename-input').length === 1);
  await act(async () => {
    all('.vars-rename-input')[0].dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  check(
    'the name carries the drag-through mark so a drag still starts there',
    nameCell('dark-900').querySelector('.vars-rename')?.hasAttribute('data-drag-through'),
  );
  check('the button is a real button, which the reorder hook leaves alone', eye('dark-900')?.tagName === 'BUTTON');

  // --- two quick toggles both land (writes are serialized) ----------------------------------------
  const store = bundle.hiddenVariablesStore(directory);
  const [first, second] = await act(async () => Promise.all([store.hide('--b-name'), store.hide('--a-name')]));
  check('two toggles in a row both succeed', first.ok && second.ok);
  check('and both are in the file, sorted', JSON.parse(disk()).hiddenFromSuggestions.join() === '--a-name,--b-name', String(disk()));
  const again = await store.hide('--a-name');
  check('hiding a hidden name is a quiet no-op', again.ok && JSON.parse(disk()).hiddenFromSuggestions.length === 2);
  const bad = await store.hide('not-a-name');
  check('a bad name is an error value, not a crash', !bad.ok);

  // --- a file changed behind our back is merged, not lost ------------------------------------------
  fs.writeFileSync(variablesFile, '{\n  "version": 1,\n  "hiddenFromSuggestions": [\n    "--a-name",\n    "--b-name",\n    "--c-name"\n  ]\n}\n');
  const merged = await store.hide('--d-name');
  check(
    'an outside edit between toggles is kept',
    merged.ok && JSON.parse(disk()).hiddenFromSuggestions.join() === '--a-name,--b-name,--c-name,--d-name',
    String(disk()),
  );

  // --- a corrupt file is reported and never written over -------------------------------------------
  const corrupt = '{ "version": 1, "hiddenFromSuggestions": [oops';
  fs.writeFileSync(variablesFile, corrupt);
  bundle.forgetHiddenVariables();
  await act(async () => reactRoot.unmount());
  const reported = installToastLog(bundle.subscribeErrorToasts);
  const secondRoot = createRoot(container);
  await act(async () => {
    secondRoot.render(
      React.createElement(VariablesView, {
        project: { path: directory },
        selected: { file: 'src/styles/tokens.css', index: 0 },
        hidden: false,
        onClose: () => {},
        showToast: (message) => toasts.push(message),
        onRecordUndo: () => {},
      }),
    );
    await settle(80);
  });
  check(
    'a corrupt file is reported as a toast, with no paragraph in the panel',
    reported.messages().length > 0 && !container.querySelector('.vars-notice'),
    container.innerHTML.slice(0, 200),
  );
  check('it reads as nothing hidden', bundle.getHiddenVariables(directory).size === 0);
  await act(async () => {
    nameCell('light-100').dispatchEvent(event('mouseover', { relatedTarget: body }));
  });
  let flipped;
  await act(async () => {
    eye('light-100').dispatchEvent(event('click'));
    flipped = eye('light-100')?.getAttribute('aria-pressed');
  });
  check('the click sets the eye at once, before the refusal comes back', flipped !== undefined);
  await waitFor({ what: 'the eye rolls back', read: () => eye('light-100')?.getAttribute('aria-pressed'), until: (value) => value === 'false' });
  check('the eye rolled back to what the file says', eye('light-100')?.getAttribute('aria-pressed') === 'false');
  check('a click does not overwrite it', disk() === corrupt, String(disk()));
  check(
    'and says so',
    toasts.some((message) => /Could not save/.test(message)),
    toasts.join('|'),
  );

  await act(async () => secondRoot.unmount());
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

  if (failures.length) {
    console.error(`\nvariable-visibility: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`variable-visibility: ${checked} passed`);
})();
