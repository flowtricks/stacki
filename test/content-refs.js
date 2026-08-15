// Renaming an entry, and the pointers that have to move with it.
//
//   node test/content-refs.js [projectDir]
//
// An id is a value other files hold. Change it in one place and the project
// still builds — Astro hands a page `undefined` where the entry used to be, and
// the pages here filter those out defensively — so a half-done rename shows up
// as a post with no author rather than as an error. Everything below is a
// pointer that has to be found and rewritten, or a rule about where an id is
// written down in the first place.
//
// As with the other content tests, the project is copied before anything is
// written.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { readContentConfig, stopAllServices } = require('../electron/contentConfig.js');
const { listEntries } = require('../electron/contentEntries.js');
const { planRename, applyRename, rewriteRelative } = require('../electron/contentRefs.js');
const frontmatter = require('../electron/formats/frontmatter.js');
const jsonFormat = require('../electron/formats/json.js');

const DEFAULT_FIXTURE = path.join(os.homedir(), 'Downloads', 'awesome-client-main');
const source = path.resolve(process.argv[2] || process.env.STACKI_CONTENT_FIXTURE || DEFAULT_FIXTURE);

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};

(async () => {
  if (!fs.existsSync(path.join(source, 'src', 'content.config.ts'))) {
    console.log(`content-refs: skipped (no project at ${source})`);
    return;
  }
  const config = await readContentConfig(source, { force: true });
  if (config.error) {
    console.error(`content-refs: could not read the config — ${config.error}`);
    process.exit(1);
  }
  const collections = config.collections;
  const by = Object.fromEntries(collections.map((c) => [c.name, c]));

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-refs-'));
  fs.cpSync(path.join(source, 'src'), path.join(root, 'src'), { recursive: true });
  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  const entriesOf = (name) => listEntries(root, by[name]).entries;

  // --- an author, pointed at from several collections at once ---------------
  {
    const plan = planRename(root, collections, {
      collection: 'authors',
      from: 'avery-chen',
      to: 'avery-chen-jones',
    });
    check('authors: the id is a field in the data file', plan.move.kind === 'field');
    check('authors: pointers found', plan.pointers.length >= 5, `${plan.pointers.length} found`);
    check(
      'authors: across more than one collection',
      new Set(plan.pointers.map((p) => p.collection)).size >= 3,
      [...new Set(plan.pointers.map((p) => p.collection))].join(', ')
    );
    check(
      'authors: an array reference is found by position',
      plan.pointers.some((p) => p.path.length === 2 && p.path[0] === 'contributors')
    );

    const before = plan.pointers.map((p) => ({ ...p }));
    applyRename(root, plan);

    check(
      'authors: the entry itself is renamed',
      entriesOf('authors').some((e) => e.id === 'avery-chen-jones')
    );
    check('authors: and the old id is gone', !entriesOf('authors').some((e) => e.id === 'avery-chen'));
    let rewritten = 0;
    for (const pointer of before) {
      const data = frontmatter.parseData(read(pointer.file)) || jsonFormat.parseData(read(pointer.file));
      const value = pointer.path.reduce((node, key) => (node == null ? node : node[key]), data);
      if (value === 'avery-chen-jones') rewritten++;
    }
    check('authors: every pointer rewritten', rewritten === before.length, `${rewritten}/${before.length}`);
    check(
      'authors: nothing still points at the old id',
      !planRename(root, collections, { collection: 'authors', from: 'avery-chen-jones', to: 'x' }).pointers.some(
        (p) => p.value === 'avery-chen'
      )
    );
  }

  // --- a keyed record: the key is the id -------------------------------------
  {
    const plan = planRename(root, collections, { collection: 'clients', from: 'helios', to: 'helios-energy' });
    check('clients: the key is the id', plan.move.kind === 'key');
    const before = read('src/data/clients.json');
    applyRename(root, plan);
    const after = read('src/data/clients.json');
    const data = jsonFormat.parseData(after);
    check('clients: renamed in place', Object.keys(data)[1] === 'helios-energy', Object.keys(data).join(', '));
    check('clients: its record is untouched', JSON.stringify(data['helios-energy']) === JSON.stringify(jsonFormat.parseData(before).helios));
    check(
      'clients: one line changed',
      before.split('\n').filter((line, i) => line !== after.split('\n')[i]).length === 1
    );
  }

  // --- a file per entry: the path is the id ----------------------------------
  {
    const plan = planRename(root, collections, {
      collection: 'blog',
      from: 'schema-design-for-editors',
      to: 'designing-schemas-for-editors',
    });
    check('blog: the file is the id', plan.move.kind === 'file');
    check('blog: it moves to a matching filename', plan.move.to.endsWith('designing-schemas-for-editors.md'));
    applyRename(root, plan);
    check('blog: the file moved', fs.existsSync(path.join(root, plan.move.to)));
    check('blog: nothing left behind', !fs.existsSync(path.join(root, plan.move.from)));
    check(
      'blog: relatedPosts elsewhere follow it',
      !entriesOf('blog').some((e) => (e.data.relatedPosts || []).includes('schema-design-for-editors'))
    );
  }

  // --- moving between folders rewrites what images point at -------------------
  {
    const plan = planRename(root, collections, {
      collection: 'blog',
      from: '2025/the-cost-of-a-thousand-images',
      to: 'the-cost-of-a-thousand-images',
    });
    check('blog: a move is a rename with a different folder', plan.move.kind === 'file');
    check('blog: images are rewritten for the new depth', plan.imageEdits.length > 0, 'nothing to rewrite');
    check(
      'blog: one folder up means one ../ fewer',
      plan.imageEdits.every((edit) => edit.value.length < edit.from.length),
      JSON.stringify(plan.imageEdits)
    );
    applyRename(root, plan);
    const moved = entriesOf('blog').find((e) => e.id === 'the-cost-of-a-thousand-images');
    check('blog: the moved entry is where it says', !!moved);
    const target = path.resolve(root, path.dirname(moved.file), moved.data.heroImage || '');
    check('blog: and its image resolves to a real file', fs.existsSync(target), target);
  }

  // --- ids that no rename can change ------------------------------------------
  {
    const plan = planRename(root, collections, { collection: 'changelog', from: '2026-07-30', to: 'anything' });
    check('changelog: says the id is generated', plan.move.kind === 'generated');
    check('changelog: and explains why', typeof plan.move.note === 'string');
  }

  // --- a rename that would collide -------------------------------------------
  {
    let threw = null;
    try {
      planRename(root, collections, { collection: 'authors', from: 'toshi-nakamura', to: 'marisol-vega' });
    } catch (err) {
      threw = err.message;
    }
    check('a duplicate id is refused', !!threw && /already has/.test(threw), threw || 'no error');
  }

  // --- the relative-path arithmetic itself ------------------------------------
  check(
    'up one folder',
    rewriteRelative('../../../assets/images/x.png', 'src/content/blog/2025', 'src/content/blog') ===
      '../../assets/images/x.png'
  );
  check(
    'down two folders',
    rewriteRelative('../../assets/images/x.png', 'src/content/blog', 'src/content/blog/2026/spring') ===
      '../../../../assets/images/x.png'
  );

  fs.rmSync(root, { recursive: true, force: true });

  if (failures.length) {
    console.error(`\ncontent-refs: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    stopAllServices();
    process.exit(1);
  }
  console.log(`content-refs: ${checked} passed  [${path.basename(source)}]`);
  stopAllServices();
})();
