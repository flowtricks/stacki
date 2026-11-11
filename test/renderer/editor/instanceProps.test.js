// What a component is being given, where it is being edited.
//
//   node test/renderer/editor/instanceProps.test.js
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

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { LIMITS } = require('#dist/shared/core/limits.js');
const { ROOT, repoPath } = require('../../helpers/sources.js');

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
  const out = path.join(buildDirectory, 'instance-props.bundle.js');
  await esbuild.build({
    stdin: {
      contents: ["export { resolveInstanceProps } from './src/editor/instanceProps.ts'", "export { dataTree } from './src/editor/dataSuggest.ts'"].join('\n'),
      resolveDir: ROOT,
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
  const got = (props, context = PAGE) => resolveInstanceProps(instance(props), context);

  // ── What it can answer ────────────────────────────────────────────────────
  check(
    'a path into the data resolves to the data',
    got({ heading: expr('project.data.title') })?.heading === 'BloomCraft',
    JSON.stringify(got({ heading: expr('project.data.title') })),
  );
  check(
    'a template literal comes out as the string it builds',
    got({ href: expr('`/portfolio/${project.id}`') })?.href === '/portfolio/bloomcraft',
    JSON.stringify(got({ href: expr('`/portfolio/${project.id}`') })),
  );
  check('a written string is its own answer', got({ variant: text('cover') })?.variant === 'cover');
  check('an attribute with no value means true', got({ render: { type: 'bare' } })?.render === true);
  check('a number stays a number', got({ cols: expr('3') })?.cols === 3, JSON.stringify(got({ cols: expr('3') })));
  check('and a boolean a boolean', got({ overlap: expr('true') })?.overlap === true);
  check(
    'a value reached the careful way is the same value',
    got({ heading: expr('project?.data.title') })?.heading === 'BloomCraft',
    JSON.stringify(got({ heading: expr('project?.data.title') })),
  );
  check('a frontmatter constant resolves too', got({ site: expr('SITE') })?.site === 'Remarkable', JSON.stringify(got({ site: expr('SITE') })));

  // ── What it refuses to answer ─────────────────────────────────────────────
  // A value in a panel reads as fact. Guessing one is worse than leaving it
  // to the type, which at least says it doesn't know.
  const unsure = (props, why) => check(why, got(props) === undefined || !(Object.keys(props)[0] in (got(props) || {})), JSON.stringify(got(props)));
  unsure({ meta: expr('formatDate(project.data.date)') }, 'a call is not worked out');
  unsure({ heading: expr('mystery.title') }, 'nor is a name the page never had');
  unsure({ href: expr('`/x/${mystery.id}`') }, 'one unknown piece leaves the whole string unsaid');
  unsure({ tag: expr('null') }, 'and null says nothing at all');
  check(
    'a spread contributes nothing rather than everything',
    got({ '...rest': expr('card') }) === undefined || !('...rest' in got({ '...rest': expr('card') })),
    JSON.stringify(got({ '...rest': expr('card') })),
  );
  check(
    'an instance with nothing knowable answers undefined, not an empty object',
    got({ meta: expr('helper()') }) === undefined,
    JSON.stringify(got({ meta: expr('helper()') })),
  );
  check('and so does a node with no props at all', resolveInstanceProps({ kind: 'component' }, PAGE) === undefined);
  // A component reads `class` as a prop (`{ class: className }`), so its value is answered;
  // a `class:list` directive is Astro's to combine, and is left out.
  check('the class attribute is answered', got({ class: text('card') })?.class === 'card', JSON.stringify(got({ class: text('card') })));
  check('a class:list directive is left alone', got({ 'class:list': expr('["a", b]') }) === undefined, JSON.stringify(got({ 'class:list': expr('["a", b]') })));

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
      dataTree({ frontmatter: '', imports: [], propsSample: sample, propsSchema: SCHEMA }).map((node) => [node.path, node.preview || node.kind]),
    );
  const before = rows(undefined);
  const after = rows(got({ heading: expr('project.data.title'), href: expr('`/portfolio/${project.id}`') }));
  check('without an instance the props say what they are', before.heading === 'string', JSON.stringify(before));
  check('with one they say what they hold', after.heading === '"BloomCraft"', JSON.stringify(after));
  check('every one of them it could work out', after.href === '"/portfolio/bloomcraft"', JSON.stringify(after));
  check('and the ones it could not still say what they are', after.meta === 'string', JSON.stringify(after));

  // ── Against the real project ──────────────────────────────────────────────
  // The file this was written for, if it's on this machine.
  const REAL = '/Users/timothyricks/Documents/Projects/remarkable-agency/src/pages/index.astro';
  if (fs.existsSync(REAL)) {
    const { parsePage } = require(repoPath('dist/electron/parse/astroParser.js'));
    const page = parsePage(fs.readFileSync(REAL, 'utf8'));
    const found = [];
    const walk = (list, chain) => {
      const depth = chain.length;
      assert.ok(depth <= LIMITS.treeDepthMax, 'walk: tree depth limit');
      for (const node of list) {
        if (node.kind === 'component' && node.name === 'LinkCard') {
          found.push({ n: node, chain });
        }
        if (Array.isArray(node.children)) {
          walk(node.children, [...chain, node]);
        }
      }
    };
    walk(page.model.nodes, []);
    const resolved = found.map(({ n: node, chain }) =>
      resolveInstanceProps(node, {
        frontmatter: page.model.extraFrontmatter || '',
        imports: page.model.imports || [],
        ancestorHeads: chain.filter((link) => link.kind === 'map').map((link) => link.head),
        collectionSamples: { portfolio: ENTRY },
      }),
    );
    check('the real page has cards to read', found.length > 0, `${found.length}`);
    check(
      'and the one in the loop knows its heading and its link',
      resolved.some((result) => result?.heading === 'BloomCraft' && result?.href === '/portfolio/bloomcraft'),
      JSON.stringify(resolved),
    );
  }

  if (failures.length) {
    console.error(`\ninstance-props: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`instance-props: ${checked} passed  [resolved, refused, offered]`);
})();
