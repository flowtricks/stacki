// Goal: the close button in the Property settings header draws its X dead
// centre. A text "×" glyph sits high and to the right of a button's middle
// (font ascent and side bearings), so the button must hold the Central close
// icon, a block-level square svg whose geometry is centred on its own viewBox.
// Method: render the real CloseIcon at the size the header uses, then read the
// header button's CSS and both header sources and pin the centring contract:
// flex centring both axes, no margin or transform, a square box, no glyph.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const { createElement } = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const esbuild = require('esbuild');
const { repoPath } = require('../../helpers/sources.js');

function ruleBody(css, selector) {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, `${selector} rule exists`);
  return css.slice(start, css.indexOf('}', start));
}

test('the header close button centres a square block icon', async () => {
  const css = fs.readFileSync(repoPath('src/features/componentProperties/componentProperties.css'), 'utf8');
  const rule = ruleBody(css, '.property-editor header button');
  assert.match(rule, /display: inline-flex;/);
  assert.match(rule, /align-items: center;/);
  assert.match(rule, /justify-content: center;/);
  assert.match(rule, /padding: 0;/);
  assert.match(rule, /margin: 0;/);
  assert.match(rule, /line-height: 0;/);
  assert.doesNotMatch(rule, /transform|position: relative|top:|left:/);
  const width = /width: (\d+)px;/.exec(rule);
  const height = /height: (\d+)px;/.exec(rule);
  assert.ok(width && height);
  assert.equal(width[1], height[1]);

  const { outputFiles } = await esbuild.build({
    entryPoints: [repoPath('src/ui/Icons.tsx')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    jsx: 'automatic',
    external: ['react', 'react/jsx-runtime'],
    loader: { '.css': 'empty' },
    write: false,
  });
  const bundled = outputFiles[0];
  assert.ok(bundled);
  const bundleModule = { exports: {} };
  new Function('require', 'module', 'exports', bundled.text)(
    createRequire(repoPath('node_modules/.stacki-test/close.cjs')),
    bundleModule,
    bundleModule.exports,
  );
  const markup = renderToStaticMarkup(createElement(bundleModule.exports.CloseIcon, { size: 12 }));
  assert.match(markup, /width="12" height="12" viewBox="0 0 24 24"/);
  assert.match(markup, /display:block/);
  // The X's four ends are mirrored about (12, 12): 4.75 + 19.25 = 24 = 12 + 12.
  assert.match(markup, /M4\.75 4\.75L12 12M12 12L19\.25 19\.25M12 12L19\.25 4\.75M12 12L4\.75 19\.25/);
  assert.doesNotMatch(markup, /translate\(/);
});

test('both Property settings headers use the icon, never a text glyph', () => {
  for (const file of ['PropertyEditor.tsx', 'PropertySettingsDialog.tsx']) {
    const source = fs.readFileSync(repoPath(`src/features/componentProperties/${file}`), 'utf8');
    assert.match(source, /<CloseIcon size=\{12\} \/>/, `${file} draws CloseIcon`);
    assert.doesNotMatch(source, /^\s*[×x✕✖]\s*$/m, `${file} has no text close glyph`);
  }
});
