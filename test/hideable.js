// Turning a layer off without throwing it away.
//
//   node test/hideable.js
//
// A hidden layer is commented out in place — `filter: blur(5px) /* invert(1) */`
// — so the browser ignores it and every character of it is still in the
// stylesheet. Nothing is stored anywhere else, which is what lets a hidden
// layer survive a reload, a branch switch, and being opened in an editor that
// has never heard of this panel.
//
// The failure that matters is losing one. A layer that comes back changed, or
// does not come back at all, is work gone with no error and nothing on screen
// to say it happened — so every case here round-trips through the REAL parsers
// and serializers the panel uses, not stand-ins.

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
  const entry = path.join(buildDir, 'hideable.entry.ts');
  const lib = (f) => JSON.stringify(path.join(__dirname, '..', 'src', 'style-panel', 'lib', f));
  fs.writeFileSync(
    entry,
    `export * from ${lib('hideable.ts')};\n` +
      `export { parseFilters, serializeFilters } from ${lib('filter.ts')};\n` +
      `export { parseTransforms, serializeTransforms } from ${lib('transform.ts')};\n` +
      `export { parseTransitions, serializeTransitions } from ${lib('transition.ts')};\n` +
      `export { parseBoxShadows, serializeBoxShadows } from ${lib('box-shadow.ts')};\n` +
      `export { parseShadows, serializeShadows } from ${lib('text-shadow.ts')};\n`
  );
  const bundlePath = path.join(buildDir, 'hideable.bundle.js');
  await esbuild.build({
    entryPoints: [entry],
    outfile: bundlePath,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    logLevel: 'silent',
  });
  const {
    parseHideable,
    serializeHideable,
    allHidden,
    parseFilters,
    serializeFilters,
    parseTransforms,
    serializeTransforms,
    parseTransitions,
    serializeTransitions,
    parseBoxShadows,
    serializeBoxShadows,
    parseShadows,
    serializeShadows,
  } = require(bundlePath);

  // The three properties, each with its own separator.
  const KINDS = {
    filter: { sep: ' ', parse: parseFilters, serialize: serializeFilters },
    transform: { sep: ' ', parse: parseTransforms, serialize: serializeTransforms },
    transition: { sep: ',', parse: parseTransitions, serialize: serializeTransitions },
    'box-shadow': { sep: ',', parse: parseBoxShadows, serialize: serializeBoxShadows },
    'text-shadow': { sep: ',', parse: parseShadows, serialize: serializeShadows },
  };
  const rowsOf = (kind, value) => parseHideable(value, KINDS[kind].sep, KINDS[kind].parse);
  const textOf = (kind, rows) => serializeHideable(rows, KINDS[kind].sep, KINDS[kind].serialize);
  const setHidden = (rows, i, hidden) => rows.map((r, j) => (j === i ? { ...r, hidden } : r));

  // --- Hiding, and getting it back ------------------------------------------
  {
    // Already in the form the panel's own serializer writes — this is about
    // hiding, not about the normalising it has always done (`invert(1)` is
    // rewritten as `invert(100%)` whether anything is hidden or not).
    const start = 'blur(5px) invert(100%)';
    const rows = rowsOf('filter', start);
    check('both layers are read', rows.length === 2, JSON.stringify(rows));
    check('and neither starts hidden', rows.every((r) => !r.hidden), JSON.stringify(rows));

    const off = textOf('filter', setHidden(rows, 1, true));
    check('hiding one comments it out', off === 'blur(5px) /* invert(100%) */', JSON.stringify(off));
    // The whole point: the layer is still in the text, character for character.
    check('and its text is still there', off.includes('invert(100%)'), off);

    // Round trip: read it back, turn it on, and it must be what it was.
    const back = rowsOf('filter', off);
    check('reading it back finds both again', back.length === 2, JSON.stringify(back));
    check('with the second marked hidden', back[1].hidden === true, JSON.stringify(back));
    check('and the first not', back[0].hidden === false, JSON.stringify(back));
    const on = textOf('filter', setHidden(back, 1, false));
    check('turning it back on restores the value exactly', on === start, JSON.stringify(on));
  }

  // --- Hiding the only layer ------------------------------------------------
  {
    // `filter: /* blur(5px) */` is a declaration with no value — a syntax
    // error, so the browser drops the whole thing and the hidden layer is gone
    // for good. `none` keeps it valid and keeps the comment.
    const rows = rowsOf('filter', 'blur(5px)');
    const off = textOf('filter', setHidden(rows, 0, true));
    check('hiding the only layer still writes a value', off.trim() !== '', JSON.stringify(off));
    check('a valid one', off.startsWith('none'), JSON.stringify(off));
    check('with the layer kept in a comment', off.includes('blur(5px)'), JSON.stringify(off));

    const back = rowsOf('filter', off);
    // The `none` is a placeholder, not a layer — a row for it would be a row
    // nobody added.
    check('reading it back finds one layer, not two', back.length === 1, JSON.stringify(back));
    check('and it is the hidden one', back[0].hidden === true, JSON.stringify(back));
    check('restoring it drops the placeholder', textOf('filter', setHidden(back, 0, false)) === 'blur(5px)', textOf('filter', setHidden(back, 0, false)));
    check('allHidden agrees', allHidden(rows.map((r) => ({ ...r, hidden: true }))) === true);
    check('and says no when one is showing', allHidden(rows) === false);
  }

  // --- Separators inside a layer must not split it --------------------------
  {
    // A drop-shadow holds spaces AND an rgba() full of commas. Splitting on
    // either would tear one layer into several, and the pieces would come back
    // as garbage layers.
    const value = 'drop-shadow(0 0 2px rgba(0, 0, 0, 0.5)) blur(2px)';
    const rows = rowsOf('filter', value);
    check('a filter with spaces and commas inside stays one layer', rows.length === 2, JSON.stringify(rows.map((r) => r.item)));
    const off = textOf('filter', setHidden(rows, 0, true));
    check('and survives being hidden', off.includes('rgba(0, 0, 0, 0.5)'), off);
    check('with the comment around the whole thing', /^\/\* drop-shadow\(.*\) \*\//.test(off), off);
    const back = rowsOf('filter', off);
    check('and reads back as one hidden layer plus one showing', back.length === 2 && back[0].hidden && !back[1].hidden, JSON.stringify(back));
  }

  // --- A layer that is several CSS functions --------------------------------
  //
  // Found by this file. One layer does not always serialize to one function: a
  // rotate is `rotateX(…) rotateY(…) rotateZ(…)`, three functions the transform
  // parser groups back into one layer. Splitting the value on separators and
  // parsing each piece alone turned that one rotate into three, so a two-layer
  // value came back with four layers in it — and every one of them would have
  // been written back to the stylesheet.
  {
    const rows = rowsOf('transform', 'translate3d(10px, 20px, 0px) rotateX(0deg) rotateY(0deg) rotateZ(45deg)');
    check('a rotate stays one layer', rows.length === 2, JSON.stringify(rows.map((r) => r.item.type)));
    check('a move and a rotate', rows.map((r) => r.item.type).join(',') === 'move,rotate', JSON.stringify(rows.map((r) => r.item.type)));

    // Hidden, the rotate's three functions live inside one comment — and have
    // to come back out as one layer, not three.
    const off = textOf('transform', setHidden(rows, 1, true));
    check('hiding it wraps all three functions in one comment', (off.match(/\/\*/g) || []).length === 1, off);
    const back = rowsOf('transform', off);
    check('and it reads back as one hidden layer', back.length === 2, JSON.stringify(back.map((r) => r.item.type)));
    check('still a rotate', back[1].item.type === 'rotate' && back[1].hidden === true, JSON.stringify(back[1]));
    check('with its angle intact', back[1].item.z === '45deg', JSON.stringify(back[1].item));
    // And turning it back on gives exactly what we started from.
    check(
      'showing it again restores the value',
      textOf('transform', setHidden(back, 1, false)) === 'translate3d(10px, 20px, 0px) rotateX(0deg) rotateY(0deg) rotateZ(45deg)',
      textOf('transform', setHidden(back, 1, false))
    );
  }

  // --- Transform: space-separated -------------------------------------------
  {
    const rows = rowsOf('transform', 'translate(10px, 20px) rotate(45deg)');
    check('two transforms are read', rows.length === 2, JSON.stringify(rows.map((r) => r.item)));
    const off = textOf('transform', setHidden(rows, 0, true));
    check('hiding the first comments only that one', /^\/\*/.test(off) && off.includes('rotate'), off);
    const back = rowsOf('transform', off);
    check('and it round-trips', back.length === 2 && back[0].hidden && !back[1].hidden, JSON.stringify(back));
  }

  // --- Transition: comma-separated ------------------------------------------
  {
    const rows = rowsOf('transition', 'opacity 200ms ease, transform 300ms linear');
    check('two transitions are read', rows.length === 2, JSON.stringify(rows.map((r) => r.item)));
    const off = textOf('transition', setHidden(rows, 1, true));
    // Comma-joined, so the comment sits after a comma rather than a space.
    check('the hidden one is commented', off.includes('/*') && off.includes('transform'), off);
    check('and the list is still comma-separated', off.includes(', '), off);
    const back = rowsOf('transition', off);
    check('and it round-trips', back.length === 2 && !back[0].hidden && back[1].hidden, JSON.stringify(back));
  }

  // --- Nothing, and nonsense -------------------------------------------------
  {
    check('an empty value has no layers', rowsOf('filter', '').length === 0);
    check('and serializes back to empty', textOf('filter', []) === '');
    // A value this property's parser cannot read is left out of the model
    // rather than turned into a broken layer.
    check('an unreadable layer is skipped', rowsOf('filter', 'blur(5px) wat(1)').length === 1, JSON.stringify(rowsOf('filter', 'blur(5px) wat(1)')));
    // An unterminated comment must not swallow the rest silently as a layer.
    check('an unterminated comment does not crash', Array.isArray(rowsOf('filter', 'blur(5px) /* invert(1)')));
  }

  // --- Does the browser still accept it -------------------------------------
  //
  // The check none of the above is. Everything so far round-trips through this
  // app's own parsers, and a value can do that perfectly while the BROWSER
  // throws it out.
  //
  // Which is what happened. A comment is removed before the value is parsed, so
  // commenting an entry out of a comma-separated list leaves its comma behind:
  //
  //     transition: opacity 200ms ease, /* transform 300ms linear */;
  //
  // reaches the parser as `opacity 200ms ease,`. A trailing comma is a syntax
  // error, and a declaration with a syntax error is dropped ENTIRELY — so
  // hiding one transition turned off the one still showing, with the panel
  // still drawing it as on. Every test above passed while that was true.
  //
  // So the real question is asked of a real browser: hide each subset of three
  // layers and count how many the browser actually applies.
  const electronPath = (() => {
    try {
      return require('electron');
    } catch {
      return null;
    }
  })();
  const HIDE_SETS = [[], [0], [1], [2], [0, 1], [1, 2], [0, 2], [0, 1, 2]];
  const STARTS = {
    transition: 'opacity 200ms ease, transform 300ms linear, color 1s',
    'box-shadow': '0 1px 2px red, 0 2px 4px blue, 0 3px 6px green',
    'text-shadow': '0 1px 2px red, 0 2px 4px blue, 0 3px 6px green',
    filter: 'blur(5px) invert(100%) grayscale(50%)',
    transform: 'translate3d(10px, 20px, 0px) rotateX(0deg) rotateY(0deg) rotateZ(45deg) scale3d(2, 2, 1)',
  };
  const cases = [];
  for (const [prop, start] of Object.entries(STARTS)) {
    const rows = rowsOf(prop, start);
    check(`${prop}: three layers to work with`, rows.length === 3, JSON.stringify(rows.map((r) => r.item)));
    for (const hide of HIDE_SETS) {
      cases.push({
        prop,
        hide: hide.join('+') || 'none',
        shown: rows.length - hide.length,
        value: textOf(prop, rows.map((r, i) => ({ ...r, hidden: hide.includes(i) }))),
      });
    }
  }

  if (typeof electronPath !== 'string') {
    console.log(`hideable: ${checked} passed  [the browser check needs a Chromium — see test/computed-color.js]`);
    if (failures.length) {
      console.error(`hideable: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
      process.exit(1);
    }
    return;
  }

  const { spawnSync } = require('child_process');
  const probePath = path.join(buildDir, 'hideable.probe.js');
  fs.writeFileSync(
    probePath,
    `const { app, BrowserWindow } = require('electron');
     const CASES = ${JSON.stringify(cases)};
     app.disableHardwareAcceleration();
     app.on('window-all-closed', () => app.quit());
     app.whenReady().then(async () => {
       const win = new BrowserWindow({ show: false, width: 400, height: 300 });
       await win.loadURL('data:text/html,<div id=x></div>');
       const out = await win.webContents.executeJavaScript(
         '(' + ((cases) => {
           const el = document.getElementById('x');
           return cases.map((c) => {
             // Through a real stylesheet, which is how the app writes it.
             const st = document.createElement('style');
             st.textContent = '#x { ' + c.prop + ': ' + c.value + '; }';
             document.head.appendChild(st);
             // An empty \`kept\` means the browser threw the declaration away.
             const kept = st.sheet.cssRules[0].style.getPropertyValue(c.prop);
             const computed = getComputedStyle(el).getPropertyValue(c.prop);
             st.remove();
             return { prop: c.prop, hide: c.hide, shown: c.shown, kept, computed };
           });
         }).toString() + ')(' + JSON.stringify(CASES) + ')'
       );
       console.log(JSON.stringify(out));
       app.quit();
     });`
  );
  const run = spawnSync(electronPath, [probePath], { encoding: 'utf8', timeout: 120000 });
  const line = (run.stdout || '').split('\n').find((l) => l.trim().startsWith('['));
  if (!line) {
    check('the browser probe ran', false, (run.stderr || run.stdout || '').slice(0, 400));
  } else {
    for (const r of JSON.parse(line)) {
      const where = `${r.prop} with ${r.hide === 'none' ? 'nothing' : r.hide} hidden`;
      // The declaration surviving at all is the half that was broken.
      check(`${where}: the browser keeps the declaration`, r.shown === 0 || r.kept !== '', `dropped — "${r.computed}"`);
      // And it applies exactly the layers still showing, no more and no fewer.
      const applied =
        r.kept === '' || r.computed === 'none' || r.computed === 'all' || r.computed === 'matrix(1, 0, 0, 1, 0, 0)'
          ? 0
          : r.prop === 'filter' || r.prop === 'transform'
            ? r.computed.split(/\s+(?![^(]*\))/).filter(Boolean).length
            : r.computed.split(/,(?![^(]*\))/).length;
      const want = r.prop === 'transform' ? Math.min(r.shown, 1) : r.shown;
      check(
        `${where}: it applies the ${r.shown} still showing`,
        r.prop === 'transform' ? (r.shown === 0 ? applied === 0 : applied >= 1) : applied === want,
        `applied ${applied}, computed "${r.computed}"`
      );
    }
  }

  if (failures.length) {
    console.error(`hideable: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`hideable: ${checked} passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
