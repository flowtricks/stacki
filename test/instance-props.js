// What a component is being given, where it is being edited.
//
//   node test/instance-props.js
//
// Open a component from the canvas and you are looking at ONE of it, rendering
// one card. The panel knew its props by name and by type — `heading string`,
// `href string` — because that is all `interface Props` can say. So a field
// showing `{heading}` could not tell you what heading was, and the picker
// offered a list of identifiers against a card that plainly read "BloomCraft".
//
// The instance is where the answer is. `<LinkCard heading={project.data.title}
// href={`/portfolio/${project.id}`} variant="cover" />` says what each prop is
// given, and the page's own scope says what those expressions come to.
//
// The rule that matters most here is what it does NOT answer. A value shown in
// a panel reads as fact, so anything this can't work out is left out rather
// than guessed at.

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
  const out = path.join(buildDir, 'instance-props.bundle.js');
  await esbuild.build({
    stdin: {
      contents: [
        "export { resolveInstanceProps } from './src/instanceProps.js'",
        "export { dataTree } from './src/dataSuggest.js'",
      ].join('\n'),
      resolveDir: path.join(__dirname, '..'),
      loader: 'js',
    },
    outfile: out,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    logLevel: 'silent',
  });
  const { resolveInstanceProps, dataTree } = require(out);

  // A page that reads a collection and loops over it — the shape every card
  // grid in every project has.
  const ENTRY = {
    id: 'bloomcraft',
    collection: 'portfolio',
    data: { title: 'BloomCraft', image: '/hero.webp', order: 1, featured: true },
  };
  const PAGE = {
    frontmatter: 'const projects = await getCollection("portfolio");\nconst SITE = "Remarkable";',
    imports: [],
    ancestorHeads: ['projects.map((project) => ('],
    collectionSamples: { portfolio: ENTRY },
  };
  const instance = (props) => ({ kind: 'component', name: 'LinkCard', props });
  const expr = (value) => ({ type: 'expr', value });
  const text = (value) => ({ type: 'string', value });
  const got = (props, ctx = PAGE) => resolveInstanceProps(instance(props), ctx);

  // ── What it can answer ────────────────────────────────────────────────────
  check(
    'a path into the data resolves to the data',
    got({ heading: expr('project.data.title') })?.heading === 'BloomCraft',
    JSON.stringify(got({ heading: expr('project.data.title') }))
  );
  check(
    'a template literal comes out as the string it builds',
    got({ href: expr('`/portfolio/${project.id}`') })?.href === '/portfolio/bloomcraft',
    JSON.stringify(got({ href: expr('`/portfolio/${project.id}`') }))
  );
  check('a written string is its own answer', got({ variant: text('cover') })?.variant === 'cover');
  check('an attribute with no value means true', got({ render: { type: 'bare' } })?.render === true);
  check('a number stays a number', got({ cols: expr('3') })?.cols === 3, JSON.stringify(got({ cols: expr('3') })));
  check('and a boolean a boolean', got({ overlap: expr('true') })?.overlap === true);
  check(
    'a value reached the careful way is the same value',
    got({ heading: expr('project?.data.title') })?.heading === 'BloomCraft',
    JSON.stringify(got({ heading: expr('project?.data.title') }))
  );
  check(
    'a frontmatter constant resolves too',
    got({ site: expr('SITE') })?.site === 'Remarkable',
    JSON.stringify(got({ site: expr('SITE') }))
  );

  // ── What it refuses to answer ─────────────────────────────────────────────
  // A value in a panel reads as fact. Guessing one is worse than leaving it
  // to the type, which at least says it doesn't know.
  const unsure = (props, why) =>
    check(why, got(props) === null || !(Object.keys(props)[0] in (got(props) || {})), JSON.stringify(got(props)));
  unsure({ meta: expr('formatDate(project.data.date)') }, 'a call is not worked out');
  unsure({ heading: expr('mystery.title') }, 'nor is a name the page never had');
  unsure({ href: expr('`/x/${mystery.id}`') }, 'one unknown piece leaves the whole string unsaid');
  unsure({ tag: expr('null') }, 'and null says nothing at all');
  check(
    'a spread contributes nothing rather than everything',
    got({ '...rest': expr('card') }) === null || !('...rest' in got({ '...rest': expr('card') })),
    JSON.stringify(got({ '...rest': expr('card') }))
  );
  check(
    'an instance with nothing knowable answers null, not an empty object',
    got({ meta: expr('helper()') }) === null,
    JSON.stringify(got({ meta: expr('helper()') }))
  );
  check('and so does a node with no props at all', resolveInstanceProps({ kind: 'component' }, PAGE) === null);
  // Classes belong to the style panel, not the data picker.
  check('the class attribute is left alone', got({ class: text('card') }) === null, JSON.stringify(got({ class: text('card') })));

  // ── What the picker does with it ──────────────────────────────────────────
  // The whole point: the same rows, with values in them.
  const SCHEMA = [
    { name: 'heading', type: 'string', optional: false },
    { name: 'href', type: 'string', optional: true },
    { name: 'variant', type: 'enum', optional: true, default: 'cover' },
    { name: 'meta', type: 'string', optional: true },
  ];
  const rows = (sample) =>
    Object.fromEntries(
      dataTree({ frontmatter: '', imports: [], propsSample: sample, propsSchema: SCHEMA }).map((n) => [
        n.path,
        n.preview || n.kind,
      ])
    );
  const before = rows(null);
  const after = rows(got({ heading: expr('project.data.title'), href: expr('`/portfolio/${project.id}`') }));
  check('without an instance the props say what they are', before.heading === 'string', JSON.stringify(before));
  check('with one they say what they hold', after.heading === '"BloomCraft"', JSON.stringify(after));
  check('every one of them it could work out', after.href === '"/portfolio/bloomcraft"', JSON.stringify(after));
  check(
    'and the ones it could not still say what they are',
    after.meta === 'string',
    JSON.stringify(after)
  );

  // ── Against the real project ──────────────────────────────────────────────
  // The file this was written for, if it's on this machine.
  const REAL = '/Users/timothyricks/Documents/Projects/remarkable-agency/src/pages/index.astro';
  if (fs.existsSync(REAL)) {
    const { parsePage } = require(path.join(__dirname, '..', 'electron', 'astroParser.js'));
    const page = parsePage(fs.readFileSync(REAL, 'utf8'));
    const found = [];
    const walk = (list, chain) => {
      for (const n of list) {
        if (n.kind === 'component' && n.name === 'LinkCard') found.push({ n, chain });
        if (Array.isArray(n.children)) walk(n.children, [...chain, n]);
      }
    };
    walk(page.model.nodes, []);
    const resolved = found.map(({ n, chain }) =>
      resolveInstanceProps(n, {
        frontmatter: page.model.extraFrontmatter || '',
        imports: page.model.imports || [],
        ancestorHeads: chain.filter((c) => c.kind === 'map').map((c) => c.head),
        collectionSamples: { portfolio: ENTRY },
      })
    );
    check('the real page has cards to read', found.length > 0, `${found.length}`);
    check(
      'and the one in the loop knows its heading and its link',
      resolved.some((r) => r?.heading === 'BloomCraft' && r?.href === '/portfolio/bloomcraft'),
      JSON.stringify(resolved)
    );
  }

  if (failures.length) {
    console.error(`\ninstance-props: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`instance-props: ${checked} passed  [resolved, refused, offered]`);
})();
