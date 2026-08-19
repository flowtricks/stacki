// Two ways of writing the same grid.
//
//   node test/grid-tracks.js
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
  const bundlePath = path.join(buildDir, 'grid-tracks.bundle.js');
  await esbuild.build({
    entryPoints: [path.join(__dirname, '..', 'src', 'style-panel', 'lib', 'grid-template.ts')],
    outfile: bundlePath,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    loader: { '.ts': 'ts' },
    logLevel: 'silent',
  });
  const { trackForm, asRepeat, asTrackList, parseTrackList } = require(bundlePath);

  // --- which form is this written in ------------------------------------------
  check('a repeat is a repeat', trackForm('repeat(2, minmax(0, 1fr))') === 'repeat');
  check('so is one with plain tracks', trackForm('repeat(3, 1fr)') === 'repeat');
  check(
    'tracks written out that match are a list',
    trackForm('minmax(0, 1fr) minmax(0, 1fr)') === 'list'
  );
  check('tracks that differ are neither', trackForm('200px 1fr auto') === 'mixed');
  check('and cannot be offered a repeat', asRepeat('200px 1fr auto') === '');
  check('one track is nothing to collapse', trackForm('1fr') === 'mixed', trackForm('1fr'));
  check('nothing is nothing', trackForm('') === 'none' && trackForm('none') === 'none');
  // auto-fit is a repeat whose count the browser decides — a different thing,
  // with its own control in the settings, so it is left alone.
  check(
    'an auto-fit repeat is left out of it',
    trackForm('repeat(auto-fit, minmax(20rem, 1fr))') === 'mixed',
    trackForm('repeat(auto-fit, minmax(20rem, 1fr))')
  );

  // --- saying it the other way ------------------------------------------------
  check(
    'a repeat writes out',
    asTrackList('repeat(2, minmax(0, 1fr))') === 'minmax(0, 1fr) minmax(0, 1fr)',
    asTrackList('repeat(2, minmax(0, 1fr))')
  );
  check(
    'and the list collapses back to exactly what it was',
    asRepeat('minmax(0, 1fr) minmax(0, 1fr)') === 'repeat(2, minmax(0, 1fr))',
    asRepeat('minmax(0, 1fr) minmax(0, 1fr)')
  );
  check('three of them too', asTrackList('repeat(3, 1fr)') === '1fr 1fr 1fr', asTrackList('repeat(3, 1fr)'));
  check('and back', asRepeat('1fr 1fr 1fr') === 'repeat(3, 1fr)', asRepeat('1fr 1fr 1fr'));

  // The round trip is the point: whichever way it is written, it is the same
  // grid, so the tracks it describes must not change.
  for (const value of ['repeat(2, minmax(0, 1fr))', 'repeat(4, 1fr)', '1fr 1fr', 'minmax(0, 1fr) minmax(0, 1fr)']) {
    const there = asTrackList(value);
    const back = asRepeat(there) || there;
    check(
      `${value} says the same tracks whichever way round`,
      parseTrackList(there).join('|') === parseTrackList(back).join('|') &&
        parseTrackList(value).join('|') === parseTrackList(there).join('|'),
      `${value} → ${there} → ${back}`
    );
  }

  // --- the button, in the settings it belongs to ------------------------------
  // Mounted rather than read: what matters is that the switch is there for a
  // grid written each way, and says which way the press goes.
  {
    const entry = path.join(buildDir, 'grid-settings.entry.jsx');
    fs.writeFileSync(
      entry,
      `export { default as GridSettings } from ${JSON.stringify(
        path.join(__dirname, '..', 'src', 'style-panel', 'GridSettings.tsx')
      )};\n`
    );
    const uiPath = path.join(buildDir, 'grid-settings.bundle.js');
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
    global.window = dom.window;
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
    const { GridSettings } = require(uiPath);

    // The panel writes to the stylesheet and reads it back; here that round trip
    // is this variable, so an edit is visible to the next one — without it the
    // modal would answer every question about a value it had already changed.
    const written = [];
    let columns = '';
    let important = false;
    const container = dom.window.document.getElementById('root');
    let root = createRoot(container);
    const paint = () =>
      act(async () => {
        root.render(
          React.createElement(GridSettings, {
            read: (prop) =>
              prop === 'grid-template-columns'
                ? {
                    source: 'selected',
                    selectedValue: { value: columns, important },
                    winner: { value: columns, important },
                    contributors: [],
                  }
                : undefined,
            busy: false,
            setProp: (prop, value, imp) => {
              written.push([prop, value, !!imp]);
              if (prop === 'grid-template-columns') { columns = value; important = !!imp }
            },
            clearProp: () => {},
            onProvenance: () => {},
            onSelectSelector: () => {},
            onClose: () => {},
          })
        );
        await new Promise((r) => setTimeout(r, 20));
      });
    // Each scenario opens the settings again: the switch remembers the form you
    // last chose while it is open, which is the point, so a scenario that began
    // inside the last one would be testing that memory rather than the default.
    const show = async (value, imp = false) => {
      await act(async () => { root.unmount(); await new Promise((r) => setTimeout(r, 5)); });
      root = createRoot(container);
      columns = value;
      important = imp;
      await paint();
    };
    const press = async (label) => {
      await act(async () => { button(label)?.click(); await new Promise((r) => setTimeout(r, 10)); });
      await paint();
    };
    // The modal portals to <body>, so its controls are not under the root — and
    // the switch is an <input>, not a button.
    const button = (label) =>
      [...dom.window.document.querySelectorAll('button, input, textarea')].find(
        (el) => (el.getAttribute('aria-label') || '') === label
      );

    await show('repeat(2, minmax(0, 1fr))');
    const sw = () => button('Use repeat() for columns');
    check('the switch is there', !!sw(), 'no repeat() switch in the grid settings');
    check('and it is on for a grid written as a repeat', sw()?.checked === true);
    check(
      'with the words on it',
      /repeat\(\)/.test(sw()?.closest('label')?.textContent || ''),
      sw()?.closest('label')?.textContent
    );

    await press('Use repeat() for columns');
    check(
      'switching it off writes the tracks out',
      JSON.stringify(written[0]) === '["grid-template-columns","minmax(0, 1fr) minmax(0, 1fr)",false]',
      JSON.stringify(written[0])
    );

    written.length = 0;
    await show('minmax(0, 1fr) minmax(0, 1fr)');
    check('and it is off for a grid written out', sw()?.checked === false);
    await press('Use repeat() for columns');
    check(
      'switching it on writes the repeat',
      JSON.stringify(written[0]) === '["grid-template-columns","repeat(2, minmax(0, 1fr))",false]',
      JSON.stringify(written[0])
    );

    // Adding a column to a repeat() keeps it one: the switch is how this list
    // is written, not a one-time conversion.
    written.length = 0;
    await show('repeat(2, minmax(0, 1fr))');
    check('the settings can add a column', !!button('Add a Columns'), 'no add button');
    await press('Add a Columns');
    // The new track is another of what is already there, not the generic
    // default — one that differed by a character would break the repeat().
    check(
      'adding a third writes repeat(3, …)',
      JSON.stringify(written[0]) === '["grid-template-columns","repeat(3, minmax(0, 1fr))",false]',
      JSON.stringify(written[0])
    );

    written.length = 0;
    await show('minmax(0, 1fr) minmax(0, 1fr)');
    await press('Add a Columns');
    check(
      'and with the switch off the same edit writes them out',
      JSON.stringify(written[0]) ===
        '["grid-template-columns","minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr)",false]',
      JSON.stringify(written[0])
    );

    // Nothing there yet: the switch starts on, so the first columns added are a
    // repeat() — the same form the count stepper writes.
    written.length = 0;
    await show('');
    check('a grid with no tracks starts with it on', sw()?.checked === true, 'a new grid would be written out');
    await press('Add a Columns');
    await press('Add a Columns');
    check(
      'so adding two writes a repeat',
      JSON.stringify(written[1]) === '["grid-template-columns","repeat(2, minmax(0px, 1fr))",false]',
      JSON.stringify(written)
    );

    await show('200px 1fr auto');
    check('tracks that differ cannot be a repeat', sw()?.disabled === true, 'the switch was offered anyway');
    check('and it shows off', sw()?.checked === false);

    // --- the whole value as an expression ------------------------------------
    // Some values are not a list of tracks at all. The braces hand over the
    // field so one can be typed, and take back the list when they are pressed
    // again.
    written.length = 0;
    await show('repeat(2, minmax(0, 1fr))');
    const braces = () => button('Edit columns as an expression');
    // The expression editor is a textarea — the token editor's own hidden input
    // carries the same label, so ask for the one being typed into.
    const field = () => dom.window.document.querySelector('textarea[aria-label="Columns expression"]');
    check('the braces are offered', !!braces(), 'no expression toggle');
    check('and the list is what shows first', !field(), 'the expression field was already open');

    await press('Edit columns as an expression');
    check('pressing them opens one field for the whole value', !!field(), 'no expression field');
    // The editor the panel opens over a cramped value, in the panel instead of
    // over it: multi-line, and not a trigger for a box on top of a box.
    check('as the multi-line editor, not a slot', field()?.tagName === 'TEXTAREA', field()?.tagName);
    check(
      'with the value editor around it, so variables are chips',
      !!field()?.closest('.embed-editor_varconnect.is-multiline'),
      field()?.parentElement?.className
    );
    check(
      'and it says it is already the room a long value needs',
      /expanded/.test(
        fs.readFileSync(path.join(__dirname, '..', 'src', 'style-panel', 'GridSettings.tsx'), 'utf8')
      ),
      'a long value would open the popup over this field'
    );
    check('holding what the property holds', field()?.value === 'repeat(2, minmax(0, 1fr))', field()?.value);
    check('the repeat switch is not offered while it is open', sw()?.disabled === true);
    check('nor is adding a track', !button('Add a Columns'), 'the + is still there');

    // Typed the way React hears it: through the value setter it patches, and
    // leaving the field is a focusout (blur does not bubble).
    // Nothing typed yet, so the tracks can still hold it: the braces let go.
    await press('Edit columns as an expression');
    check('pressing them again goes back to the tracks', !field(), 'still an expression field');

    // Typed the way React hears it: through the value setter it patches, and
    // leaving the field is a focusout (blur does not bubble).
    const type = async (text) => {
      await act(async () => {
        const el = field();
        // The field is a textarea now (the same editor the panel opens over a
        // cramped value, inline) — React patches the setter on its prototype.
        const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value').set;
        setValue.call(el, text);
        el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
        el.dispatchEvent(new dom.window.Event('focusout', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 10));
      });
      await paint();
    };

    written.length = 0;
    await press('Edit columns as an expression');
    await type('var(--layout-columns)');
    check(
      'typing an expression writes it as it was typed',
      JSON.stringify(written[0]) === '["grid-template-columns","var(--layout-columns)",false]',
      JSON.stringify(written[0])
    );
    // And now the tracks cannot hold it, so the way back is shut rather than
    // offering a list that would misread what was typed.
    check('a value the tracks cannot hold locks the braces', braces()?.disabled === true, 'the way back was still open');
    check('which stay pressed', braces()?.getAttribute('aria-pressed') === 'true');
    check('with the field still showing it', field()?.value === 'var(--layout-columns)', field()?.value);

    // !important is a value the track editors have no way to write, so it is
    // one of the things the field is for — and it comes back into the field.
    written.length = 0;
    await show('1fr 1fr');
    await press('Edit columns as an expression');
    await type('repeat(2, 1fr) !important');
    check(
      'an !important is written as one',
      JSON.stringify(written[0]) === '["grid-template-columns","repeat(2, 1fr)",true]',
      JSON.stringify(written[0])
    );
    check('the field shows it back', field()?.value === 'repeat(2, 1fr) !important', field()?.value);
    check('and the tracks stay out of it', braces()?.disabled === true, 'tracks offered to hold an !important');

    // A value that is tracks after all leaves the way back open.
    written.length = 0;
    await show('1fr 1fr');
    await press('Edit columns as an expression');
    await type('200px 1fr auto');
    check(
      'a track list typed by hand is still a track list',
      JSON.stringify(written[0]) === '["grid-template-columns","200px 1fr auto",false]',
      JSON.stringify(written[0])
    );
    check('so the braces let go again', braces()?.disabled === false, 'locked into the field for a value tracks can hold');

    // A value the list would misread opens as an expression by itself: a
    // variable standing in for every track reads as one track named after it.
    await show('var(--layout-columns)');
    check('a variable opens as an expression', !!field(), 'shown as a track called var(--layout-columns)');
    check('with the value in it', field()?.value === 'var(--layout-columns)', field()?.value);
  }

  // --- what the track controls can hold ---------------------------------------
  {
    const { canEditAsTracks } = require(bundlePath);
    check('a plain list is tracks', canEditAsTracks('200px 1fr auto'));
    check('so is a repeat', canEditAsTracks('repeat(3, 1fr)'));
    check('and an auto-fit one', canEditAsTracks('repeat(auto-fit, minmax(12rem, 1fr))'));
    check('a variable inside a track is fine', canEditAsTracks('minmax(0, var(--wide)) 1fr'));
    check('a variable in place of the list is not', !canEditAsTracks('var(--layout-columns)'));
    check('nor is an !important', !canEditAsTracks('repeat(2, 1fr) !important'));
    check('nor subgrid', !canEditAsTracks('subgrid'));
    check('nor a keyword the panel does not lay out', !canEditAsTracks('inherit'));
    check('none is nothing, which the tracks can hold', canEditAsTracks('none'));
    check('and so is nothing at all', canEditAsTracks(''));
  }

  // --- a field that is already big doesn't open a box over itself -------------
  {
    const vc = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'style-panel', 'VariableConnect.tsx'),
      'utf8'
    );
    check(
      'a field can say it is already expanded',
      /expanded\?: boolean/.test(vc),
      'nothing stops the big editor opening over a big field'
    );
    // The guard has grown other reasons to bow out (the picker being open, for one);
    // what matters here is that `expanded` is one of them.
    check('the press that opens it respects that', /if \(disabled \|\| big \|\| expanded[^)]*\) return/.test(vc));
    check("and so does the '=' shortcut", /e\.key === '=' && !disabled && !big && !expanded/.test(vc));
  }

  // --- the custom-value editor opens over the modal, not under it -------------
  // Every field in the grid settings can open it (a track's size, the whole
  // track list), and the settings are a modal — so an editor that sits on the
  // app's own scale opens behind the thing that opened it.
  {
    const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8');
    const block = css.slice(css.indexOf('.var-custom {'), css.indexOf('.var-custom-head'));
    const z = Number((block.match(/z-index:\s*(\d+)/) || [])[1]);
    check('the custom value editor has a z-index', Number.isFinite(z), block.slice(0, 120));
    // The panel's modals are --z-modal (1000) and a few layers above it.
    check('above the style panel modals it opens from', z > 1003, `z-index: ${z}`);
    check('and below the tooltip layer', z < 10000, `z-index: ${z}`);
  }


  // --- the settings offer it --------------------------------------------------
  const settings = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'style-panel', 'GridSettings.tsx'),
    'utf8'
  );
  check('the grid settings have the switch', /function RepeatSwitch/.test(settings));
  check('on both track lists, since each is written its own way', /<RepeatSwitch/.test(settings));
  check(
    'and every edit writes the form it is showing',
    /const write = \(next: string\[\]\) => \{ const s = asWritten\(next\)/.test(settings),
    'an edit would write in its own form regardless of the switch'
  );

  if (failures.length) {
    console.error(`\ngrid-tracks: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`grid-tracks: ${checked} passed`);
})();
