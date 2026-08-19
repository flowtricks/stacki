// Where a picked variable goes in the field.
//
//   node test/insert-binding.js
//
// Picking a variable used to replace the whole value. For `2rem` that is the
// entire edit and exactly right. For `calc(100% - 2rem)` it threw away the
// calc — silently, with undo as the only way back — and the same for every
// clamp() and color-mix() anyone had built up.
//
// So the value decides, and this is the deciding. Both directions are worth
// pinning down: replacing an expression loses work, and inserting into a plain
// value produces nonsense like `2remvar(--x)`. Neither fails loudly.

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
  const bundlePath = path.join(buildDir, 'insert-binding.bundle.js');
  await esbuild.build({
    entryPoints: [path.join(__dirname, '..', 'src', 'style-panel', 'lib', 'insert-binding.ts')],
    outfile: bundlePath,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    logLevel: 'silent',
  });
  const { insertBinding, replacesWholeValue } = require(bundlePath);
  const V = 'var(--brand)';

  // --- Values a variable simply replaces ------------------------------------
  {
    check('a plain length is replaced', replacesWholeValue('2rem') === true);
    check('a keyword is', replacesWholeValue('auto') === true);
    check('a hex colour is', replacesWholeValue('#ff0000') === true);
    check('an empty field is', replacesWholeValue('') === true);
    // Swapping one variable for another is a replacement too.
    check('a value that is already a variable is', replacesWholeValue('var(--old)') === true);
    check('including one with a fallback', replacesWholeValue('var(--old, 10px)') === true);
    // The case from the screenshot.
    check('and a plain value with !important is', replacesWholeValue('2rem !important') === true);

    check('replacing gives just the variable', insertBinding('2rem', V, 3) === V, insertBinding('2rem', V, 3));
    check('a swap gives just the new one', insertBinding('var(--old)', V, 5) === V, insertBinding('var(--old)', V, 5));
    // Losing !important would change what the declaration does, and nobody
    // picking a variable asked for that.
    check(
      '!important survives a replacement',
      insertBinding('2rem !important', V, 2) === 'var(--brand) !important',
      insertBinding('2rem !important', V, 2)
    );
  }

  // --- Values with something to lose ----------------------------------------
  {
    check('a calc is not replaced', replacesWholeValue('calc(100% - 2rem)') === false);
    check('nor a clamp', replacesWholeValue('clamp(1rem, 2vw, 3rem)') === false);
    check('nor a color-mix', replacesWholeValue('color-mix(in srgb, red, blue)') === false);
    // Three parts, and a variable is being picked for one of them.
    check('nor a multi-part value', replacesWholeValue('1px solid red') === false);
    check('nor a calc with !important', replacesWholeValue('calc(100% - 2rem) !important') === false);

    // The point of the whole thing: the expression survives.
    const at = 'calc(100% - '.length;
    const out = insertBinding('calc(100% - 2rem)', V, at);
    check('the variable lands at the caret', out === 'calc(100% - var(--brand)2rem)', out);
    check('and the calc is still there', out.startsWith('calc(') && out.endsWith(')'), out);

    // Into a shorthand, where each part is its own thing.
    const border = insertBinding('1px solid red', V, '1px solid '.length);
    check('a shorthand keeps its other parts', border === '1px solid var(--brand)red', border);
  }

  // --- The caret inside a variable that is already there --------------------
  {
    // Two variables nested where one was meant is never what was wanted.
    const out = insertBinding('calc(var(--old) + 10px)', V, 'calc(var(--o'.length);
    check('a caret inside a variable swaps it', out === 'calc(var(--brand) + 10px)', out);
    check('rather than nesting one inside it', !out.includes('var(var('), out);
    // Right at either edge counts as inside — the caret sits against the chip.
    check(
      'the edge of a variable counts as inside it',
      insertBinding('calc(var(--old) + 1px)', V, 'calc('.length) === 'calc(var(--brand) + 1px)',
      insertBinding('calc(var(--old) + 1px)', V, 'calc('.length)
    );
  }

  // --- No caret to work from ------------------------------------------------
  {
    // The field was never focused, or the selection went before the picker
    // opened. Swapping the variable already there is the best guess.
    check(
      'with no caret an existing variable is swapped',
      insertBinding('calc(var(--old) + 1px)', V, null) === 'calc(var(--brand) + 1px)',
      insertBinding('calc(var(--old) + 1px)', V, null)
    );
    // And with nothing to swap, the variable goes on the end. Replacing the
    // whole value would be valid CSS and would quietly delete the expression —
    // the one outcome nobody could want, and the hardest to undo. This is
    // visibly wrong and takes a second to fix.
    check(
      'and with nothing to swap the expression survives',
      insertBinding('calc(100% - 2rem)', V, null) === `calc(100% - 2rem)${V}`,
      insertBinding('calc(100% - 2rem)', V, null)
    );
    check(
      'the reported case is not wiped',
      insertBinding('calc(2rem + )', V, null).startsWith('calc(2rem + )'),
      insertBinding('calc(2rem + )', V, null)
    );
  }

  // --- Carets that are out of range -----------------------------------------
  {
    // Clamped rather than trusted: an offset past the end would otherwise
    // splice with a negative index and silently reorder the value.
    check('a caret past the end lands at the end', insertBinding('calc(1px + 2px)', V, 999) === `calc(1px + 2px)${V}`, insertBinding('calc(1px + 2px)', V, 999));
    check('a negative caret lands at the start', insertBinding('calc(1px + 2px)', V, -5) === `${V}calc(1px + 2px)`, insertBinding('calc(1px + 2px)', V, -5));
    check('and a missing value does not throw', insertBinding(undefined, V, 0) === V);
  }

  if (failures.length) {
    console.error(`insert-binding: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`insert-binding: ${checked} passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
