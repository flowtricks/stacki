// What unit a move is written in.
//
//   node test/transform-units.js
//
// A translate is a length, and in a project whose type, spacing and layout are
// all set in rem, a translate written in px is the one value on the element
// that stops moving when the root size changes. So a Move starts in rem and its
// slider writes rem — and a value that already says px keeps px, because the
// unit belongs to whoever typed it, not to the control.

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
  const bundlePath = path.join(buildDir, 'transform.bundle.js');
  await esbuild.build({
    entryPoints: [path.join(__dirname, '..', 'src', 'style-panel', 'lib', 'transform.ts')],
    outfile: bundlePath,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    loader: { '.ts': 'ts' },
    logLevel: 'silent',
  });
  const { IDENTITY, blankTransform, retypeTransform, parseTransforms, serializeTransforms } = require(bundlePath);

  // --- where a move starts -----------------------------------------------------
  check('a move starts in rem', IDENTITY.move === '0rem', IDENTITY.move);
  check('a new layer is three rem axes', JSON.stringify(blankTransform('move')) === JSON.stringify({ type: 'move', x: '0rem', y: '0rem', z: '0rem' }), JSON.stringify(blankTransform('move')));
  check('and switching a layer to Move resets it to rem', retypeTransform('move').x === '0rem', retypeTransform('move').x);
  // The others are not lengths and are untouched by this.
  check('scale is still a bare number', IDENTITY.scale === '1');
  check('rotate is still degrees', IDENTITY.rotate === '0deg');
  check('skew too', IDENTITY.skew === '0deg');

  // --- a unit that was typed is kept -------------------------------------------
  const px = parseTransforms('translate3d(12px, 0px, 0px)');
  check('a translate written in px reads back as px', px[0].x === '12px', JSON.stringify(px[0]));
  check('and writes back out as px', /12px/.test(serializeTransforms(px)), serializeTransforms(px));
  const rem = parseTransforms('translate3d(4rem, 0rem, 0rem)');
  check('one in rem reads back as rem', rem[0].x === '4rem', JSON.stringify(rem[0]));
  check('and stays rem', /4rem/.test(serializeTransforms(rem)), serializeTransforms(rem));
  // Mixed units are a thing a person can write, and the file is theirs.
  const mixed = parseTransforms('translate3d(4rem, 12px, 0)');
  check(
    'a mix of units survives the round trip',
    /4rem/.test(serializeTransforms(mixed)) && /12px/.test(serializeTransforms(mixed)),
    serializeTransforms(mixed)
  );

  // --- what the slider re-attaches ---------------------------------------------
  // The slider drives the number and puts the value's own unit back on it; only
  // when the value has none does it fall back to the axis default.
  const effects = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'style-panel', 'EffectsSection.tsx'),
    'utf8'
  );
  const cfg = effects.slice(effects.indexOf('const AXIS_CFG'), effects.indexOf('/** Split'));
  check("the move axis's default unit is rem", /move: \{ unit: 'rem'/.test(cfg), cfg.match(/move: \{[^}]*\}/)?.[0]);
  check('degrees still belong to rotate and skew', /rotate: \{ unit: 'deg'/.test(cfg) && /skew: \{ unit: 'deg'/.test(cfg));
  check('and scale has no unit at all', /scale: \{ unit: ''/.test(cfg));
  check(
    'the unit comes off the value first, the default second',
    /const unit = parsed\?\.unit \?\? cfg\.unit/.test(effects),
    'the control would overwrite a unit somebody typed'
  );
  // A rem range in whole px steps would only ever land on whole rem; the steps
  // are what give the slider anything to say between 1rem and 2rem.
  const move = cfg.match(/move: \{[^}]*\}/)?.[0] ?? '';
  const steps = Number(move.match(/steps: (\d+)/)?.[1]);
  check('the move slider steps finer than one rem', steps >= 10, move);

  if (failures.length) {
    console.error(`\ntransform-units: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`transform-units: ${checked} passed`);
})();
