// Every declaration shows up somewhere in the panel.
//
//   node test/panel-sections.js
//
// A rule holding `inset: 0` showed nothing for it. Not in Position, which is
// where `inset` sorts; not in Custom properties, which is where everything the
// panel has no control for goes; nowhere. The declaration was in the file, the
// panel drew no row, and the only way to find out it was there was to read the
// CSS.
//
// A section's `order` is where a property SORTS when it is rendered. It was
// being read as a claim that it is rendered — and Position's controls ask for
// top, right, bottom and left one side at a time. They have never asked for the
// shorthand.
//
// So: a property with no control belongs in Custom properties, where it can at
// least be read and changed as text. This checks both halves — the ones known
// to have no control land there, and no property is quietly claimed by a
// section that never draws it.

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
  const out = path.join(buildDir, 'sections.bundle.js');
  await esbuild.build({
    entryPoints: [path.join(__dirname, '..', 'src', 'style-panel', 'lib', 'sections.ts')],
    outfile: out,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    logLevel: 'silent',
  });
  const { sectionOf, groupDeclarations, groupProps } = require(out);

  // ── The one that was missing ──────────────────────────────────────────────
  const decls = [
    { prop: 'position', value: 'absolute' },
    { prop: 'inset', value: '0' },
    { prop: 'content', value: '""' },
  ];
  const groups = Object.fromEntries(
    groupDeclarations(decls).map((g) => [g.def.label, g.decls.map((d) => d.prop)])
  );
  check('inset is drawn', Object.values(groups).flat().includes('inset'), JSON.stringify(groups));
  check(
    'under Custom properties, with the rest the panel has no control for',
    (groups['Custom properties'] || []).join(',') === 'inset,content',
    JSON.stringify(groups)
  );
  check('and Position still has what it does draw', (groups.Position || []).join(',') === 'position', JSON.stringify(groups));
  check('the same holds for the resolved model',
    groupProps(['inset', 'top']).some((g) => g.def.id === 'other' && g.props.includes('inset')),
    JSON.stringify(groupProps(['inset', 'top']).map((g) => [g.def.id, g.props]))
  );

  // ── Shorthands with no control ────────────────────────────────────────────
  // Each of these has longhands that DO have controls; writing a control for
  // one is what takes it off the list.
  for (const [prop, longhand] of [
    ['inset', 'top'],
    ['outline', 'outline-color'],
    ['border-top', 'border-top-width'],
    ['border-left', 'border-left-style'],
    ['columns', 'column-count'],
    ['column-rule', 'column-rule-width'],
  ]) {
    check(`${prop} goes to Custom properties`, sectionOf(prop) === 'other', sectionOf(prop));
    check(`while ${longhand} keeps its section`, sectionOf(longhand) !== 'other', sectionOf(longhand));
  }
  check('an unknown property still goes there too', sectionOf('--brand') === 'other');
  check('and a property with a control does not', sectionOf('box-shadow') === 'effects', sectionOf('box-shadow'));

  // ── Nothing else is claimed and then dropped ──────────────────────────────
  // Every property a section sorts has to be one its controls actually read.
  // Read from the sources: a control names the property it edits as a string,
  // so a property no file mentions is one nothing draws.
  //
  // Heuristic in one direction only — a name that appears for another reason
  // (`inset` is also a box-shadow keyword) can hide a missing control, which is
  // why the list above is spelled out by hand as well.
  const panelDir = path.join(__dirname, '..', 'src', 'style-panel');
  const sources = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/\.(tsx|ts)$/.test(entry.name) && !file.endsWith(path.join('lib', 'sections.ts'))) {
        sources.push(fs.readFileSync(file, 'utf8'));
      }
    }
  };
  walk(panelDir);
  const text = sources.join('\n');

  const sectionsSrc = fs.readFileSync(
    path.join(panelDir, 'lib', 'sections.ts'),
    'utf8'
  );
  const ordered = [
    ...new Set(
      [...sectionsSrc.matchAll(/order: \[([\s\S]*?)\]/g)]
        .flatMap((m) => [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]))
    ),
  ];
  check('the sections name properties to sort', ordered.length > 40, `${ordered.length}`);

  const swallowed = ordered.filter(
    (prop) => sectionOf(prop) !== 'other' && !text.includes(`'${prop}'`) && !text.includes(`"${prop}"`)
  );
  check(
    'and every one of them is drawn by the section that claims it',
    swallowed.length === 0,
    `nothing renders: ${swallowed.join(', ')} — give it a control, or list it in NO_CONTROL`
  );

  if (failures.length) {
    console.error(`\npanel-sections: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`panel-sections: ${checked} passed  [nothing swallowed]`);
})();
