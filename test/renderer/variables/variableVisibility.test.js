// Goal: the Variables panel lets a person hide a variable from the suggestion dropdowns, and the choice lives in the
// project's tracked `.stacki/variables.json`.
//
//   node test/renderer/variables/variableVisibility.test.js
//
// Method: mount the real VariablesView over a throwaway fixture project (never a user's project) whose metadata
// transport is the real main-process reader and writer, so the file on disk is what is asserted. Hover and focus are
// dispatched as events (no pointer, no timers). Steps: the icon is absent until the name is hovered or focused and its
// space is reserved either way; clicking it opens the shared menu and does not start a rename; choosing the row writes
// the file and draws the indicator; choosing it again shows the variable; rename still opens from a click; two quick
// toggles both land; a corrupt file is reported and never written over; no file exists before the first hide.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { repoPath } = require('../../helpers/sources.js');

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
export { forgetHiddenVariables, hiddenVariablesStore, getHiddenVariables } from './src/features/variables/hiddenVariables';`,
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
    writeProjectMetadata: async ({ write }) => metadata.writeProjectMetadata(directory, write),
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
  const menuRow = () => [...body.querySelectorAll('[role^="menuitem"]')].find((row) => /Hide from variable suggestions/.test(row.textContent));
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

  // --- the button appears on hover and keeps its space ------------------------------------------
  const toolsBefore = nameCell('light-100').querySelector('.vars-name-tools');
  check('the button has its space before anything is hovered', !!toolsBefore);
  check('and is not shown or focusable', settingsButton('light-100')?.hidden === true);
  const css = fs.readFileSync(repoPath('src/app/styles.css'), 'utf8');
  check(
    'the reserved space is fixed, in rem',
    /\.vars-name-tools\s*{[^}]*flex:\s*none;[^}]*width:\s*1\.25rem;/.test(css) && !/\.vars-name-(tools|settings|hidden)\s*{[^}]*\dpx/.test(css),
  );
  await act(async () => {
    nameCell('light-100').dispatchEvent(event('mouseover', { relatedTarget: body }));
  });
  check('hovering the name shows the button', settingsButton('light-100')?.hidden === false);
  check('in the same box, so nothing shifts', nameCell('light-100').querySelector('.vars-name-tools') === toolsBefore);
  check('the other rows are untouched', settingsButton('dark-900')?.hidden === true);
  check('the button is named for its variable', /light-100/.test(settingsButton('light-100')?.getAttribute('aria-label') || ''));
  await act(async () => {
    nameCell('light-100').dispatchEvent(event('mouseout', { relatedTarget: body }));
  });
  check('moving off hides it again', settingsButton('light-100')?.hidden === true);

  // --- keyboard: focus in the cell reveals it, and it takes focus ---------------------------------
  await act(async () => {
    nameCell('dark-900').querySelector('.vars-rename').focus();
  });
  check('focus on the name reveals the button for the keyboard', settingsButton('dark-900')?.hidden === false);
  await act(async () => {
    settingsButton('dark-900').focus();
  });
  check('and the button can take focus', dom.window.document.activeElement === settingsButton('dark-900'));
  await act(async () => {
    settingsButton('dark-900').blur();
  });
  check('leaving the cell hides it', settingsButton('dark-900')?.hidden === true);

  // --- the menu --------------------------------------------------------------------------------
  await act(async () => {
    nameCell('light-100').dispatchEvent(event('mouseover', { relatedTarget: body }));
  });
  await act(async () => {
    settingsButton('light-100').dispatchEvent(event('click'));
    await settle(40);
  });
  check('clicking the button opens the shared menu', !!menuRow(), body.innerHTML.slice(0, 200));
  check('without starting a rename', all('.vars-rename-input').length === 0);
  check('the row is a choice that is not checked yet', menuRow()?.getAttribute('aria-checked') === 'false', menuRow()?.outerHTML);

  await act(async () => {
    menuRow().dispatchEvent(event('click'));
    await settle(150);
  });
  const hiddenOnce = '{\n  "version": 1,\n  "hiddenFromSuggestions": [\n    "--light-100"\n  ]\n}\n';
  check('choosing it writes .stacki/variables.json', disk() === hiddenOnce, String(disk()));
  check('the variable is marked hidden in the panel', !!nameCell('light-100').querySelector('.vars-name-hidden'));
  check(
    'the mark says why',
    /Hidden from variable suggestions/.test(nameCell('light-100').querySelector('.vars-name-hidden')?.getAttribute('aria-label') || ''),
  );
  check('the variable is still listed and editable', !!nameCell('light-100') && all('input.var-input').length > 0);
  check('the other variable has no mark', !nameCell('dark-900').querySelector('.vars-name-hidden'));
  check('the cached set answers at once', bundle.getHiddenVariables(directory).has('--light-100'));

  // --- show it again ---------------------------------------------------------------------------
  await act(async () => {
    settingsButton('light-100').dispatchEvent(event('click'));
    await settle(40);
  });
  check('the row reads as checked while hidden', menuRow()?.getAttribute('aria-checked') === 'true', menuRow()?.outerHTML);
  await act(async () => {
    menuRow().dispatchEvent(event('click'));
    await settle(150);
  });
  check(
    'choosing it again shows the variable: the file keeps its shape, empty',
    disk() === '{\n  "version": 1,\n  "hiddenFromSuggestions": []\n}\n',
    String(disk()),
  );
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
  await act(async () => {
    settingsButton('light-100').dispatchEvent(event('click'));
    await settle(40);
  });
  await act(async () => {
    menuRow().dispatchEvent(event('click'));
    await settle(150);
  });
  check('a toggle does not overwrite it', disk() === corrupt, String(disk()));
  check(
    'and says so',
    toasts.some((message) => /Could not save/.test(message)),
    toasts.join('|'),
  );

  await act(async () => secondRoot.unmount());
  fs.rmSync(directory, { recursive: true, force: true });

  if (failures.length) {
    console.error(`\nvariable-visibility: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`variable-visibility: ${checked} passed`);
})();
