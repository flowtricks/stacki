// The CSS value field's two halves: the colouring, and the arrow keys.
//
//   node test/css-code.js
//
// A value in the variables sheet is edited as code — coloured as it is typed,
// and the number under the caret answers to the arrow keys (a tenth with alt,
// ten with shift). Both are easy to break in ways nothing else would notice:
// a tokeniser that drops a character silently rewrites the value it is only
// supposed to paint, and a caret restored to the wrong offset moves the user's
// cursor mid-edit. The field itself is a contentEditable holding coloured
// spans and, sometimes, a variable chip, so the caret helpers are checked
// against a real DOM rather than trusted.

const fs = require('fs');
const path = require('path');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};
const same = (what, got, want) =>
  check(what, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

(async () => {
  const esbuild = require('esbuild');
  const buildDir = path.join(__dirname, '..', 'node_modules', '.stacki-test');
  fs.mkdirSync(buildDir, { recursive: true });
  const bundlePath = path.join(buildDir, 'css-code.bundle.js');
  await esbuild.build({
    entryPoints: [path.join(__dirname, '..', 'src', 'style-panel', 'lib', 'css-code.ts')],
    outfile: bundlePath,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    logLevel: 'silent',
  });
  const { cssTokens, highlightCss, stepNumberAt, stepSize, caretOffset, setCaretOffset } = require(bundlePath);

  // --- colouring ------------------------------------------------------------
  //
  // Every value in a real sheet, and the shapes that have caught tokenisers
  // before: a bare fraction, a nested function, a quoted family, a comment.
  const VALUES = [
    'clamp(16 / 16 * 1rem, ((100vw - 20rem) / 60) * 1.5, 2.5rem)',
    'calc(100% - 4px)',
    'system-ui, sans-serif',
    '"Inter", ui-sans-serif',
    'var(--space-1, 0.5rem)',
    '#c4afff',
    '0.33em',
    '-3px',
    '.5e2%',
    '/* the site gutter */ 1rem',
    '',
  ];
  for (const value of VALUES) {
    same(`tokens rebuild "${value}"`, cssTokens(value).map((t) => t.text).join(''), value);
    // The HTML is escaped markup around the same text, so stripping the tags
    // has to give the value back — a painted field must never edit itself.
    const text = highlightCss(value)
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>');
    same(`paint keeps "${value}"`, text, value);
  }
  same('number and unit split', cssTokens('16px').map((t) => `${t.kind}:${t.text}`), ['num:16', 'unit:px']);
  same('function before its paren', cssTokens('clamp(').map((t) => t.kind), ['fn', 'plain']);
  same('custom property', cssTokens('--space-1').map((t) => t.kind), ['prop']);
  check('markup escapes', !highlightCss('a < b & c').includes('<b'), highlightCss('a < b & c'));

  // --- stepping -------------------------------------------------------------
  same('alt is a tenth', stepSize({ altKey: true }), 0.1);
  same('shift is ten', stepSize({ shiftKey: true }), 10);
  same('plain is one', stepSize({}), 1);

  same('up', stepNumberAt('8', 1, 1), { text: '9', caret: 1 });
  same('down from the left edge', stepNumberAt('8', 0, -1), { text: '7', caret: 1 });
  same('with a unit', stepNumberAt('16px', 2, 10), { text: '26px', caret: 2 });
  same('a tenth keeps its decimal', stepNumberAt('1.5rem', 3, 0.1), { text: '1.6rem', caret: 3 });
  // 0.1 + 0.2 is 0.30000000000000004 in binary floating point, and a field
  // someone is watching must not say so.
  same('float noise is rounded off', stepNumberAt('0.2', 3, 0.1), { text: '.3', caret: 2 });
  same('the number the caret is in', stepNumberAt('clamp(1rem, 2vw, 3rem)', 12, 1), { text: 'clamp(1rem, 3vw, 3rem)', caret: 13 });
  same('a signed number keeps its sign', stepNumberAt('-4px', 2, 1), { text: '-3px', caret: 2 });
  same('down through zero', stepNumberAt('1px', 1, -2), { text: '-1px', caret: 2 });
  // The minus in `100% - 4px` is an operator, not this number's sign.
  same('an operator is not a sign', stepNumberAt('calc(100% - 4px)', 13, -1), { text: 'calc(100% - 3px)', caret: 13 });
  same('nothing to step', stepNumberAt('none', 2, 1), null);
  same('nothing to step in an empty field', stepNumberAt('', 0, 1), null);

  // --- the caret, against a real DOM ---------------------------------------
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<div id="f" contenteditable="true"></div>');
  const { document } = dom.window;
  global.Node = dom.window.Node;
  global.HTMLElement = dom.window.HTMLElement;
  const field = document.getElementById('f');
  const CHIP = '\u0000'; // the placeholder the field uses for a chip
  const chip = '<span data-chip="1" contenteditable="false">space-1</span>';
  const paint = (text) => {
    field.innerHTML = text.split(CHIP).map(highlightCss).join(chip);
  };

  // An offset put back and read again is the same offset — across the coloured
  // spans the painting introduces, and across the chip, which counts as one.
  paint('clamp(1rem, 2.5vw, 3rem)');
  for (const at of [0, 1, 6, 12, 15, 24]) {
    setCaretOffset(field, at);
    same(`caret ${at} survives the spans`, caretOffset(field), at);
  }
  paint(`calc(${CHIP} + 16px)`);
  for (const at of [0, 5, 6, 9, 13]) {
    setCaretOffset(field, at);
    same(`caret ${at} survives the chip`, caretOffset(field), at);
  }
  check('the chip is still one element', field.querySelectorAll('[data-chip]').length === 1);

  if (failures.length) {
    console.error(`css-code: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`css-code: ${checked} passed  [tokens, stepping, caret]`);
})();
