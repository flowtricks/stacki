// Reading and writing gradients: a blank gradient of each kind, and gradients
// the editor writes reading back the same.
//
//   node test/renderer/style/gradient.test.js
//
// Switching a layer's kind used to carry its colours into the new kind; it now
// starts that kind from its default, and that rule is held by
// test/renderer/style/layerKindSwitch.test.js. What stays here is the model.

const fs = require('fs');
const path = require('path');
const { repoPath } = require('../../helpers/sources.js');

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
  const bundlePath = path.join(buildDirectory, 'gradient.bundle.js');
  await esbuild.build({
    entryPoints: [repoPath('src/features/style/model/gradient.ts')],
    outfile: bundlePath,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    logLevel: 'silent',
  });
  const { parseGradient, serializeGradient, blankGradientOf } = require(bundlePath);

  // --- A blank gradient is blank --------------------------------------------
  {
    const blank = blankGradientOf('radial');
    check('a blank gradient has the kind asked for', blank.type === 'radial');
    check('and no geometry at all', !blank.angle && !blank.shape && !blank.size && !blank.from && !blank.posX && !blank.posY, JSON.stringify(blank));
    check('and no colours', blank.stops.length === 0);
    check('and is not repeating', blank.repeating === false);
  }

  // --- The editor must be able to read what it writes -----------------------
  //
  // Found by this file: a radial gradient with no prelude — ordinary valid CSS,
  // and what the editor writes for a radial gradient left at its defaults —
  // could not be parsed. A stop carries a position, `red 0%`, and `0%` on its own
  // reads as a radial size, so the first STOP was swallowed as though it were
  // geometry. On a two-stop gradient that left one stop, which is not a
  // gradient, and the parse returned null: the editor would fall back to raw
  // text for a gradient it had just written itself.
  {
    const written = serializeGradient({ ...blankGradientOf('radial'), stops: parseGradient('linear-gradient(45deg, red 0%, blue 100%)').stops });
    const reparsed = parseGradient(written);
    check('a gradient the editor writes can be read back', !!reparsed, written);
    check('with both stops', reparsed?.stops.length === 2, JSON.stringify(reparsed?.stops));
    check('and no stop mistaken for geometry', !reparsed?.shape && !reparsed?.size, JSON.stringify(reparsed));

    // The preludes that ARE preludes must still be recognised.
    const shaped = parseGradient('radial-gradient(circle, red, blue)');
    check('a shape is still a prelude', shaped?.shape === 'circle', JSON.stringify(shaped));
    const sized = parseGradient('radial-gradient(farthest-corner at 20% 30%, red, blue)');
    check('a size keyword with a centre still is', sized?.size === 'farthest-corner', JSON.stringify(sized));
    check('and the centre is read', sized?.posX === '20%' && sized?.posY === '30%', JSON.stringify(sized));
    const explicit = parseGradient('radial-gradient(20px 40px, red, blue)');
    check('an explicit size still is', explicit?.size === '20px 40px', JSON.stringify(explicit));
    check('and it keeps both stops', explicit?.stops.length === 2, JSON.stringify(explicit?.stops));
  }

  if (failures.length) {
    console.error(`gradient: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`gradient: ${checked} passed`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
