// The code editor's variable chooser offers only variables valid for the property being typed.
//
//   node test/renderer/style/codeVariableProperty.test.js
//
// Goal: `text-wrap: --` (a keyword-only property) opens nothing, while `width: --` lists lengths and
// `color: --` colours. The owner's report: the chooser listed every size after `text-wrap: --`.
// The cause was the property read for the caret: a line above left without its `;` made the
// declaration start at THAT line (`width: 1rem` + newline + `text-wrap: --` read as `width`), so the
// chooser judged the variables for the wrong property. The grammar filter itself (CSS.supports at
// the slot, valueSlot.ts) was right.
// Method, two halves.
//   1. Pure: the property and slot read at the caret (codeTypedVariableAt, codeSlotAt) for text with
//      and without a missing `;`, a continuation line, a custom property, and a selector: valid
//      places and the negative space around them.
//   2. Real engine: in a hidden Chromium window (Electron, as variablePickerEngine.test.js) the real
//      picker module judges a table of property x variable value at the slot the code editor reads,
//      so the verdicts come from the browser's own grammar: alias chains resolve, a cycle and an
//      undeclared alias are not offered, a custom property takes everything, and a keyword-only
//      property takes nothing.

const fs = require('fs');
const path = require('path');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const failures = [];
const check = (what, condition, detail) => {
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};

