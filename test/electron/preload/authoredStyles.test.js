// Goal: inherited style hints preserve source units and expressions while the
// browser still decides specificity, layers, media queries, and nesting.
// Method: bundle the real reader into Chromium, exercise competing declarations,
// and verify every temporary declaration is removed without observer invalidation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ROOT } = require('../../helpers/sources.js');

async function main() {
  const output = await require('esbuild').build({
    stdin: {
      contents: `export { authoredProperties, authoredStyleMutation }
        from './electron/preload/frameAuthoredStyles';
        export { queryAuthoredStyles } from './electron/preload/frameStyleSources';`,
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
  const directory = path.join(ROOT, 'node_modules/.stacki-test/authored-styles');
  fs.mkdirSync(directory, { recursive: true });
  const script = path.join(directory, 'probe.js');
  const html = `<!doctype html><style>
    @layer base, overrides;
    @layer base { .parent { font-size: 1rem; letter-spacing: .1em !important; } }
    @layer overrides { .parent { font-size: 2rem; letter-spacing: .2em !important; } }
    .parent { --heading: clamp(2rem, 4vw, 4rem); font-size: var(--heading);
      line-height: 1.1; cursor: pointer; color: rgb(12, 34, 56); width: 30rem; }
    @media (min-width: 1px) { .parent { font-size: clamp(2rem, 4vw, 4rem); } }
    @media (min-width: 99999px) { .parent { font-size: 99rem !important; } }
    .parent { & > .nested { font-size: calc(1rem + 1vw); } }
    #inline { font-size: 7rem !important; }
    .explicit-inherit { font-size: inherit; width: inherit; }
    .same-rule { font-size: 2rem; }
    .reset { font-size: initial; }
    .all-reset { all: initial; }
    .all-override { all: initial; font-size: 4rem; }
    :root { --font-sans: Arial; }
    .stat { font: 800 2rem / 1 var(--font-sans); font-variant-numeric: tabular-nums; }
  </style><style id="avb-design-style">* { cursor: default !important; }</style>
    <div class="parent" data-avb-p="src/components/Heading.astro|0 0"
      style="font-family: var(--font);--font: Georgia">
    <span id="child">Inherited</span><span id="nested" class="nested">Nested</span>
    <span id="inline" style="font-size: 3rem">Inline</span>
    <span id="middle"><span id="grandchild">Grandchild</span></span>
    <span id="near" data-avb-p="0.4" style="font-size: 5rem"><b id="near-child">Near</b></span>
    <span id="explicit-inherit" class="explicit-inherit">Explicit inherit</span>
    <span class="same-rule"><b id="same-rule" class="same-rule">Own rule</b></span>
    <span id="reset" class="reset">Reset</span>
    <span id="all-reset" class="all-reset">Reset all</span>
    <span id="all-override" class="all-override">Override all</span>
    <span id="stat" class="stat">42</span>
  </div>`;
  const exercise = `(() => {
    const child = document.getElementById('child');
    const parent = child.parentElement;
    const props = ['font-size', 'line-height', 'font-family', 'letter-spacing', 'width', 'cursor'];
    const before = Array.from(document.styleSheets).map(sheet =>
      Array.from(sheet.cssRules).map(rule => rule.cssText).join(''));
    const inlineBefore = parent.getAttribute('style');
    const observer = new MutationObserver(() => {});
    observer.observe(document.body, { attributes: true, attributeOldValue: true, subtree: true });
    const inherited = reader.authoredProperties(child, props);
    const sourceOf = (element, target = 'element') =>
      reader.queryAuthoredStyles(element, props, target).inheritedSources;
    const sources = {
      child: sourceOf(child),
      text: sourceOf(parent, 'text'),
      parent: sourceOf(parent),
      grandchild: sourceOf(document.getElementById('grandchild')),
      near: sourceOf(document.getElementById('near-child')),
      explicit: sourceOf(document.getElementById('explicit-inherit')),
      same: sourceOf(document.getElementById('same-rule')),
      reset: sourceOf(document.getElementById('reset')),
    };
    const nested = reader.authoredProperties(document.getElementById('nested'), props);
    const inline = reader.authoredProperties(document.getElementById('inline'), props);
    const reset = reader.authoredProperties(document.getElementById('reset'), props);
    const parentHints = reader.authoredProperties(parent, props);
    const allReset = reader.authoredProperties(document.getElementById('all-reset'), props);
    const allOverride = reader.authoredProperties(document.getElementById('all-override'), props);
    // A var() shorthand followed by one of its longhands serializes with empty
    // longhands; the probe cleanup must not write that text back (issue #71).
    const stat = document.getElementById('stat');
    reader.authoredProperties(stat, ['font-variant-numeric', 'font-weight', ...props]);
    const statStyle = getComputedStyle(stat);
    const statAfter = { weight: statStyle.fontWeight, size: statStyle.fontSize };
    const oversized = reader.authoredProperties(child, Array(513).fill('color'));
    const sheet = document.styleSheets[0];
    Object.defineProperty(sheet, 'cssRules', { configurable: true, get() {
      throw new DOMException('Cross origin', 'SecurityError');
    } });
    const inaccessible = reader.authoredProperties(child, props);
    delete sheet.cssRules;
    const inlineAfter = parent.getAttribute('style');
    const records = observer.takeRecords();
    const ignored = records.every(reader.authoredStyleMutation);
    parent.style.fontSize = '9rem';
    const realChange = observer.takeRecords().some(record => !reader.authoredStyleMutation(record));
    parent.style.removeProperty('font-size');
    observer.disconnect();
    const after = Array.from(document.styleSheets).map(sheet =>
      Array.from(sheet.cssRules).map(rule => rule.cssText).join(''));
    // Test real layout, not just syntax support: trimming must remove leading.
    const trimSample = document.createElement('div');
    trimSample.style.cssText = 'font: 64px/2 Arial; margin: 0';
    trimSample.textContent = 'Text box';
    document.body.append(trimSample);
    const heightBefore = trimSample.getBoundingClientRect().height;
    trimSample.style.setProperty('text-box', 'trim-both cap alphabetic');
    const textBox = {
      supported: CSS.supports('text-box', 'trim-both cap alphabetic'),
      trim: getComputedStyle(trimSample).getPropertyValue('text-box-trim'),
      edge: getComputedStyle(trimSample).getPropertyValue('text-box-edge'),
      reduced: trimSample.getBoundingClientRect().height < heightBefore,
    };
    trimSample.remove();
    return { sources, inherited, nested, inline, reset, parentHints, allReset, allOverride,
      oversized, inaccessible, before, after, textBox, statAfter,
      inlineBefore, inlineAfter, ignored, realChange,
      computed: getComputedStyle(child).fontSize };
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
  const run = spawnSync(require('electron'), [script], { encoding: 'utf8', timeout: 30000 });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const line = run.stdout.split('\n').find((line) => line.startsWith('{'));
  assert.ok(line, run.stderr || run.stdout);
  const result = JSON.parse(line);
  assert.deepEqual(result.textBox, {
    supported: true,
    trim: 'trim-both',
    edge: 'cap alphabetic',
    reduced: true,
  });
  assert.deepEqual(result.sources.child['font-size'], { label: '.parent', path: '0' });
  assert.deepEqual(result.sources.text['font-size'], result.sources.child['font-size']);
  assert.deepEqual(result.sources.grandchild['font-size'], result.sources.child['font-size']);
  assert.deepEqual(result.sources.near['font-size'], { label: '#near', path: '0.4' });
  assert.deepEqual(result.sources.explicit['font-size'], result.sources.child['font-size']);
  assert.deepEqual(result.sources.explicit.width, { label: '.parent', path: '0' });
  assert.equal(result.sources.parent['font-size'], undefined, 'own declarations are not inherited');
  assert.equal(result.sources.same['font-size'], undefined, 'the same rule can apply directly');
  assert.equal(result.sources.reset['font-size'], undefined, 'initial has no inherited source');
  assert.equal(result.sources.child.width, undefined, 'noninheriting defaults have no source');
  assert.equal(result.inherited['font-size'], 'clamp(2rem, 4vw, 4rem)');
  assert.equal(result.inherited['line-height'], '1.1');
  assert.equal(result.inherited['font-family'], 'var(--font)');
  assert.equal(result.inherited['letter-spacing'], '0.1em', 'important layer order is reversed');
  assert.equal(result.inherited.width, undefined, 'width does not inherit by default');
  assert.equal(result.parentHints.width, '30rem');
  assert.equal(result.inherited.cursor, 'pointer', 'editor CSS does not replace authored values');
  assert.equal(result.allReset['font-size'], undefined, 'all: initial stops inheritance');
  assert.equal(result.allOverride['font-size'], '4rem', 'a declaration can override all');
  assert.deepEqual(result.statAfter, { weight: '800', size: '32px' }, 'var() shorthands survive');
  assert.deepEqual(result.oversized, {}, 'inspection is bounded');
  assert.deepEqual(result.inaccessible, {}, 'inaccessible CSS cannot report a false winner');
  assert.equal(result.nested['font-size'], 'calc(1rem + 1vw)');
  assert.equal(result.inline['font-size'], '7rem', 'important CSS beats normal inline styles');
  assert.equal(result.reset['font-size'], undefined, 'initial stops inheritance');
  assert.match(result.computed, /px$/, 'the authored hint differs from resolved pixels');
  assert.deepEqual(result.before, result.after, 'stylesheet declarations are restored');
  assert.equal(result.inlineBefore, result.inlineAfter, 'inline CSS remains unchanged');
  assert.equal(result.ignored, true, 'inspection does not invalidate the canvas');
  assert.equal(result.realChange, true, 'real style changes still invalidate the canvas');
  console.log('authored-styles: browser cascade, inheritance, original values and cleanup passed');
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
