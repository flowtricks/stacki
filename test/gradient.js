// Keeping a gradient's colours when its kind changes.
//
//   node test/gradient.js
//
// Switching linear → radial used to seed a fresh black-to-white gradient, so
// looking at what radial did to your colours cost you the colours. Nothing
// failed and nothing was reported; the work was simply gone, and undo was the
// only way back.
//
// The rule: the STOPS are the work — picked, positioned, adjusted — and the
// kind is only how they are painted. The GEOMETRY is not carried, because it
// does not survive translation: an angle is a direction for a linear gradient
// and means nothing to a radial one, and a centre point is the reverse.
// Carrying an angle onto a radial gradient would write CSS that either does
// nothing or is invalid.

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
  const bundlePath = path.join(buildDir, 'gradient.bundle.js');
  await esbuild.build({
    entryPoints: [path.join(__dirname, '..', 'src', 'style-panel', 'lib', 'gradient.ts')],
    outfile: bundlePath,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    logLevel: 'silent',
  });
  const { parseGradient, serializeGradient, blankGradientOf } = require(bundlePath);

  // What the panel does when the kind changes.
  const switchKind = (css, next) => {
    const current = parseGradient(css);
    if (!current?.stops?.length) return null;
    return serializeGradient({
      ...blankGradientOf(next),
      repeating: current.repeating,
      stops: current.stops,
    });
  };

  // --- The colours come along -----------------------------------------------
  {
    const css = 'linear-gradient(180deg, rgb(255, 0, 0) 0%, rgb(0, 4, 255) 100%)';
    const radial = switchKind(css, 'radial');
    check('switching to radial makes a radial gradient', /^radial-gradient\(/.test(radial), radial);
    check('the first colour survives', radial.includes('rgb(255, 0, 0)'), radial);
    check('the second colour survives', radial.includes('rgb(0, 4, 255)'), radial);
    check('and their positions with them', radial.includes('0%') && radial.includes('100%'), radial);
    // The failure this file is about: a fresh black-to-white default.
    check('no default colours appear', !/#000000|#ffffff/.test(radial), radial);

    const conic = switchKind(css, 'conic');
    check('the same holds for conic', /^conic-gradient\(/.test(conic) && conic.includes('rgb(0, 4, 255)'), conic);

    // And back again, unchanged — a round trip must not drift.
    const back = switchKind(radial, 'linear');
    check(
      'switching back gives the colours again',
      back === 'linear-gradient(rgb(255, 0, 0) 0%, rgb(0, 4, 255) 100%)',
      back
    );
  }

  // --- More than two stops --------------------------------------------------
  {
    const css = 'linear-gradient(90deg, red 0%, yellow 40%, green 60%, blue 100%)';
    const radial = switchKind(css, 'radial');
    for (const c of ['red', 'yellow', 'green', 'blue']) {
      check(`${c} survives the switch`, radial.includes(c), radial);
    }
    check('and stays in order', radial.indexOf('yellow') < radial.indexOf('green'), radial);
    check('with every stop kept', parseGradient(radial).stops.length === 4, radial);
  }

  // --- The geometry does not come along -------------------------------------
  {
    // An angle is a direction. A radial gradient has no direction, and writing
    // one into it would be CSS that does nothing at best.
    const radial = switchKind('linear-gradient(45deg, red, blue)', 'radial');
    check('an angle is not carried onto a radial gradient', !radial.includes('45deg'), radial);
    check('and the result parses back', !!parseGradient(radial), radial);

    // A centre point is the reverse: meaningful for radial, meaningless for
    // linear.
    const linear = switchKind('radial-gradient(circle at 20% 30%, red, blue)', 'linear');
    check('a centre is not carried onto a linear gradient', !linear.includes('20%'), linear);
    check('nor is the shape', !linear.includes('circle'), linear);
    check('but the colours still are', linear.includes('red') && linear.includes('blue'), linear);
  }

  // --- Repeating is about the stops, so it does carry -----------------------
  {
    const r = switchKind('repeating-linear-gradient(90deg, red 0%, blue 20%)', 'radial');
    check('a repeating gradient stays repeating', /^repeating-radial-gradient\(/.test(r), r);
    const plain = switchKind('linear-gradient(90deg, red, blue)', 'radial');
    check('and a plain one stays plain', !/^repeating-/.test(plain), plain);
  }

  // --- Nothing to carry -----------------------------------------------------
  {
    // Unparseable, or empty: the caller falls back to a fresh layer rather than
    // writing a gradient with no colours in it, which is invalid CSS.
    check('an unparseable gradient carries nothing', switchKind('url(photo.png)', 'radial') === null);
    check('and so does nonsense', switchKind('not a gradient at all', 'radial') === null);
  }

  // --- A blank gradient is blank --------------------------------------------
  {
    const b = blankGradientOf('radial');
    check('a blank gradient has the kind asked for', b.type === 'radial');
    check('and no geometry at all', !b.angle && !b.shape && !b.size && !b.from && !b.posX && !b.posY, JSON.stringify(b));
    check('and no colours', b.stops.length === 0);
    check('and is not repeating', b.repeating === false);
  }

  // --- The editor must be able to read what it writes -----------------------
  //
  // Found by this file: a radial gradient with no prelude — which is exactly
  // what switching kinds now produces, and ordinary valid CSS besides — could
  // not be parsed. A stop carries a position, `red 0%`, and `0%` on its own
  // reads as a radial size, so the first STOP was swallowed as though it were
  // geometry. On a two-stop gradient that left one stop, which is not a
  // gradient, and the parse returned null: the editor would fall back to raw
  // text for a gradient it had just written itself.
  {
    const written = switchKind('linear-gradient(45deg, red 0%, blue 100%)', 'radial');
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
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
