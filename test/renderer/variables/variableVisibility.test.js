// Goal: the Variables panel lets a person hide a variable from the suggestion dropdowns, and the choice lives in the
// project's tracked `.stacki/variables.json`.
//
//   node test/renderer/variables/variableVisibility.test.js
//
// Method: mount the real VariablesView over a throwaway fixture project (never a user's project) whose metadata
// transport is the real main-process reader and writer, so the file on disk is what is asserted. Events are dispatched
// (no real pointer) and waits poll observable state (test/helpers/waitFor.js). Steps: the gear's visibility is the
// stylesheet's alone (:hover, :focus-visible, aria-expanded) with no script flag; the gear opens a popup (role dialog,
// not a menu); an outside press (repeated), Escape, a second press on the gear, another row's gear and choosing the
// action each close it, one popup at a time; hovering, focusing, opening and closing write nothing; choosing writes
// the file exactly once (a double click too) and the inverse action shows the variable again; the keyboard path;
// rename still opens from a click; two quick writes both land; a corrupt file is reported and never written over.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { repoPath } = require('../../helpers/sources.js');
const { waitFor } = require('../../helpers/waitFor.js');

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
  const settingsButton = (name) => nameCell(name)?.querySelector('.vars-name-settings');
  const popup = () => body.querySelector('.vars-settings-popup');
  const action = () => popup()?.querySelector('button.menu-row');
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

  // --- the button's visibility is the stylesheet's, so nothing in script can leave it stuck ------------------------
  const toolsBefore = nameCell('light-100').querySelector('.vars-name-tools');
  check('the button has its space before anything is hovered', !!toolsBefore);
  const css = fs.readFileSync(repoPath('src/app/styles.css'), 'utf8');
  check(
    'the reserved space is fixed, in rem',
    /\.vars-name-tools\s*{[^}]*flex:\s*none;[^}]*width:\s*1\.25rem;/.test(css) && !/\.vars-name-(tools|settings|hidden)\s*{[^}]*\dpx/.test(css),
  );
  check('not shown, it is transparent and deaf to the pointer', /\.vars-name-settings\s*{[^}]*opacity:\s*0;[^}]*pointer-events:\s*none;/.test(css));
  check(
    'shown by :hover on the cell, :focus-visible on the button and the open popup',
    /\.vars-name:hover \.vars-name-settings,\s*\.vars-name-settings:focus-visible,\s*\.vars-name-settings\[aria-expanded='true'\]\s*{[^}]*opacity:\s*1;/.test(
      css,
    ),
  );
  check('a row being dragged hides it', /\.vars-row\.is-dragging \.vars-name-settings:not\(\[aria-expanded='true'\]\)\s*{[^}]*opacity:\s*0;/.test(css));
  check('a touch screen always shows it', /@media \(hover: none\)\s*{\s*\.vars-name-settings\s*{[^}]*opacity:\s*1;/.test(css));
  const source = fs.readFileSync(repoPath('src/features/variables/VariableNameCell.tsx'), 'utf8');
  check('no script state drives it: no hover or focus handlers on the cell', !/onMouseEnter|onMouseLeave|onFocus|onBlur|useState/.test(source));
  check('the button is never `hidden`, so Tab reaches it', settingsButton('light-100')?.hidden === false && settingsButton('dark-900')?.hidden === false);
  check('the button is named for its variable', /light-100/.test(settingsButton('light-100')?.getAttribute('aria-label') || ''));
  check('and announces a dialog it controls', settingsButton('light-100')?.getAttribute('aria-haspopup') === 'dialog');
  check('closed, it reads as not expanded', settingsButton('light-100')?.getAttribute('aria-expanded') === 'false');
  await act(async () => {
    nameCell('light-100').dispatchEvent(event('mouseover', { relatedTarget: body }));
    nameCell('light-100').dispatchEvent(event('mouseout', { relatedTarget: body }));
    nameCell('dark-900').querySelector('.vars-rename').focus();
    settingsButton('dark-900').focus();
    settingsButton('dark-900').blur();
  });
  check('hovering and focusing write nothing', disk() === undefined);
  check('and open nothing', !popup() && settingsButton('dark-900')?.getAttribute('aria-expanded') === 'false');

  // --- the popup ---------------------------------------------------------------------------------
  const open = async (name) => {
    await act(async () => {
      settingsButton(name).dispatchEvent(event('click'));
    });
    await waitFor({ what: `the settings popup of ${name} is open`, read: () => !!popup(), until: Boolean });
  };
  const close = async (what) =>
    waitFor({ what: `the popup is gone after ${what}`, read: () => !popup() && !body.querySelector('[data-popup]'), until: Boolean });
  const keydown = (target, key) => target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

  await open('light-100');
  check('clicking the button opens a popup, a dialog and not a menu', popup()?.getAttribute('role') === 'dialog' && !body.querySelector('[role="menu"]'));
  check('the popup is named', popup()?.getAttribute('aria-label') === 'Variable settings');
  check('and titled with the variable', /--light-100/.test(popup()?.querySelector('.vars-settings-title')?.textContent || ''));
  check('the button reads as expanded', settingsButton('light-100')?.getAttribute('aria-expanded') === 'true');
  check('without starting a rename', all('.vars-rename-input').length === 0);
  check('the action has its icon on the left', !!action()?.querySelector('.menu-icon svg') && action()?.firstElementChild?.className === 'menu-icon');
  check('and focus is on it', dom.window.document.activeElement === action());
  check('opening wrote nothing', disk() === undefined);

  // Each way out closes it, every time.
  const pressOutside = async () =>
    act(async () => {
      container.dispatchEvent(event('pointerdown'));
      container.dispatchEvent(event('mousedown'));
    });
  await pressOutside();
  await close('the first look');
  for (let round = 0; round < 3; round += 1) {
    await open('light-100');
    await pressOutside();
    await close(`an outside press (round ${round})`);
    check(`an outside press closes it (round ${round})`, !popup() && settingsButton('light-100')?.getAttribute('aria-expanded') === 'false');
  }
  check('closing by an outside press wrote nothing', disk() === undefined);

  await open('light-100');
  await act(async () => keydown(action(), 'Escape'));
  await close('Escape');
  check('Escape closes it', !popup());
  check('and returns focus to the gear', dom.window.document.activeElement === settingsButton('light-100'));

  await open('light-100');
  await act(async () => {
    settingsButton('light-100').dispatchEvent(event('click'));
  });
  await close('a second press on the gear');
  check('the gear toggles it shut', !popup());

  await open('light-100');
  await act(async () => {
    settingsButton('dark-900').dispatchEvent(event('pointerdown'));
    settingsButton('dark-900').dispatchEvent(event('mousedown'));
  });
  await close("another row's press");
  // The press that closed the popup also swallows the click that follows it (popupDismiss), so the click that opens
  // the other row is the next one.
  await act(async () => {
    settingsButton('dark-900').dispatchEvent(event('click'));
  });
  await act(async () => {
    if (!popup()) {
      settingsButton('dark-900').dispatchEvent(event('click'));
    }
  });
  await waitFor({ what: 'the other row opens its own popup', read: () => !!popup(), until: Boolean });
  check(
    'only one popup is open, and it is the other row',
    body.querySelectorAll('.vars-settings-popup').length === 1 && /--dark-900/.test(popup().textContent),
  );
  check('the first row reads as closed', settingsButton('light-100')?.getAttribute('aria-expanded') === 'false');
  await pressOutside();
  await close('cleanup');
  check('opening and closing never wrote the file', disk() === undefined);

  // --- keyboard ----------------------------------------------------------------------------------
  await act(async () => {
    settingsButton('light-100').focus();
    settingsButton('light-100').click();
  });
  await waitFor({ what: 'the popup opens from the keyboard activation', read: () => !!popup(), until: Boolean });
  check('Enter or Space on the gear (a native click) opens it with focus inside', popup()?.contains(dom.window.document.activeElement));
  await act(async () => keydown(action(), 'ArrowDown'));
  await act(async () => keydown(action(), 'End'));
  check('arrow keys keep focus on the only action', dom.window.document.activeElement === action());
  await act(async () => keydown(action(), 'Escape'));
  await close('Escape from the keyboard');
  check('the gear has focus again', dom.window.document.activeElement === settingsButton('light-100'));

  // --- choosing writes the file exactly once ----------------------------------------------------------
  await open('light-100');
  check('the action offers to hide', /Hide from variable suggestions/.test(action()?.textContent || ''));
  const writesBefore = writes.length;
  await act(async () => {
    action().dispatchEvent(event('click'));
    action().dispatchEvent(event('click'));
  });
  await waitFor({ what: 'the hide is written', read: () => disk(), until: (value) => value !== undefined });
  await settle(100);
  const hiddenOnce = '{\n  "version": 1,\n  "hiddenFromSuggestions": [\n    "--light-100"\n  ]\n}\n';
  check('choosing it writes .stacki/variables.json', disk() === hiddenOnce, String(disk()));
  check('exactly once, even for a double click', writes.length - writesBefore === 1, String(writes.length - writesBefore));
  await close('the choice');
  check('and closes the popup', !popup() && settingsButton('light-100')?.getAttribute('aria-expanded') === 'false');
  check('the variable is marked hidden in the panel', !!nameCell('light-100').querySelector('.vars-name-hidden'));
  check(
    'the mark says why',
    /Hidden from variable suggestions/.test(nameCell('light-100').querySelector('.vars-name-hidden')?.getAttribute('aria-label') || ''),
  );
  check('the variable is still listed and editable', !!nameCell('light-100') && all('input.var-input').length > 0);
  check('the other variable has no mark', !nameCell('dark-900').querySelector('.vars-name-hidden'));
  check('the cached set answers at once', bundle.getHiddenVariables(directory).has('--light-100'));

  // --- show it again -----------------------------------------------------------------------------------
  await open('light-100');
  check('a hidden variable offers the inverse', /Show in variable suggestions/.test(action()?.textContent || ''), action()?.textContent);
  await act(async () => {
    action().dispatchEvent(event('click'));
  });
  await waitFor({ what: 'the show is written', read: () => disk(), until: (value) => /\[\]/.test(value || '') });
  check('choosing it shows the variable: the file keeps its shape, empty', disk() === '{\n  "version": 1,\n  "hiddenFromSuggestions": []\n}\n', String(disk()));
  await close('the second choice');
  check('and the mark goes', !nameCell('light-100').querySelector('.vars-name-hidden'));

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
  check('the button is a real button, which the reorder hook leaves alone', settingsButton('dark-900')?.tagName === 'BUTTON');

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
  check('a corrupt file is reported in the panel', !!container.querySelector('.vars-notice'), container.innerHTML.slice(0, 200));
  check('it reads as nothing hidden', bundle.getHiddenVariables(directory).size === 0);
  await act(async () => {
    nameCell('light-100').dispatchEvent(event('mouseover', { relatedTarget: body }));
  });
  await open('light-100');
  await act(async () => {
    action().dispatchEvent(event('click'));
    await settle(250);
  });
  check('a toggle does not overwrite it', disk() === corrupt, String(disk()));
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
