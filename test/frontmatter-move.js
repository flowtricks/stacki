// The code behind the markup, when the markup moves.
//
//   node test/frontmatter-move.js
//
// A page's frontmatter is what its markup is made of: `const jobs = […]` behind
// `options={jobs}`, `import hero from '…'` behind `src={hero}`. Nothing in the
// file says which line is there for which element, so two things went wrong in
// opposite directions.
//
// Delete the element and the code stayed — a page collects dead consts one
// deletion at a time, and nobody can tell later which of them are dead.
//
// Copy the element into another page and the code did NOT come — the paste
// renders nothing, or throws, and the name it wanted is back on a page that is
// no longer open.
//
// Both are the same question — which names does this markup read — asked from
// either end. The answers lean opposite ways: carrying a line too many leaves
// an unused import, dropping a line too many breaks the page. So reading is
// generous and deleting is refused for anything it cannot be sure of.

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
  const out = path.join(buildDir, 'frontmatter-move.bundle.mjs');
  await esbuild.build({
    entryPoints: [path.join(__dirname, '..', 'src', 'frontmatterMove.js')],
    outfile: out,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
  });
  const {
    identifiersIn,
    namesUsedIn,
    neededFrontmatter,
    unusedDeclarations,
    withStatements,
    withoutDeclarations,
  } = await import(`file://${out}?v=${Date.now()}`);

  // --- what a piece of markup reads ------------------------------------------------
  {
    const nodes = [
      {
        kind: 'component',
        name: 'Card',
        props: { options: { type: 'expr', value: 'jobs' }, title: { type: 'string', value: 'jobs' } },
        children: [
          { kind: 'map', head: 'posts.map((post) => (', children: [
            { kind: 'expr', value: '{post.data.title}' },
          ] },
          { kind: 'cond', test: 'showFooter && year > 2020', children: [] },
        ],
      },
    ];
    const names = [...namesUsedIn(nodes)].sort();
    check('the component it renders', names.includes('Card'), names.join());
    check('a name in a prop expression', names.includes('jobs'), names.join());
    check('the list a loop walks', names.includes('posts'), names.join());
    check('and what a condition asks about', names.includes('showFooter') && names.includes('year'), names.join());
    check('a loop variable is read where it is used', names.includes('post'), names.join());
    check(
      'but a prop that is TEXT is not a name',
      !JSON.stringify(nodes).includes('__') && names.filter((n) => n === 'jobs').length === 1,
      names.join()
    );
    check('nor is a property of something else', !names.includes('data') && !names.includes('title'), names.join());
  }

  // A name inside a string is text. A name inside a template's hole is code.
  {
    const said = [...identifiersIn('`Since ${year}` + "not-a-name" + other')].sort();
    check('a hole in a template is read', said.includes('year'), said.join());
    check('the words around it are not', !said.includes('Since'), said.join());
    check('and neither is a quoted one', !said.includes('not'), said.join());
    check('a bare name beside them is', said.includes('other'), said.join());
  }

  // --- what may go when the markup goes ---------------------------------------------
  const FRONTMATTER = [
    "import Card from '@/components/Card.astro';",
    "import hero from '../assets/hero.png';",
    "const jobs = ['Designer', 'Developer'];",
    'const year = 2026;',
    'const label = `Since ${year}`;',
    "const posts = await getCollection('blog');",
    'export const prerender = true;',
  ].join('\n');

  {
    // The page after a delete: only the Card, reading `jobs`.
    const model = {
      extraFrontmatter: FRONTMATTER,
      nodes: [{ kind: 'component', name: 'Card', props: { options: { type: 'expr', value: 'jobs' } } }],
    };
    const dead = unusedDeclarations(model).map((d) => d.name).sort();
    check('a const nothing reads any more is offered up', dead.includes('label'), dead.join());
    check('and so is the one that only fed it', dead.includes('year'), dead.join());
    check('one the markup still reads is kept', !dead.includes('jobs'), dead.join());
    check('an export is never touched', !dead.includes('prerender'), dead.join());
    check('and neither are imports — that is another rule', !dead.includes('hero'), dead.join());
    check('a const nothing reads, but nothing feeds either', dead.includes('posts'), dead.join());

    const left = withoutDeclarations(model.extraFrontmatter, dead);
    check('what is left still has the live one', /const jobs =/.test(left), left);
    check('and has lost the dead ones', !/const year|const label/.test(left), left);
    check('with no hole where they were', !/\n\n\n/.test(left), JSON.stringify(left));
    check('and the imports untouched', /import Card/.test(left) && /import hero/.test(left), left);
  }

  // A const the markup never names, but another const does. `featured` is what
  // the page shows; `posts` is where it came from, and taking it out would
  // leave `featured` reading a name that is not there.
  {
    const model = {
      extraFrontmatter: "const posts = await getCollection('blog');\nconst featured = posts[0];",
      nodes: [{ kind: 'expr', value: '{featured.data.title}' }],
    };
    const dead = unusedDeclarations(model).map((d) => d.name);
    check('a const another const reads is kept', !dead.includes('posts'), dead.join());
    check('and nothing is taken at all here', dead.length === 0, dead.join());
  }

  // The same chain with nothing reading the end of it: both go.
  {
    const model = {
      extraFrontmatter: "const posts = await getCollection('blog');\nconst featured = posts[0];",
      nodes: [{ kind: 'element', name: 'div' }],
    };
    const dead = unusedDeclarations(model).map((d) => d.name).sort();
    check('a whole dead chain goes', dead.join() === 'featured,posts', dead.join());
  }

  // A name read by markup elsewhere on the page keeps its declaration, however
  // far from the deleted node it is.
  {
    const model = {
      extraFrontmatter: 'const jobs = [1];\nconst other = 2;',
      nodes: [
        { kind: 'element', name: 'div', children: [
          { kind: 'element', name: 'p', props: { 'data-x': { type: 'expr', value: 'other' } } },
        ] },
      ],
    };
    const dead = unusedDeclarations(model).map((d) => d.name);
    check('a name read deep in the tree is not dead', !dead.includes('other'), dead.join());
    check('and one nothing reads is', dead.join() === 'jobs', dead.join());
  }

  // The cost of being wrong is the page, so anything unreadable is left alone.
  {
    const model = {
      extraFrontmatter: 'const { href = "/" } = Astro.props;\nconst used = 1;',
      nodes: [],
    };
    const dead = unusedDeclarations(model).map((d) => d.name);
    check('a destructure is not something this takes out', !dead.includes('href'), dead.join());
  }

  // --- and what has to come with it -------------------------------------------------
  {
    const nodes = [
      {
        kind: 'component',
        name: 'Card',
        props: { options: { type: 'expr', value: 'jobs' }, src: { type: 'expr', value: 'hero' } },
        children: [{ kind: 'expr', value: '{label}' }],
      },
    ];
    const carried = neededFrontmatter({
      names: namesUsedIn(nodes),
      frontmatter: FRONTMATTER,
      imports: [
        { name: 'Card', path: '@/components/Card.astro' },
        { name: 'hero', path: '../assets/hero.png' },
      ],
      has: () => false,
    });
    const imported = carried.imports.map((i) => `${i.name}=${i.path}`).sort();
    const statements = carried.statements.map((s) => s.name);
    check('an import the markup reads comes across', imported.includes('hero=../assets/hero.png'), imported.join());
    check('and so does the component’s own', imported.includes('Card=@/components/Card.astro'), imported.join());
    check('a const it reads comes across', statements.includes('jobs'), statements.join());
    check('and one that const reads in turn', statements.includes('label') && statements.includes('year'), statements.join());
    check(
      'in the order the file had them',
      statements.indexOf('jobs') < statements.indexOf('year') && statements.indexOf('year') < statements.indexOf('label'),
      statements.join()
    );
    check('nothing it does not read', !statements.includes('posts'), statements.join());
  }

  // What the page already has is the page's own. A `jobs` here is not the
  // `jobs` there, and overwriting it would change something nobody asked about.
  {
    const carried = neededFrontmatter({
      names: new Set(['jobs', 'label']),
      frontmatter: FRONTMATTER,
      imports: [],
      has: (n) => n === 'jobs',
    });
    check('a name the page already knows is left alone', !carried.statements.some((s) => s.name === 'jobs'), JSON.stringify(carried.statements));
    check('and the rest still comes', carried.statements.some((s) => s.name === 'label'), JSON.stringify(carried.statements));
  }

  {
    const before = 'const a = 1;';
    const after = withStatements(before, [{ name: 'b', statement: 'const b = 2;' }]);
    check('what arrives goes after what was there', after === 'const a = 1;\nconst b = 2;', JSON.stringify(after));
    check('into an empty frontmatter too', withStatements('', [{ statement: 'const b = 2;' }]) === 'const b = 2;');
    check('and nothing arriving changes nothing', withStatements(before, []) === before);
  }

  // --- the app asks for both ----------------------------------------------------------
  const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'App.jsx'), 'utf8');
  check('deleting prunes what it made dead', /const dead = unusedDeclarations\(model\);/.test(app), 'nothing prunes declarations');
  check('and says which lines went', /from the frontmatter/.test(app), 'the deletion is silent about it');
  check('copying takes the page’s code with it', /frontmatter: state\.model\.extraFrontmatter/.test(app), 'the clipboard holds markup only');
  check('pasting brings what the markup reads', /neededFrontmatter\(\{/.test(app), 'the paste carries nothing');
  check(
    'and rewrites a relative import for where it landed',
    /rebaseImport\(\{/.test(app),
    'a relative path would point at nothing from another folder'
  );

  if (failures.length) {
    console.error(`\nfrontmatter-move: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`frontmatter-move: ${checked} passed  [the code behind the markup]`);
})();
