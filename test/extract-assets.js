// The CSS and JS that leave the page with an extracted component.
//
//   node test/extract-assets.js
//
// After "make a component", index.astro should hold the chain of components and
// nothing else. A rule moves when every class it names is used inside the piece
// and nowhere else on the page; a class used both inside and out keeps its rules
// (moving them would break the outside use) and is counted so the app can say so.
// Tag-only and :root rules are page-wide and stay. Selector lists are split,
// media queries travel with the rules inside them, and keyframes follow the
// animation that runs them — unless something staying behind runs it too.

const fs = require('fs');
const path = require('path');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) {failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);}
};

(async () => {
  const esbuild = require('esbuild');
  const buildDir = path.join(__dirname, '..', 'node_modules', '.stacki-test');
  fs.mkdirSync(buildDir, { recursive: true });
  const out = path.join(buildDir, 'extract-assets.bundle.js');
  await esbuild.build({
    entryPoints: [path.join(__dirname, '..', 'src', 'extractAssets.ts')],
    outfile: out, bundle: true, format: 'cjs', platform: 'node', logLevel: 'silent',
  });
  const m = require(out);

  const el = (id, classes, children = [], extra = {}) => ({
    id,
    props: { class: { type: 'string', value: classes }, ...extra },
    children,
  });
  const page = [
    el('section', 'hero', [
      el('eyebrow', 'eyebrow eyebrow--dot', [], {}),
      el('title', 'hero_title'),
      el('badge', 'badge', [], { id: { type: 'string', value: 'promo' } }),
    ]),
    el('footer', 'footer', [el('foot-badge', 'badge')]),
  ];
  const inside = m.tokensOf([page[0].children[0]]);
  const outside = m.tokensOf(page, 'eyebrow');

  check('inside classes are read', inside.classes.has('eyebrow') && inside.classes.has('eyebrow--dot'));
  check('outside excludes the piece', !outside.classes.has('eyebrow') && outside.classes.has('hero'));

  const css = `
:root { --c: red; }
h1 { margin: 0; }
.eyebrow { color: red; }
.eyebrow--dot::before, .hero_title { content: ""; }
.hero .eyebrow { margin: 1px; }
@media (min-width: 800px) { .eyebrow { color: blue; } .hero { gap: 1px; } }
.hero { display: grid; }
.eyebrow { animation: blink 1s; }
@keyframes blink { to { opacity: 0; } }
`;
  const r = m.splitStyles(css, inside, outside);
  check('own rule moves', /\.eyebrow \{[^}]*color: red/.test(r.moved), r.moved);
  check('selector list is split: modifier moves', /\.eyebrow--dot::before/.test(r.moved) && !/\.eyebrow--dot::before[^{]*hero_title/.test(r.moved), r.moved);
  check('…and the foreign selector stays', /\.hero_title \{/.test(r.kept), r.kept);
  check('rule using an outside class stays', /\.hero \.eyebrow/.test(r.kept) && !/\.hero \.eyebrow/.test(r.moved));
  check('media query travels with its rule', /@media \(min-width: 800px\) \{[^}]*\.eyebrow/.test(r.moved), r.moved);
  check('…and leaves the page\'s rule in the query', /@media[^{]*\{[^}]*\.hero \{ gap/.test(r.kept.replace(/\s+/g, ' ')) || /\.hero[^}]*gap: 1px/.test(r.kept), r.kept);
  check('tag and :root rules stay', /:root/.test(r.kept) && /h1 \{/.test(r.kept) && !/:root|h1/.test(r.moved));
  check('keyframes follow their animation', /@keyframes blink/.test(r.moved) && !/@keyframes/.test(r.kept), r.moved);
  check('the page rule for .hero is untouched', /\.hero \{ display: grid; \}|\.hero \{\s*display: grid/.test(r.kept), r.kept);

  // A class used inside and outside is held, not moved.
  const shared = m.splitStyles('.badge { color: green; }', m.tokensOf([page[0].children[2]]), m.tokensOf(page, 'badge'));
  check('shared class is held back', shared.moved === '' && shared.held === 1, JSON.stringify(shared));
  check('…and the page keeps its css verbatim', shared.kept === '.badge { color: green; }');

  // Keyframes still needed by the page stay.
  const both = m.splitStyles('.eyebrow{animation:k 1s}.hero{animation:k 2s}@keyframes k{to{opacity:0}}', inside, outside);
  check('keyframes used by staying rules stay', /@keyframes k/.test(both.kept) && !/@keyframes/.test(both.moved), JSON.stringify(both));

  // Broken CSS is left alone.
  const broken = m.splitStyles('.eyebrow { color: red', inside, outside);
  check('unparseable css stays put', broken.moved === '' && broken.kept === '.eyebrow { color: red');

  // Scripts.
  const s1 = m.scriptBelongsTo("document.querySelector('.eyebrow').focus()", inside, outside);
  check('script about the piece moves', s1.moves);
  const s2 = m.scriptBelongsTo("document.querySelector('.eyebrow'); document.querySelector('.hero')", inside, outside);
  check('script that also touches the page stays', !s2.moves);
  const s3 = m.scriptBelongsTo("console.log('hi')", inside, outside);
  check('unrelated script stays', !s3.moves);
  const s4 = m.scriptBelongsTo("document.querySelector('.eyebrow--dot')", inside, outside);
  check('modifier class is not confused with its base', s4.moves);
  const s5 = m.scriptBelongsTo("querySelector('.eyebrowx')", inside, outside);
  check('a longer name is not a match', !s5.moves);

  // The whole plan, on a page model.
  const raw = (id, name, inner, props = {}) => ({ id, kind: 'raw', name, props, inner });
  const tree = [
    ...page,
    raw('st', 'style', '.eyebrow { color: red; } .hero { display: grid; }', { 'is:global': { type: 'bare' } }),
    raw('sc', 'script', "document.querySelector('.eyebrow')"),
    raw('ext', 'script', '', { src: { type: 'string', value: '/x.js' } }),
    raw('only', 'style', '.eyebrow { top: 0; }'),
  ];
  let counter = 0;
  const plan = m.planAssets(tree, 'eyebrow', () => `new${counter++}`);
  check('two style blocks and a script move', plan.moved.length === 3, JSON.stringify(plan.moved.map((b) => b.name)));
  check('styles come before scripts', plan.moved.map((b) => b.name).join() === 'style,style,script');
  check('the block keeps its attributes', plan.moved[0].props['is:global']?.type === 'bare');
  const stEdit = plan.edits.find((e) => e.id === 'st');
  check('the page block keeps what did not move', /\.hero \{ display: grid; \}/.test(stEdit.inner) && !/eyebrow/.test(stEdit.inner), JSON.stringify(stEdit));
  check('an emptied block is deleted', plan.edits.find((e) => e.id === 'only').inner === null);
  check('the moved script leaves the page', plan.edits.find((e) => e.id === 'sc').inner === null);
  check('an external script is never touched', !plan.edits.some((e) => e.id === 'ext'));

  if (failures.length) {
    console.error(`extract-assets: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`extract-assets: ${checked} checks passed`);
})();