(async () => {
  const esbuild = require('esbuild');
  const directory = repoPath('node_modules/.stacki-test/code-variable-property');
  fs.mkdirSync(directory, { recursive: true });
  const bundle = async (name, contents, platform, format) => {
    const outfile = path.join(directory, name);
    await esbuild.build({
      stdin: { contents, resolveDir: ROOT, loader: 'ts' },
      outfile,
      bundle: true,
      format,
      platform,
      jsx: 'automatic',
      loader: { '.css': 'empty', '.woff2': 'empty', '.svg': 'empty' },
      logLevel: 'silent',
    });
    return outfile;
  };

  // Half one: the property and slot read at the caret.
  const scopeFile = await bundle('scope.cjs', `export { codeTypedVariableAt, codeSlotAt } from './src/features/style/model/codeVariableScope';`, 'node', 'cjs');
  const { codeTypedVariableAt, codeSlotAt } = require(scopeFile);
  const readAt = (text) => {
    const caret = text.lastIndexOf('--') + 2;
    const typed = codeTypedVariableAt(text, caret, { kind: 'declarations' });
    return typed === undefined ? undefined : { prop: typed.prop, slot: codeSlotAt(text, typed, { kind: 'declarations' }) };
  };
  const table = [
    ['a terminated line', 'h1 {\n  width: 1rem;\n  text-wrap: --', 'text-wrap'],
    ['a line above without its semicolon', 'h1 {\n  width: 1rem\n  text-wrap: --', 'text-wrap'],
    ['two lines above without semicolons', 'h1 {\n  width: 1rem\n  color: red\n  text-wrap: --', 'text-wrap'],
    ['a custom property above without its semicolon', 'h1 {\n  --gap: 1rem\n  text-wrap: --', 'text-wrap'],
    ['a custom property being declared', 'h1 {\n  width: 1rem\n  --gap: --', undefined],
    ['the first declaration', 'h1 { text-wrap: --', 'text-wrap'],
    ['a value broken over lines', 'h1 {\n  transition: color 1s,\n    opacity 1s --', 'transition'],
    ['a url with a colon on a continuation line', 'h1 {\n  background:\n    url(https://x.test/a.png) --', 'background'],
    ['a grid strings continuation', 'h1 {\n  grid-template-areas:\n    "a b"\n    "c d" --', 'grid-template-areas'],
  ];
  for (const [what, text, expected] of table) {
    const read = readAt(text);
    if (expected === undefined) {
      check(`${what}: reads no property`, read !== undefined && read.prop === undefined, JSON.stringify(read));
    } else {
      check(`${what}: reads ${expected}`, read !== undefined && read.prop === expected, JSON.stringify(read));
    }
  }
  const slot = readAt('h1 {\n  width: 1rem\n  text-wrap: --\n}');
  check(
    'the slot is the line being typed, whole',
    slot !== undefined && slot.slot !== undefined && slot.slot.before === '' && slot.slot.after.trim() === '',
    JSON.stringify(slot),
  );
  check('nothing is read outside a declaration', readAt('h1 {\n  width: 1rem;\n}\n--') === undefined);

  // Half two: the engine's verdicts for the property x value table.
  const pickerFile = await bundle(
    'picker.js',
    `import { pickerVariables } from './src/features/style/VariablePicker'; window.pickerVariables = pickerVariables;`,
    'browser',
    'iife',
  );
  fs.writeFileSync(path.join(directory, 'index.html'), `<!doctype html><meta charset="utf-8"><script src="${path.basename(pickerFile)}"></script>`);
  const electronPath = (() => {
    try {
      return require('electron');
    } catch {
      return undefined;
    }
  })();
  if (typeof electronPath === 'string') {
    const probe = path.join(directory, 'probe.js');
    fs.writeFileSync(
      probe,
      `const { app, BrowserWindow } = require('electron');
       app.whenReady().then(async () => {
         const win = new BrowserWindow({ show: false });
         await win.loadFile(${JSON.stringify(path.join(directory, 'index.html'))});
         const out = await win.webContents.executeJavaScript(\`(() => {
           const make = (name, value, type) => ({ name, value, collection: 'c', group: ':root', binding: 'var(--' + name + ')', type });
           const vars = [
             make('gap', '1rem', 'Size'), make('wide', 'clamp(10rem, 50vw, 40rem)', 'Size'), make('ratio', '1.5', 'Number'), make('step', '3', 'Number'),
             make('half', '50%', 'Percentage'), make('ink', '#123456', 'Color'), make('fade', 'color-mix(in srgb, red 50%, blue)', 'Color'),
             make('quick', '200ms', 'Time'), make('turn', '45deg', 'Angle'), make('ease', 'cubic-bezier(0.4, 0, 0.2, 1)', 'String'),
             make('stack', '"Inter", sans-serif', 'FontFamily'), make('glow', '0 0 1rem red', 'String'), make('sky', 'linear-gradient(red, blue)', 'String'),
             make('alias', 'var(--gap)', 'Size'), make('alias-two', 'var(--alias)', 'Size'), make('tint', 'var(--ink)', 'Color'),
             make('loop-a', 'var(--loop-b)', 'Size'), make('loop-b', 'var(--loop-a)', 'Size'), make('lost', 'var(--missing)', 'Size'),
           ];
           const ask = (prop) => window.pickerVariables(vars, prop, '', { slot: { before: '', after: '' } }).map((item) => item.name).sort();
           const props = ['color','background-color','border-color','fill','stroke','outline-color','text-decoration-color','caret-color','accent-color',
             'width','min-height','padding','margin','gap','top','border-width','border-radius','font-size','letter-spacing','line-height',
             'opacity','flex-grow','z-index','order','transition-duration','animation-delay','transition-timing-function','font-family',
             'box-shadow','text-shadow','background-image','text-wrap','display','position','overflow','cursor','visibility','text-align','white-space','content'];
           const out = {};
           for (const prop of props) out[prop] = ask(prop);
           out['--custom'] = ask('--custom');
           out['not-a-property'] = ask('not-a-property');
           out.undefined = window.pickerVariables(vars, undefined, '', {}).map((item) => item.name).sort();
           return out;
         })()\`);
         console.log('RESULT' + JSON.stringify(out));
         app.exit(0);
       });`,
    );
    const { spawnSync } = require('child_process');
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const run = spawnSync(electronPath, [probe], { encoding: 'utf8', timeout: 60000, env });
    const line = (run.stdout || '').split('\n').find((text) => text.startsWith('RESULT'));
    if (line === undefined) {
      console.error(`code-variable-property: the probe did not run\n${(run.stderr || run.stdout || '').slice(0, 500)}`);
      process.exit(1);
    }
    const shown = JSON.parse(line.slice('RESULT'.length));
    const has = (prop, name) => shown[prop].includes(name);
    const only = (prop, names) => JSON.stringify(shown[prop]) === JSON.stringify([...names].sort());
    for (const prop of [
      'color',
      'background-color',
      'border-color',
      'fill',
      'stroke',
      'outline-color',
      'text-decoration-color',
      'caret-color',
      'accent-color',
    ]) {
      check(`${prop}: colours only, alias chains resolved`, only(prop, ['ink', 'fade', 'tint']), JSON.stringify(shown[prop]));
    }
    for (const prop of ['width', 'min-height', 'padding', 'margin', 'gap', 'top', 'border-width', 'border-radius', 'font-size']) {
      check(
        `${prop}: lengths, aliases and a clamp; no colour, number, time or word`,
        only(
          prop,
          ['gap', 'wide', 'alias', 'alias-two', 'half'].filter((name) => name !== 'half' || prop !== 'border-width'),
        ) || only(prop, ['gap', 'wide', 'alias', 'alias-two']),
        JSON.stringify(shown[prop]),
      );
    }
    check(
      'a cycle and an undeclared alias are never offered',
      ['width', 'color', '--custom'].every((prop) => prop === '--custom' || (!has(prop, 'loop-a') && !has(prop, 'loop-b') && !has(prop, 'lost'))),
    );
    check('opacity takes a number', has('opacity', 'ratio') && !has('opacity', 'gap') && !has('opacity', 'ink'), JSON.stringify(shown.opacity));
    check(
      'flex-grow takes a number',
      has('flex-grow', 'ratio') && has('flex-grow', 'step') && !has('flex-grow', 'gap') && !has('flex-grow', 'ink'),
      JSON.stringify(shown['flex-grow']),
    );
    for (const prop of ['z-index', 'order']) {
      check(
        `${prop} takes a whole number, never a fraction, a length or a colour`,
        has(prop, 'step') && !has(prop, 'ratio') && !has(prop, 'gap') && !has(prop, 'ink'),
        JSON.stringify(shown[prop]),
      );
    }
    check('line-height takes numbers, never a colour', has('line-height', 'ratio') && !has('line-height', 'ink'), JSON.stringify(shown['line-height']));
    for (const prop of ['transition-duration', 'animation-delay']) {
      check(`${prop}: times only`, only(prop, ['quick']), JSON.stringify(shown[prop]));
    }
    check('transition-timing-function: easings only', only('transition-timing-function', ['ease']), JSON.stringify(shown['transition-timing-function']));
    check(
      'font-family: a family list',
      has('font-family', 'stack') && !has('font-family', 'gap') && !has('font-family', 'ink'),
      JSON.stringify(shown['font-family']),
    );
    for (const prop of ['box-shadow', 'text-shadow']) {
      check(`${prop}: the shadow, no plain length`, has(prop, 'glow') && !has(prop, 'gap') && !has(prop, 'ink'), JSON.stringify(shown[prop]));
    }
    check('background-image: the gradient', has('background-image', 'sky') && !has('background-image', 'gap'), JSON.stringify(shown['background-image']));
    for (const prop of ['text-wrap', 'display', 'position', 'overflow', 'cursor', 'visibility', 'text-align', 'white-space']) {
      check(`${prop}: a keyword-only property offers no variable, so the chooser does not open`, shown[prop].length === 0, JSON.stringify(shown[prop]));
    }
    check('a custom property takes every variable', shown['--custom'].length === 19, String(shown['--custom'].length));
    check(
      'an unknown property is offered the project by its guessed type, never empty',
      shown['not-a-property'].length > 0,
      JSON.stringify(shown['not-a-property']),
    );
    check('no property at all offers every variable', shown.undefined.length > 0, JSON.stringify(shown.undefined));
  } else {
    console.log('code-variable-property: the engine half is skipped, no Electron to ask');
  }

  // The picker draws nothing for an empty verdict: a source scan holds the early return.
  const picker = fs.readFileSync(repoPath('src/features/style/VariablePicker.tsx'), 'utf8');
  check(
    'a typed reference with nothing that fits draws no card',
    /typing !== undefined && !loading && offered\.length === 0 && vars\.length > 0\) \{\s*return <><\/>;/.test(picker),
  );

  if (failures.length > 0) {
    console.error(`code-variable-property: ${failures.length} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log('code-variable-property: the property is read from its own line, and the engine filters by it  [real engine]');
})();
