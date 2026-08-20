// Moving a component into a folder without breaking the site.
//
//   node test/move-component.js
//
// The asymmetry with pages is the whole reason this is its own module.
// `page:move` rewrites the imports the moved file CONTAINS, because nothing
// imports a page. A component is the other way round — everything imports it,
// and a move that only fixed the file's own imports leaves every page pointing
// at a path that no longer exists. Astro does not render a gap: the build
// fails, naming an import rather than the drag that caused it.
//
// So both directions are checked here, against real files on disk, in the
// spellings a real project uses: relative from a page, relative from a sibling
// component, through a tsconfig alias, and without the extension.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { planMove, applyMove } = require('../electron/moveComponent.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};

const made = [];
function project(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-move-'));
  made.push(dir);
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text, 'utf8');
  }
  return dir;
}
const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');

const HERO = 'src/components/Hero.astro';
const MOVED = 'src/components/marketing/Hero.astro';

// --- what everyone else has to change ---------------------------------------

{
  const dir = project({
    [HERO]: '---\n---\n<section>hi</section>\n',
    'src/pages/index.astro': "---\nimport Hero from '../components/Hero.astro';\n---\n<Hero />\n",
  });
  const plan = planMove(dir, path.join(dir, HERO), path.join(dir, MOVED));
  check('a page importing it is in the plan', plan.files.length === 1, JSON.stringify(plan.files.map((f) => f.rel)));
  applyMove(dir, path.join(dir, HERO), path.join(dir, MOVED), plan);
  check('the file is where it was sent', fs.existsSync(path.join(dir, MOVED)));
  check('and gone from where it was', !fs.existsSync(path.join(dir, HERO)));
  check(
    'the page now points at the folder',
    /from '\.\.\/components\/marketing\/Hero\.astro'/.test(read(dir, 'src/pages/index.astro')),
    read(dir, 'src/pages/index.astro')
  );
}

{
  // A sibling's path changes by a different amount than a page's does.
  const dir = project({
    [HERO]: '---\n---\n<section>hi</section>\n',
    'src/components/Card.astro': "---\nimport Hero from './Hero.astro';\n---\n<Hero />\n",
  });
  const plan = planMove(dir, path.join(dir, HERO), path.join(dir, MOVED));
  applyMove(dir, path.join(dir, HERO), path.join(dir, MOVED), plan);
  check(
    'a sibling component follows it down',
    /from '\.\/marketing\/Hero\.astro'/.test(read(dir, 'src/components/Card.astro')),
    read(dir, 'src/components/Card.astro')
  );
}

{
  const dir = project({
    'tsconfig.json': '{ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"] } } }',
    [HERO]: '---\n---\n<section>hi</section>\n',
    'src/pages/index.astro': "---\nimport Hero from '@/components/Hero.astro';\n---\n<Hero />\n",
  });
  const plan = planMove(dir, path.join(dir, HERO), path.join(dir, MOVED));
  applyMove(dir, path.join(dir, HERO), path.join(dir, MOVED), plan);
  const page = read(dir, 'src/pages/index.astro');
  check('an aliased import keeps its alias', /from '@\//.test(page), page);
  check('and only the path under it changes', /'@\/components\/marketing\/Hero\.astro'/.test(page), page);
}

{
  const dir = project({
    [HERO]: '---\n---\n<section>hi</section>\n',
    'src/pages/index.astro': "---\nimport Hero from '../components/Hero';\n---\n<Hero />\n",
  });
  const plan = planMove(dir, path.join(dir, HERO), path.join(dir, MOVED));
  applyMove(dir, path.join(dir, HERO), path.join(dir, MOVED), plan);
  const page = read(dir, 'src/pages/index.astro');
  check('an import written without the extension is found', /marketing\/Hero/.test(page), page);
  check('and stays written without it', !/\.astro/.test(page), page);
}

{
  const dir = project({
    [HERO]: '---\n---\n<section>hi</section>\n',
    'src/pages/index.astro': "---\nimport HeroBanner from '../components/HeroBanner.astro';\n---\n<HeroBanner />\n",
    'src/components/HeroBanner.astro': '---\n---\n<div />\n',
  });
  const plan = planMove(dir, path.join(dir, HERO), path.join(dir, MOVED));
  check('a longer name that merely starts the same is left alone', plan.files.length === 0, JSON.stringify(plan.files));
}

// --- what the file itself has to change -------------------------------------

{
  const dir = project({
    [HERO]: "---\nimport Button from './Button.astro';\nimport styles from '../styles/x.css';\n---\n<Button />\n",
    'src/components/Button.astro': '---\n---\n<button />\n',
    'src/styles/x.css': '',
  });
  const plan = planMove(dir, path.join(dir, HERO), path.join(dir, MOVED));
  applyMove(dir, path.join(dir, HERO), path.join(dir, MOVED), plan);
  const moved = read(dir, MOVED);
  check('its own sibling import climbs back out', /from '\.\.\/Button\.astro'/.test(moved), moved);
  check('and so does one reaching outside components', /from '\.\.\/\.\.\/styles\/x\.css'/.test(moved), moved);
}

{
  const dir = project({
    [HERO]: "---\nimport { getCollection } from 'astro:content';\n---\n<section />\n",
  });
  const plan = planMove(dir, path.join(dir, HERO), path.join(dir, MOVED));
  applyMove(dir, path.join(dir, HERO), path.join(dir, MOVED), plan);
  check(
    'a bare module specifier is not a path and is untouched',
    /from 'astro:content'/.test(read(dir, MOVED)),
    read(dir, MOVED)
  );
}

// --- moving back out --------------------------------------------------------

{
  const dir = project({
    [MOVED]: '---\n---\n<section>hi</section>\n',
    'src/pages/index.astro': "---\nimport Hero from '../components/marketing/Hero.astro';\n---\n<Hero />\n",
  });
  const plan = planMove(dir, path.join(dir, MOVED), path.join(dir, HERO));
  applyMove(dir, path.join(dir, MOVED), path.join(dir, HERO), plan);
  check(
    'a move back to the root is the same job in reverse',
    /from '\.\.\/components\/Hero\.astro'/.test(read(dir, 'src/pages/index.astro')),
    read(dir, 'src/pages/index.astro')
  );
}

// --- what it cannot fix, said out loud --------------------------------------

{
  const dir = project({
    'tsconfig.json':
      '{ "compilerOptions": { "baseUrl": ".", "paths": { "@hero": ["src/components/Hero.astro"] } } }',
    [HERO]: '---\n---\n<section>hi</section>\n',
    'src/pages/index.astro': "---\nimport Hero from '@hero';\n---\n<Hero />\n",
  });
  const plan = planMove(dir, path.join(dir, HERO), path.join(dir, MOVED));
  check('an alias naming the file itself is reported', plan.bare.length === 1, JSON.stringify(plan.bare));
  check('and not rewritten, since the fix is in tsconfig', plan.files.length === 0, JSON.stringify(plan.files));
}

// --- nothing is written while planning --------------------------------------

{
  const dir = project({
    [HERO]: '---\n---\n<section>hi</section>\n',
    'src/pages/index.astro': "---\nimport Hero from '../components/Hero.astro';\n---\n<Hero />\n",
  });
  const before = read(dir, 'src/pages/index.astro');
  planMove(dir, path.join(dir, HERO), path.join(dir, MOVED));
  check('planning touches nothing', read(dir, 'src/pages/index.astro') === before);
  check('and leaves the file where it is', fs.existsSync(path.join(dir, HERO)));
}

for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });

if (failures.length) {
  console.error(`move-component: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
  process.exit(1);
}
console.log(`move-component: ${checked} passed`);
