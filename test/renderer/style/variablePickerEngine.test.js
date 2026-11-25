// The picker's validity filter asks the real browser engine, at the slot a pick lands in.
//
//   node test/renderer/style/variablePickerEngine.test.js
//
// Goal: the filter's verdicts come from CSS.supports, and jsdom has no such call (the other picker
// tests stand one in). This holds the real answers: `width` refuses a unitless 1.5 on its own and
// accepts it inside calc(2rem * 1.5), and `color` refuses 10% on its own and accepts it inside
// color-mix(in srgb, red 10%, transparent 90%). The picker must make the same calls through its own
// code (pickerVariables with a slot), not only the engine through a bare CSS.supports.
// Method: the real picker module is bundled into a hidden Chromium window (Electron, the pattern of
// popoverDropdown.test.js) and called with a slot; the engine's own verdicts are read beside them.

const fs = require('fs');
const path = require('path');
const { ROOT, repoPath } = require('../../helpers/sources.js');

(async () => {
  const esbuild = require('esbuild');
  const directory = repoPath('node_modules/.stacki-test/picker-engine');
  fs.mkdirSync(directory, { recursive: true });
  await esbuild.build({
    stdin: {
      contents: `import { pickerVariables } from './src/features/style/VariablePicker';
        window.pickerVariables = pickerVariables;`,
      resolveDir: ROOT,
      loader: 'ts',
    },
    outfile: path.join(directory, 'bundle.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    jsx: 'automatic',
    loader: { '.css': 'empty', '.woff2': 'empty', '.svg': 'empty' },
    logLevel: 'silent',
  });
  fs.writeFileSync(path.join(directory, 'index.html'), '<!doctype html><meta charset="utf-8"><script src="bundle.js"></script>');

  const electronPath = (() => {
    try {
      return require('electron');
    } catch {
      return undefined;
    }
  })();
  if (typeof electronPath !== 'string') {
    console.log('variable-picker-engine: skipped, no Electron to ask the engine in');
    return;
  }
  const scriptPath = path.join(directory, 'probe.js');
  fs.writeFileSync(
    scriptPath,
    `const { app, BrowserWindow } = require('electron');
     app.on('window-all-closed', () => app.quit());
     app.whenReady().then(async () => {
       const win = new BrowserWindow({ show: false, width: 400, height: 300 });
       await win.loadFile(${JSON.stringify(path.join(directory, 'index.html'))});
       const out = await win.webContents.executeJavaScript(\`(() => {
         const variable = (name, value, type) => ({ name, value, collection: 'c', group: ':root', binding: 'var(--' + name + ')', type });
         const vars = [variable('ratio', '1.5', 'Number'), variable('ten', '10%', 'Percentage'), variable('red', '#f00', 'Color'), variable('wide', '20rem', 'Size')];
         const names = (list) => list.map((item) => item.name).sort();
         const ask = (prop, slot) => names(window.pickerVariables(vars, prop, '', slot === undefined ? {} : { slot }));
         return {
           engine: {
             widthBare: CSS.supports('width', '1.5'),
             widthCalc: CSS.supports('width', 'calc(2rem * 1.5)'),
             colorBare: CSS.supports('color', '10%'),
             colorMix: CSS.supports('color', 'color-mix(in srgb, red 10%, transparent 90%)'),
           },
           widthWhole: ask('width'),
           widthInCalc: ask('width', { before: 'calc(2rem * ', after: ')' }),
           colorWhole: ask('color'),
           colorInMix: ask('color', { before: 'color-mix(in srgb, red ', after: ', transparent 90%)' }),
         };
       })()\`);
       console.log(JSON.stringify(out));
       app.quit();
     });`,
  );
  const { spawnSync } = require('child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const run = spawnSync(electronPath, [scriptPath], { encoding: 'utf8', timeout: 60000, env });
  const line = (run.stdout || '').split('\n').find((text) => text.trim().startsWith('{'));
  if (!line) {
    console.error(`variable-picker-engine: the probe did not run\n${(run.stderr || run.stdout || '').slice(0, 500)}`);
    process.exit(1);
  }
  const result = JSON.parse(line);
  const failures = [];
  const check = (what, condition, detail) => {
    if (!condition) {
      failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
    }
  };
  check('the engine refuses a unitless 1.5 as a width', result.engine.widthBare === false);
  check('the engine accepts it inside calc(2rem * 1.5)', result.engine.widthCalc === true);
  check('the engine refuses 10% as a colour', result.engine.colorBare === false);
  check('the engine accepts it inside color-mix(in srgb, red 10%, transparent 90%)', result.engine.colorMix === true);
  check('width, whole value: the unitless number is not offered', !result.widthWhole.includes('ratio'), JSON.stringify(result.widthWhole));
  check('width, whole value: a length is', result.widthWhole.includes('wide'), JSON.stringify(result.widthWhole));
  check('width, inside calc(2rem * x): the number is offered', result.widthInCalc.includes('ratio'), JSON.stringify(result.widthInCalc));
  check('color, whole value: the percentage is not offered', !result.colorWhole.includes('ten'), JSON.stringify(result.colorWhole));
  check('color, whole value: a colour is', result.colorWhole.includes('red'), JSON.stringify(result.colorWhole));
  check('color, inside color-mix(): the percentage is offered', result.colorInMix.includes('ten'), JSON.stringify(result.colorInMix));
  if (failures.length > 0) {
    console.error(`variable-picker-engine: ${failures.length} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log('variable-picker-engine: real CSS.supports verdicts, direct and at a slot  [real engine]');
})();
