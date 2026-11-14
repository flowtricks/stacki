// Goal: the canvas reports, for a custom property, the declaration that wins for the selected
// element AS WRITTEN (`var(--brand)`, a font stack, a hex), found by tracing up its parents, with
// the rule's selector, file and declaring ancestor; never a computed value.
// Method: bundle the real reader into Chromium, build a page whose cascade has a theme wrapper over
// the element, a sibling outside it, !important, specificity, layers, a media query that does not
// apply, inline styles on an ancestor and a development style tag carrying a file id, then check
// every answer, that probes leave no trace (stylesheets, inline styles, no canvas invalidation),
// and that bounds and inaccessible sheets answer nothing rather than a false winner.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ROOT } = require('../../helpers/sources.js');

async function main() {
  const output = await require('esbuild').build({
    stdin: {
      contents: `export { inspectWinningDeclarations } from './electron/preload/frameAuthoredStyles';
        export { authoredStyleMutation } from './electron/preload/frameAuthoredStyles';`,
      resolveDir: ROOT,
      loader: 'ts',
    },
    bundle: true,
    format: 'iife',
    globalName: 'reader',
    platform: 'browser',
    write: false,
    logLevel: 'silent',
  });
  const directory = path.join(ROOT, 'node_modules/.stacki-test/winning-declarations');
  fs.mkdirSync(directory, { recursive: true });
  const script = path.join(directory, 'probe.js');
  const html = `<!doctype html>
  <style data-vite-dev-id="/project/src/styles/tokens.css">
    @layer first, second;
    :root { --light-300: #f3f3f3; --brand: #c6fb50; --background: var(--light-300);
      --primary-family: Inter-a7104050ada94962, "Inter Fallback", sans-serif;
      --display-font-family: var(--primary-family); --mix: color-mix(in srgb, var(--brand) 20%, transparent);
      --cond: base; --literal: #112233; }
    .theme-dark { --background: var(--brand); }
    .tile { --pick: red; --imp: normal; }
    #el { --pick: blue; }
    .important { --imp: forced !important; }
    @media (min-width: 99999px) { :root { --cond: never; } }
    @layer first { .layered { --lay: first !important; } }
    @layer second { .layered { --lay: second !important; } }
    .spaced { --spaced:   calc( 1rem   +  2px ); }
  </style>
  <div class="theme-dark" style="--inline: 2px; --background: var(--brand)">
    <div id="inside"><span id="el" class="tile important layered spaced">x</span></div>
  </div>
  <div id="outside">y</div>`;
  const exercise = `(() => {
    const el = document.getElementById('el');
    const outside = document.getElementById('outside');
    const names = ['--background', '--primary-family', '--display-font-family', '--mix', '--cond', '--literal', '--pick', '--imp', '--lay', '--inline', '--spaced', '--missing'];
    const before = Array.from(document.styleSheets).map((sheet) => Array.from(sheet.cssRules).map((rule) => rule.cssText).join(''));
    const inlineBefore = el.parentElement.parentElement.getAttribute('style');
    const observer = new MutationObserver(() => {});
    observer.observe(document.body, { attributes: true, attributeOldValue: true, subtree: true });
    const inside = reader.inspectWinningDeclarations(el, names);
    const sibling = reader.inspectWinningDeclarations(outside, names);
    const records = observer.takeRecords();
    const ignored = records.every(reader.authoredStyleMutation);
    observer.disconnect();
    const after = Array.from(document.styleSheets).map((sheet) => Array.from(sheet.cssRules).map((rule) => rule.cssText).join(''));
    const inlineAfter = el.parentElement.parentElement.getAttribute('style');
    const many = reader.inspectWinningDeclarations(el, Array.from({ length: 513 }, (_, i) => '--n' + i));
    const sheet = document.styleSheets[0];
    Object.defineProperty(sheet, 'cssRules', { configurable: true, get() { throw new DOMException('Cross origin', 'SecurityError'); } });
    const inaccessible = reader.inspectWinningDeclarations(el, names);
    delete sheet.cssRules;
    const again = reader.inspectWinningDeclarations(el, ['--background']);
    return { inside, sibling, ignored, before, after, inlineBefore, inlineAfter, many, inaccessible, again,
      computedBackground: getComputedStyle(el).getPropertyValue('--background') };
  })()`;
  fs.writeFileSync(
    script,
    `
    const { app, BrowserWindow } = require('electron');
    app.whenReady().then(async () => {
      const window = new BrowserWindow({ show: false, width: 1000, height: 600 });
      try {
        await window.loadURL('data:text/html,' + encodeURIComponent(${JSON.stringify(html)}));
        await window.webContents.executeJavaScript(${JSON.stringify(output.outputFiles[0].text)});
        const result = await window.webContents.executeJavaScript(${JSON.stringify(exercise)});
        console.log(JSON.stringify(result));
      } catch (error) {
        console.error(error);
        process.exitCode = 1;
      } finally {
        window.destroy();
        app.quit();
      }
    });
  `,
  );
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const run = spawnSync(require('electron'), [script], { encoding: 'utf8', timeout: 30000, env: environment });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const line = run.stdout.split('\n').find((text) => text.startsWith('{'));
  assert.ok(line, run.stderr || run.stdout);
  const result = JSON.parse(line);
  const { inside, sibling } = result;
  // The theme wrapper's declaration wins for the element inside it, as written and with its place.
  assert.equal(inside['--background'].expression, 'var(--brand)', 'the text written, not #c6fb50');
  assert.equal(inside['--background'].selector, 'style', 'the wrapper declares it inline, which beats the rule');
  assert.equal(inside['--background'].depth, 2);
  assert.equal(inside['--background'].ancestor, '.theme-dark');
  assert.notEqual(inside['--background'].expression, result.computedBackground);
  // The sibling outside the wrapper sees the :root declaration.
  assert.equal(sibling['--background'].expression, 'var(--light-300)');
  assert.equal(sibling['--background'].selector, ':root');
  assert.equal(sibling['--background'].file, '/project/src/styles/tokens.css');
  assert.equal(sibling['--background'].ancestor, 'html');
  assert.equal(sibling['--background'].depth, 2);
  // Font stacks, var chains, colour mixes and literals are text, not the resolved value.
  assert.equal(inside['--primary-family'].expression, 'Inter-a7104050ada94962, "Inter Fallback", sans-serif');
  assert.equal(inside['--display-font-family'].expression, 'var(--primary-family)');
  assert.equal(inside['--mix'].expression, 'color-mix(in srgb, var(--brand) 20%, transparent)');
  assert.equal(inside['--literal'].expression, '#112233');
  // Specificity, importance, layers, conditions and spacing.
  assert.equal(inside['--pick'].expression, 'blue', 'an id beats a class');
  assert.equal(inside['--pick'].selector, '#el');
  assert.equal(inside['--pick'].depth, 0);
  assert.equal(inside['--imp'].expression, 'forced', '!important beats a later normal declaration');
  assert.equal(inside['--lay'].expression, 'first', 'important declarations reverse layer order');
  assert.equal(inside['--cond'].expression, 'base', 'a media query that does not apply is not the winner');
  assert.equal(inside['--spaced'].expression, 'calc( 1rem + 2px )', 'whitespace is normalized, nothing else');
  // Inline styles on an ancestor.
  assert.equal(inside['--inline'].expression, '2px');
  assert.equal(inside['--inline'].selector, 'style');
  assert.equal(inside['--inline'].ancestor, '.theme-dark');
  assert.equal(inside['--missing'], undefined, 'an undeclared name is not answered');
  // Probes leave nothing behind and do not look like an edit.
  assert.deepEqual(result.before, result.after, 'stylesheet declarations are restored');
  assert.equal(result.inlineBefore, result.inlineAfter, 'inline CSS is unchanged');
  assert.equal(result.ignored, true, 'inspection does not invalidate the canvas');
  // Bounds and safety.
  assert.deepEqual(result.many, {}, 'a question past the bound is not answered');
  assert.deepEqual(result.inaccessible, {}, 'an inaccessible sheet cannot report a false winner');
  assert.equal(result.again['--background'].expression, 'var(--brand)', 'a later question still works');
  console.log('winning-declarations: cascade, ancestor trace, as-written text and cleanup passed');
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
