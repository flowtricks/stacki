// Resolving a colour against the element it applies to.
//
//   node test/renderer/style/computedColor.test.js
//
// A swatch in the panel paints the value it is given, in the panel's own
// document — where `var(--background)` is not defined, so it came out
// transparent. The value is not constant either: the same variable is one
// colour under `.theme-dark` and another under `.theme-light`, and a
// `color-mix()` of it changes with both. So the page resolves it, against the
// element that is selected, and that is what these check: the decision of what
// needs asking (needsPage), and the resolving itself, in a real DOM.

const fs = require('fs');
const path = require('path');
const { ROOT, repoPath } = require('../../helpers/sources.js');

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
  const bundlePath = path.join(buildDirectory, 'computed-color.bundle.js');
  await esbuild.build({
    stdin: {
      contents: `export { needsPage } from './src/features/style/model/computedColor'`,
      resolveDir: ROOT,
      loader: 'ts',
    },
    outfile: bundlePath,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    external: ['react'],
    logLevel: 'silent',
  });
  const { needsPage } = require(bundlePath);

  // --- which values the page has to answer for ------------------------------
  for (const value of [
    'var(--background)',
    'color-mix(in srgb, var(--brand-500) 20%, transparent)',
    'light-dark(#fff, #000)',
    'currentcolor',
    '--brand-500',
    'VAR(--Background)', // case is not a value's business
  ]) {
    check(`asks the page about "${value}"`, needsPage(value), value);
  }
  for (const value of ['#c6fb50', 'rgb(1 2 3)', 'transparent', 'hsl(120 50% 50%)', '', '   ']) {
    check(`answers "${value}" itself`, !needsPage(value), value);
  }

  // --- the resolving, against a page that themes its variables --------------
  //
  // The real preload's root fallback is exercised by previewTokenFrame.test.js.
  // Here, check that the app asks even without a selection, as the variables
  // panel needs to resolve colors independently of any selected element.
  {
    const lib = fs.readFileSync(repoPath('src/features/style/model/computedColor.ts'), 'utf8');
    check(
      'and the app asks even with nothing selected',
      /function pathOfSelection\(\): string \{/.test(lib) && !/if \(!path\) \{[\s\S]{0,80}setResolved\(null\)/.test(lib),
      'the ask is abandoned when nothing is selected',
    );
  }

  // The probe the preload uses: a throwaway span inside the element, which
  // inherits its custom properties, given the value as a colour. jsdom does not
  // compute colours, so this runs in the browser jsdom cannot be — it is the
  // one part that has to be exercised somewhere real. Skipped when there is no
  // Chromium to hand, rather than failing the suite on a machine without one.
  const electronPath = (() => {
    try {
      return require('electron');
    } catch {
      return undefined;
    }
  })();
  if (typeof electronPath !== 'string') {
    console.log(
      `computed-color: ${checked} passed  ` + '[needsPage; the probe needs a browser — see ' + 'test/electron/project/thumbs.test.js for the pattern]',
    );
    return;
  }

  const { spawnSync } = require('child_process');
  const scriptPath = path.join(buildDirectory, 'computed-color.probe.js');
  const probeBundle = await esbuild.build({
    entryPoints: [repoPath('electron/preload/frameColorProbe.ts')],
    bundle: true,
    write: false,
    format: 'iife',
    globalName: 'colorProbe',
    logLevel: 'silent',
  });
  fs.writeFileSync(
    scriptPath,
    `const { app, BrowserWindow } = require('electron');
     const probeSource = ${JSON.stringify(probeBundle.outputFiles[0].text)};
     app.on('window-all-closed', () => app.quit());
     app.whenReady().then(async () => {
       const win = new BrowserWindow({ show: false, width: 400, height: 300 });
       await win.loadURL('data:text/html,' + encodeURIComponent(\`
         <style>
           :root { --background: #ffffff; --brand: #c6fb50 }
           .theme-dark { --background: #1f1d1e }
           #a { color: rgb(10, 20, 30) }
         </style>
         <div id="light"><span id="a">light</span></div>
         <div id="dark" class="theme-dark"><span>dark</span></div>
         <label><textarea id="area" style="--own: rgb(4, 5, 6); color: rgb(7, 8, 9)"></textarea></label>
       \`));
       await win.webContents.executeJavaScript(probeSource + ';0');
       // The same probe the preload runs, on two elements that theme the same
       // variable differently.
       const compute = (selector, value) => \`(() => {
         const el = document.querySelector('\${selector}');
         const probe = document.createElement('span');
         probe.setAttribute('style', 'position:absolute;width:0;height:0;visibility:hidden');
         el.appendChild(probe);
         probe.style.color = 'rgb(1, 2, 3)';
         probe.style.color = \\\`\${value}\\\`;
         const out = probe.style.color === 'rgb(1, 2, 3)' ? null : getComputedStyle(probe).color;
         probe.remove();
         return out;
       })()\`;
       const out = {
         light: await win.webContents.executeJavaScript(compute('#light', 'var(--background)')),
         dark: await win.webContents.executeJavaScript(compute('#dark', 'var(--background)')),
         mixed: await win.webContents.executeJavaScript(
           compute('#dark', 'color-mix(in srgb, var(--brand) 50%, black)'),
         ),
         inherited: await win.webContents.executeJavaScript(compute('#a', 'currentcolor')),
         // Nothing selected: the page answers about itself, which is where
         // :root's custom properties are declared. This is the variables
         // panel's question — a value is the same colour wherever it is
         // written — and without it every swatch there stayed a chequerboard.
         atRoot: await win.webContents.executeJavaScript(
           compute(':root', 'color-mix(in srgb, var(--brand), white 80%)'),
         ),
         nonsense: await win.webContents.executeJavaScript(compute('#light', 'not-a-color')),
         // A child of a <textarea> is never rendered, so this is the page's own
         // reason for the fallback the real probe takes below.
         childOfArea: await win.webContents.executeJavaScript(compute('#area', 'var(--brand)')),
         area: await win.webContents.executeJavaScript(
           "colorProbe.computeValues(document.querySelector('#area'), ['var(--brand)', 'var(--own)', 'currentcolor', 'not-a-color'])",
         ),
         areaClean: await win.webContents.executeJavaScript(
           "document.querySelectorAll('[data-avb-probe]').length + document.querySelector('#area').childElementCount + document.querySelector('label').childElementCount",
         ),
         plain: await win.webContents.executeJavaScript(
           "colorProbe.computeValues(document.querySelector('#dark'), ['var(--background)'])",
         ),
         leftClean: await win.webContents.executeJavaScript(
           "document.querySelectorAll('span').length",
         ),
       };
       console.log(JSON.stringify(out));
       app.quit();
     });`,
  );
  const run = spawnSync(electronPath, [scriptPath], { encoding: 'utf8', timeout: 60000 });
  const line = (run.stdout || '').split('\n').find((line) => line.trim().startsWith('{'));
  if (!line) {
    check('the probe ran in a browser', false, (run.stderr || run.stdout || '').slice(0, 300));
  } else {
    const out = JSON.parse(line);
    check('a variable resolves to what the element sees', out.light === 'rgb(255, 255, 255)', out.light);
    check('and to something else under a theme', out.dark === 'rgb(31, 29, 30)', out.dark);
    // A mix comes back in whatever space it was mixed in — `color(srgb …)`
    // rather than `rgb(…)`. Either paints; what matters is that it resolved.
    check('a colour-mix of a variable resolves too', /^(?:rgb|rgba|color)\(/.test(out.mixed || ''), out.mixed);
    check('currentcolor resolves to the inherited colour', out.inherited === 'rgb(10, 20, 30)', out.inherited);
    check('a mix resolves against the page root, with nothing selected', /^(?:rgb|rgba|color)\(/.test(out.atRoot || ''), out.atRoot);
    check('a value that is not a colour reports nothing', out.nonsense === null, JSON.stringify(out.nonsense));
    check('the probe leaves no trace in the page', out.leftClean === 2, `${out.leftClean} spans`);
    check('a child of a textarea computes nothing', out.childOfArea === '', JSON.stringify(out.childOfArea));
    check('a textarea resolves a page variable', out.area['var(--brand)'] === 'rgb(198, 251, 80)', JSON.stringify(out.area));
    check('and a variable it declares itself', out.area['var(--own)'] === 'rgb(4, 5, 6)', JSON.stringify(out.area));
    check('and its own currentcolor', out.area.currentcolor === 'rgb(7, 8, 9)', JSON.stringify(out.area));
    check('and reports nothing for a non-colour', out.area['not-a-color'] === undefined, JSON.stringify(out.area));
    check('the stand-in leaves no trace', out.areaClean === 1, `${out.areaClean} nodes`);
    check('an ordinary element still probes inside itself', out.plain['var(--background)'] === 'rgb(31, 29, 30)', JSON.stringify(out.plain));
  }

  if (failures.length) {
    console.error(`computed-color: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`computed-color: ${checked} passed  [needsPage, probe in a real browser]`);
})();
