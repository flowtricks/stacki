// Two ways of writing the same grid.
//
//   node test/renderer/style/gridTracks.test.js
//
//   repeat(2, minmax(0, 1fr))        the count, said once
//   minmax(0, 1fr) minmax(0, 1fr)    the tracks, written out
//
// The panel had both and no way to choose: the count stepper writes repeat(),
// and touching a track in the grid settings writes them all out — so which form
// a stylesheet ended up with depended on which control you had last used, and
// there was no way back. The grid settings now offer the switch, and this is
// what it does: the same grid, said the other way, and nothing offered when
// there is no choice to make.
//
// It also holds the Columns and Rows count to what it can say: N equal tracks keep
// the stepper, and every other value (auto-fit, subgrid, named lines, mixed sizes,
// a variable count) shows itself as editable text, validated, written exactly as
// typed, and turned into a count only by the explicit "Switch to count".

const fs = require('fs');
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

(async () => {
  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test');
  fs.mkdirSync(buildDirectory, { recursive: true });
  const bundlePath = path.join(buildDirectory, 'grid-tracks.bundle.js');
  await esbuild.build({
    entryPoints: [repoPath('src/features/style/model/gridTemplate.ts')],
    outfile: bundlePath,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    loader: { '.ts': 'ts' },
    logLevel: 'silent',
  });
  const AUTOFIT = 'repeat(auto-fit, minmax(min(100%, 20rem), 1fr))';

  // --- the grid settings: one mode control per axis ----------------------------
  // Mounted rather than read: Count, Custom and Subgrid, the mode taken from the value,
  // and only the control for that mode under it.
  {
    const entry = path.join(buildDirectory, 'grid-settings.entry.jsx');
    fs.writeFileSync(
      entry,
      `export { default as GridSettings } from ${JSON.stringify(repoPath('src/features/style/GridSettings.tsx'))};\nexport { ConfirmHost } from ${JSON.stringify(repoPath('src/ui/ConfirmDialog.tsx'))};\n`,
    );
    const uiPath = path.join(buildDirectory, 'grid-settings.bundle.js');
    await esbuild.build({
      entryPoints: [entry],
      outfile: uiPath,
      bundle: true,
      format: 'cjs',
      platform: 'node',
      jsx: 'automatic',
      external: ['react', 'react-dom', 'react/jsx-runtime'],
      loader: { '.tsx': 'tsx', '.ts': 'ts' },
      logLevel: 'silent',
    });

    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
    require('../../helpers/popupDom').installPopupDOM(dom.window);
    global.window = dom.window;
    // The pickers listen for variable changes, as they do under the real preload.
    dom.window.avb = { onCssChanged: () => () => {} };
    global.document = dom.window.document;
    global.navigator = dom.window.navigator;
    global.Element = dom.window.Element;
    global.HTMLElement = dom.window.HTMLElement;
    global.Node = dom.window.Node;
    global.IS_REACT_ACT_ENVIRONMENT = true;
    global.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
    global.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);

    const React = require('react');
    const { createRoot } = require('react-dom/client');
    const { act } = require('react');
    const { GridSettings, ConfirmHost } = require(uiPath);

    // The panel writes to the stylesheet and reads it back; here that round trip
    // is this map, so an edit is visible to the next one.
    const written = [];
    const cleared = [];
    const values = {};
    const container = dom.window.document.getElementById('root');
    let root = createRoot(container);
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const paint = () =>
      act(async () => {
        root.render(
          React.createElement(
            React.Fragment,
            {},
            React.createElement(GridSettings, {
              read: (prop) =>
                values[prop] === undefined
                  ? undefined
                  : {
                      source: 'selected',
                      selectedValue: { value: values[prop], important: false },
                      winner: { value: values[prop], important: false },
                      contributors: [],
                    },
              busy: false,
              setProp: (prop, value, imp) => {
                written.push([prop, value, !!imp]);
                values[prop] = value;
              },
              clearProp: (prop) => {
                cleared.push(prop);
                delete values[prop];
              },
              onProvenance: () => {},
              onSelectSelector: () => {},
              onClose: () => {},
            }),
            React.createElement(ConfirmHost),
          ),
        );
        await wait(20);
      });
    // Each scenario opens the settings afresh on its own values.
    const show = async (next) => {
      await act(async () => {
        root.unmount();
        await wait(5);
      });
      root = createRoot(container);
      for (const key of Object.keys(values)) {
        delete values[key];
      }
      Object.assign(values, next);
      written.length = 0;
      cleared.length = 0;
      await paint();
    };
    const popupDocument = dom.window.document;
    const group = (title) => popupDocument.querySelector(`[role="radiogroup"][aria-label="${title} mode"]`);
    const selected = (title) => group(title)?.querySelector('[aria-checked="true"]')?.textContent;
    const choose = async (title, label) => {
      await act(async () => {
        [...(group(title)?.querySelectorAll('button') ?? [])].find((button) => button.textContent === label)?.click();
        await wait(20);
      });
      await paint();
    };
    const stepper = (title) => popupDocument.querySelector(`input[aria-label="${title} count"]`);
    const text = (title) => popupDocument.querySelector(`input[aria-label="${title} expression"]`);
    const primary = () => popupDocument.querySelector('.confirm-dialog button.primary');
    const cancel = () => [...popupDocument.querySelectorAll('.confirm-dialog button')].find((button) => !button.classList.contains('primary'));
    const settle = (ms) =>
      act(async () => {
        await wait(ms);
      });

    // N equal tracks: Count, with the stepper and nothing else.
    await show({ 'grid-template-columns': 'repeat(2, minmax(0, 1fr))' });
    check(
      'the three modes are there',
      [...(group('Columns')?.querySelectorAll('button') ?? [])].map((segment) => segment.textContent).join('|') === 'Count|Custom|Subgrid',
    );
    check('equal tracks are Count', selected('Columns') === 'Count', selected('Columns'));
    check('with the stepper showing the count', stepper('Columns')?.value === '2', stepper('Columns')?.value);
    check('and no text field', !text('Columns'));
    check('Rows has the same control', !!group('Rows'));
    check(
      'no count in parentheses after the name',
      group('Columns')?.closest('section')?.querySelector('.embed-editor_grid-section-head')?.textContent === 'Columns',
      group('Columns')?.closest('section')?.querySelector('.embed-editor_grid-section-head')?.textContent,
    );
    check('no loose switch or link', !/Switch to count/.test(popupDocument.body.textContent) && !popupDocument.querySelector('.embed-editor_switch'));

    // Custom on a count opens the text and writes nothing; Count goes back without asking.
    await choose('Columns', 'Custom');
    check('Custom opens the text of the same value', text('Columns')?.value === 'repeat(2, minmax(0, 1fr))', text('Columns')?.value);
    check('and writes nothing', written.length === 0, JSON.stringify(written));
    check('with Custom shown', selected('Columns') === 'Custom');
    await choose('Columns', 'Count');
    check('Count goes back to the stepper', !!stepper('Columns') && !text('Columns'));
    check('without a question or a write', !primary() && written.length === 0, JSON.stringify(written));

    // A complex value is Custom: its own text, no number, no stepper.
    await show({ 'grid-template-columns': AUTOFIT });
    check('auto-fit is Custom', selected('Columns') === 'Custom', selected('Columns'));
    check('showing the value itself', text('Columns')?.value === AUTOFIT, text('Columns')?.value);
    check('with no stepper', !stepper('Columns'));
    check('and the value shown once, not also as a pill', popupDocument.body.textContent.split(AUTOFIT).length <= 2);

    // Count on it asks first; no is no, yes writes the count.
    await choose('Columns', 'Count');
    check('Count on a complex value asks first', !!primary() && written.length === 0, JSON.stringify(written));
    check('and shows what it replaces as code', !!popupDocument.querySelector('.confirm-dialog code, .confirm-dialog .code-inline'));
    await act(async () => {
      cancel()?.click();
      await wait(20);
    });
    await settle(400);
    check('cancelling writes nothing', written.length === 0, JSON.stringify(written));
    await show({ 'grid-template-columns': '100px 1fr 2fr' });
    await choose('Columns', 'Count');
    await act(async () => {
      primary()?.click();
      await wait(400);
    });
    check(
      'confirming writes a count of its tracks',
      JSON.stringify(written[0]) === '["grid-template-columns","repeat(3, minmax(0, 1fr))",false]',
      JSON.stringify(written),
    );
    await paint();
    check('and the control reads Count', selected('Columns') === 'Count', selected('Columns'));

    // Typing in Custom writes exactly what was typed, and refuses what is not a track list.
    const typeText = async (element, value, key) => {
      await act(async () => {
        element.focus();
        const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
        setValue.call(element, value);
        element.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
        element.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true }));
        await wait(10);
      });
    };
    await show({ 'grid-template-columns': AUTOFIT });
    await typeText(text('Columns'), 'repeat(auto-fill, minmax(10rem, 1fr))', 'Enter');
    check(
      'Enter writes exactly the typed value',
      JSON.stringify(written[0]) === '["grid-template-columns","repeat(auto-fill, minmax(10rem, 1fr))",false]',
      JSON.stringify(written),
    );
    await show({ 'grid-template-columns': AUTOFIT });
    await typeText(text('Columns'), 'repeat(auto-fit, minmax(10rem, 1fr)', 'Enter');
    check('an unbalanced value writes nothing', written.length === 0, JSON.stringify(written));
    check('and shows the error', text('Columns')?.getAttribute('aria-invalid') === 'true');
    await typeText(text('Columns'), 'repeat(2, 1fr)', 'Escape');
    check('Escape puts the value back', text('Columns')?.value === AUTOFIT, text('Columns')?.value);

    // Subgrid remembers the value it replaces and puts it back.
    await show({ 'grid-template-columns': 'repeat(2, minmax(0, 1fr))', 'grid-template-rows': 'auto' });
    await choose('Columns', 'Subgrid');
    check('Subgrid writes subgrid', JSON.stringify(written[0]) === '["grid-template-columns","subgrid",false]', JSON.stringify(written));
    check('and is selected', selected('Columns') === 'Subgrid', selected('Columns'));
    check('with only a muted note under it', /parent grid/.test(popupDocument.body.textContent) && !text('Columns') && !stepper('Columns'));
    await choose('Columns', 'Count');
    check(
      'leaving it puts the tracks back',
      JSON.stringify(written[1]) === '["grid-template-columns","repeat(2, minmax(0, 1fr))",false]',
      JSON.stringify(written),
    );
    check(
      'Rows is untouched',
      written.every((entry) => entry[0] === 'grid-template-columns'),
    );
    await show({ 'grid-template-rows': 'repeat(2, auto)' });
    await choose('Rows', 'Subgrid');
    check('Rows works the same way', JSON.stringify(written[0]) === '["grid-template-rows","subgrid",false]', JSON.stringify(written));
    await show({});
    await choose('Columns', 'Subgrid');
    await choose('Columns', 'Count');
    check('with nothing to put back, leaving it clears the value', JSON.stringify(cleared) === '["grid-template-columns"]', JSON.stringify(cleared));
    await show({ 'grid-template-columns': 'subgrid [start] [end]' });
    check('subgrid with line names is Subgrid', selected('Columns') === 'Subgrid', selected('Columns'));
    await show({ 'grid-template-columns': 'repeat(var(--_cols), minmax(0, 1fr))' });
    check('a repeat counted by a variable is Custom', selected('Columns') === 'Custom', selected('Columns'));
    await act(async () => {
      root.unmount();
      await wait(5);
    });

    // --- the Columns and Rows counts in the Layout section ----------------------
    // Mounted with each value on the selected selector. N equal tracks keep the
    // stepper; every other value shows ITSELF as editable text with no stepper, and
    // only the "Switch to count" button turns it into a count, after a question.
    const controlsEntry = path.join(buildDirectory, 'grid-controls.entry.jsx');
    fs.writeFileSync(
      controlsEntry,
      `export { default as GridControls } from ${JSON.stringify(repoPath('src/features/style/GridControls.tsx'))};\n` +
        `export { ConfirmHost } from ${JSON.stringify(repoPath('src/ui/ConfirmDialog.tsx'))};\n`,
    );
    const controlsPath = path.join(buildDirectory, 'grid-controls.bundle.js');
    await esbuild.build({
      entryPoints: [controlsEntry],
      outfile: controlsPath,
      bundle: true,
      format: 'cjs',
      platform: 'node',
      jsx: 'automatic',
      external: ['react', 'react-dom', 'react/jsx-runtime'],
      loader: { '.tsx': 'tsx', '.ts': 'ts' },
      logLevel: 'silent',
    });
    const { GridControls, ConfirmHost: ControlsConfirmHost } = require(controlsPath);
    // The Direction control measures itself; jsdom lays nothing out, so there is nothing to observe.
    global.ResizeObserver = dom.window.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    const countWrites = [];
    let source = 'selected';
    const mountCounts = async (values, from = 'selected') => {
      countWrites.length = 0;
      source = from;
      root = createRoot(container);
      await act(async () => {
        root.render(
          React.createElement(
            React.Fragment,
            {},
            React.createElement(GridControls, {
              read: (prop) =>
                values[prop] === undefined
                  ? undefined
                  : {
                      source,
                      selectedValue: source === 'selected' ? { value: values[prop], important: false } : undefined,
                      winner: { value: values[prop], important: false },
                      contributors: [],
                    },
              busy: false,
              setProp: (prop, value, imp) => countWrites.push([prop, value, !!imp]),
              clearProp: () => {},
              liveSetProp: () => {},
              onProvenance: () => {},
              onSelectSelector: () => {},
            }),
            React.createElement(ControlsConfirmHost),
          ),
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    };
    const unmountCounts = () =>
      act(async () => {
        root.unmount();
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
    const count = (label) => container.querySelector(`input[aria-label="${label}"]`);
    const arrows = (label) => [...(count(label)?.closest('.embed-editor_grid-count')?.querySelectorAll('.embed-editor_grid-count-steppers button') ?? [])];
    const gearLit = () => container.querySelector('button[aria-label="Configure grid"]')?.classList.contains('is-active') === true;
    const typeInto = async (element, text, keys) => {
      await act(async () => {
        element.focus();
        const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
        setValue.call(element, text);
        element.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
        for (const key of keys) {
          element.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true }));
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    };

    // The owner's report: auto-fit used to read "1".
    await mountCounts({ 'grid-template-columns': AUTOFIT });
    check('an auto-fit list shows its own value, not a count', count('Grid columns')?.value === AUTOFIT, count('Grid columns')?.value);
    check('with no stepper arrows', arrows('Grid columns').length === 0, String(arrows('Grid columns').length));
    check('it can be typed in', count('Grid columns')?.disabled === false && !count('Grid columns')?.readOnly);
    check('and the gear is lit', gearLit());
    check('the other axis (unset) still counts', arrows('Grid rows').length === 2);
    await unmountCounts();

    // Editing writes exactly what was typed, on Enter.
    await mountCounts({ 'grid-template-columns': AUTOFIT });
    await typeInto(count('Grid columns'), 'repeat(auto-fill, minmax(10rem, 1fr))', ['Enter']);
    check(
      'Enter writes exactly the typed value',
      JSON.stringify(countWrites[0]) === '["grid-template-columns","repeat(auto-fill, minmax(10rem, 1fr))",false]',
      JSON.stringify(countWrites),
    );
    await unmountCounts();

    // !important typed in the field is the flag, not part of the value.
    await mountCounts({ 'grid-template-columns': AUTOFIT });
    await typeInto(count('Grid columns'), '100px 1fr !important', ['Enter']);
    check('a typed !important is the flag', JSON.stringify(countWrites[0]) === '["grid-template-columns","100px 1fr",true]', JSON.stringify(countWrites));
    await unmountCounts();

    // Invalid text writes nothing and shows the error.
    for (const [text, why] of [
      ['repeat(auto-fit, minmax(10rem, 1fr)', 'an unbalanced paren'],
      ['1fr ] 1fr', 'a stray bracket'],
      ['   ', 'nothing at all'],
      ['1fr; color: red', 'text that ends the declaration'],
    ]) {
      await mountCounts({ 'grid-template-columns': AUTOFIT });
      await typeInto(count('Grid columns'), text, ['Enter']);
      check(`${why} writes nothing`, countWrites.length === 0, JSON.stringify(countWrites));
      check(`and ${why} shows the error state`, count('Grid columns')?.getAttribute('aria-invalid') === 'true');
      check(`with the text kept to fix`, count('Grid columns')?.value === text, count('Grid columns')?.value);
      await unmountCounts();
    }

    // Escape puts the value back and writes nothing.
    await mountCounts({ 'grid-template-columns': AUTOFIT });
    await typeInto(count('Grid columns'), 'repeat(2, 1fr)', ['Escape']);
    check('Escape reverts the field', count('Grid columns')?.value === AUTOFIT, count('Grid columns')?.value);
    await act(async () => {
      count('Grid columns')?.blur();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    check('and leaving it afterwards writes nothing', countWrites.length === 0, JSON.stringify(countWrites));
    await unmountCounts();

    // A variable in the value is a chip, like every other style field.
    await mountCounts({ 'grid-template-columns': 'repeat(var(--_cols), minmax(0, 1fr))' });
    check(
      'a repeat counted by a variable shows its value',
      count('Grid columns')?.value === 'repeat(var(--_cols), minmax(0, 1fr))' || !!container.querySelector('.embed-editor_varconnect-editor'),
    );
    check('inside the variable-aware field', !!container.querySelector('.embed-editor_grid-count.is-expression .embed-editor_varconnect'));
    await unmountCounts();

    // Subgrid shows the word as the value.
    await mountCounts({ 'grid-template-columns': 'repeat(3, minmax(0, 1fr))', 'grid-template-rows': 'subgrid' });
    check('a subgrid row axis shows the word subgrid as its value', count('Grid rows')?.value === 'subgrid', count('Grid rows')?.value);
    check('with no stepper arrows', arrows('Grid rows').length === 0);
    check('the other axis still counts', count('Grid columns')?.value === '3', count('Grid columns')?.value);
    check('and steps', arrows('Grid columns').length === 2);
    await unmountCounts();

    // A value that comes from another selector shows the RESOLVED value for the active one.
    await mountCounts({ 'grid-template-columns': AUTOFIT }, 'other');
    check('a value from another selector is shown as it resolves', count('Grid columns')?.value === AUTOFIT, count('Grid columns')?.value);
    await unmountCounts();

    // "Switch to count" is not in the cell: nothing may sit over the text of a long value.
    const longCell = async () => {
      await mountCounts({ 'grid-template-columns': AUTOFIT });
    };
    await longCell();
    const cellOf = () => count('Grid columns')?.closest('.embed-editor_grid-count');
    check(
      'the cell holds the field and only the variable dot every style field has',
      [...(cellOf()?.querySelectorAll('button') ?? [])].every((button) => button.classList.contains('embed-editor_varconnect-dot')),
      cellOf()?.innerHTML,
    );
    check(
      'the field is not given the stepper padding',
      /\.embed-editor_grid-count:not\(\.is-expression\) \.u-input\s*\{\s*padding-right: 18px/.test(
        fs.readFileSync(repoPath('src/features/style/embedEditor.css'), 'utf8'),
      ),
    );
    check(
      'and a long value ends in an ellipsis',
      /\.embed-editor_grid-count\.is-expression \.u-input\s*\{\s*text-overflow: ellipsis/.test(
        fs.readFileSync(repoPath('src/features/style/embedEditor.css'), 'utf8'),
      ),
    );
    check('the full value is the tooltip', count('Grid columns')?.title === AUTOFIT, count('Grid columns')?.title);

    // Simple values keep the stepper exactly as it was.
    await mountCounts({ 'grid-template-columns': 'repeat(2, minmax(0, 1fr))' });
    check('equal tracks leave the gear off', !gearLit());
    check('they show their count', count('Grid columns')?.value === '2', count('Grid columns')?.value);
    await act(async () => {
      arrows('Grid columns')[0]?.click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    check(
      'and their count still steps',
      JSON.stringify(countWrites[0]) === '["grid-template-columns","repeat(3, minmax(0, 1fr))",false]',
      JSON.stringify(countWrites[0]),
    );
    await unmountCounts();
  }

  // --- which values the Columns and Rows count can say -----------------------
  // A count is faithful only for N equal tracks (1fr, minmax(0, 1fr) or auto — the sizes
  // the stepper writes). Everything else is an expression: shown as text, never as a
  // number, because stepping would write N plain tracks over it.
  {
    const { classifyTrackCount, checkTrackExpression } = require(bundlePath);
    const countOf = (value) => {
      const result = classifyTrackCount(value);
      return result.kind === 'count' ? result.count : result.kind;
    };
    const simple = [
      ['', 0, 'nothing'],
      ['none', 0, 'none'],
      ['repeat(3, 1fr)', 3, 'a numbered repeat of 1fr'],
      ['repeat(3, minmax(0, 1fr))', 3, 'a numbered repeat of minmax(0, 1fr)'],
      ['repeat(2, minmax(0px,1fr))', 2, 'minmax(0px,1fr) without spaces'],
      ['repeat(4, auto)', 4, 'the auto rows the stepper writes'],
      ['1fr 1fr', 2, 'equal tracks written out'],
      ['minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr)', 3, 'minmax(0, 1fr) written out'],
      ['1fr', 1, 'a single track'],
      ['REPEAT(2, 1FR)', 2, 'any case'],
    ];
    for (const [value, expected, what] of simple) {
      check(`${what} is a count`, countOf(value) === expected, `${JSON.stringify(value)} → ${countOf(value)}`);
    }
    const complex = [
      ['repeat(auto-fit, minmax(min(100%, 20rem), 1fr))', 'auto-fit with minmax(min(), 1fr)'],
      ['repeat(auto-fit, minmax(10rem,1fr))', 'auto-fit'],
      ['repeat(auto-fill, minmax(12rem, 1fr))', 'auto-fill'],
      ['repeat(var(--cols), 1fr)', 'a variable count'],
      ['var(--columns)', 'a variable for the whole list'],
      ['subgrid', 'subgrid'],
      ['subgrid [a] [b]', 'subgrid with line names'],
      ['masonry', 'masonry'],
      ['[a] 1fr [b] 2fr', 'named lines'],
      ['[full-start] minmax(1rem, 1fr) [content-start] 3fr', 'named lines with sizes'],
      ['100px 1fr', 'a fixed track and a flexible one'],
      ['1fr 2fr', 'unequal flexible tracks'],
      ['repeat(3, 200px)', 'a fixed length repeat'],
      ['repeat(3, minmax(100px, 1fr))', 'minmax with a fixed minimum'],
      ['repeat(3, minmax(0, 300px))', 'minmax with a fixed maximum'],
      ['repeat(3, calc(100% / 3))', 'calc()'],
      ['repeat(2, clamp(10rem, 20vw, 30rem))', 'clamp()'],
      ['repeat(2, min(100%, 20rem))', 'min()'],
      ['repeat(2, max(10rem, 20%))', 'max()'],
      ['fit-content(20rem) 1fr', 'fit-content()'],
      ['auto 1fr', 'auto mixed with fr'],
      ['min-content max-content', 'content keywords'],
      ['repeat(2, min-content)', 'a content keyword repeat'],
      ['repeat(2, 1fr 2fr)', 'a repeat of several tracks'],
      ['repeat(0, 1fr)', 'a repeat of zero'],
      ['repeat(501, 1fr)', 'a repeat beyond the limit'],
      ['repeat(3, 1fr) repeat(2, 1fr)', 'two repeats'],
      ['repeat(3, 1fr) !important', '!important'],
      ['inherit', 'a CSS-wide keyword'],
    ];
    for (const [value, what] of complex) {
      check(
        `${what} is an expression`,
        classifyTrackCount(value).kind === 'expression',
        `${JSON.stringify(value)} → ${JSON.stringify(classifyTrackCount(value))}`,
      );
    }
    check('subgrid says so', classifyTrackCount('subgrid').subgrid === true);
    check('whatever its case or line names', classifyTrackCount('SubGrid [a] [b]').subgrid === true);
    check('an auto-fit list is not a subgrid', classifyTrackCount('repeat(auto-fit, minmax(min(100%, 20rem), 1fr))').subgrid === false);

    // What may be written from the field.
    const ok = (text) => checkTrackExpression(text);
    check('a track list is accepted as typed', ok('repeat(auto-fit, minmax(10rem, 1fr))').value === 'repeat(auto-fit, minmax(10rem, 1fr))');
    check('with its !important taken off', ok('1fr 2fr !important').value === '1fr 2fr' && ok('1fr 2fr !important').important === true);
    check('named lines are accepted', ok('[a] 1fr [b]').kind === 'ok');
    check('a variable is accepted', ok('var(--layout-columns)').kind === 'ok');
    check('nothing is refused as empty', ok('').problem === 'empty' && ok('  !important').problem === 'empty');
    check('an open paren is malformed', ok('repeat(2, 1fr').problem === 'malformed');
    check('a stray close paren is malformed', ok('1fr)').problem === 'malformed');
    check('crossed brackets are malformed', ok('(1fr]').problem === 'malformed');
    check('a semicolon is malformed', ok('1fr; width: 1px').problem === 'malformed');
    check('so are braces', ok('1fr }').problem === 'malformed');
  }

  // --- a field that is already big doesn't open a box over itself -------------
  {
    const vc = fs.readFileSync(repoPath('src/features/style/VariableConnect.tsx'), 'utf8');
    check('a field can say it is already expanded', /expanded\?: boolean/.test(vc), 'nothing stops the big editor opening over a big field');
    // The guard has grown other reasons to bow out (the picker being open, for one);
    // what matters here is that `expanded` is one of them.
    check('the press that opens it respects that', /if \(disabled \|\| big \|\| expanded[^)]*\) \{\s*return/.test(vc));
    check("and so does the '=' shortcut", /event\.key === '=' && !disabled && !big && !expanded/.test(vc));
  }

  // --- the custom-value editor opens over the modal, not under it -------------
  // Every field in the grid settings can open it (a track's size, the whole
  // track list), and the settings are a modal — so an editor that sits on the
  // app's own scale opens behind the thing that opened it.
  {
    const css = fs.readFileSync(repoPath('src/app/styles.css'), 'utf8');
    const block = css.slice(css.indexOf('.var-custom {'), css.indexOf('.var-custom-head'));
    const z = Number((block.match(/z-index:\s*(\d+)/) || [])[1]);
    check('the custom value editor has a z-index', Number.isFinite(z), block.slice(0, 120));
    // The panel's modals are --z-modal (1000) and a few layers above it.
    check('above the style panel modals it opens from', z > 1003, `z-index: ${z}`);
    check('and below the tooltip layer', z < 10000, `z-index: ${z}`);
  }

  if (failures.length) {
    console.error(`\ngrid-tracks: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`grid-tracks: ${checked} passed`);
})();
