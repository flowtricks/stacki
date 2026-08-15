// What a save must not do to a file.
//
//   node test/content-entries.js [projectDir]
//
// Editing one field means rewriting a file that holds a lot more than that
// field: other entries, comments, formatting choices, a body of markdown, four
// other records on four other lines. Every check here is one of those things
// coming back unchanged — because the failure mode of a visual editor is not a
// crash, it is a commit nobody can review.
//
// The project is never written to: its src/ tree is copied to a temporary
// directory first, and the copy is what gets edited.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { readContentConfig, stopAllServices } = require('../electron/contentConfig.js');
const { listEntries, writeEntry } = require('../electron/contentEntries.js');
const formats = {
  json: require('../electron/formats/json.js'),
  yaml: require('../electron/formats/yaml.js'),
  toml: require('../electron/formats/toml.js'),
  csv: require('../electron/formats/csv.js'),
  ndjson: require('../electron/formats/ndjson.js'),
  frontmatter: require('../electron/formats/frontmatter.js'),
};

const DEFAULT_FIXTURE = path.join(os.homedir(), 'Downloads', 'awesome-client-main');
const source = path.resolve(process.argv[2] || process.env.STACKI_CONTENT_FIXTURE || DEFAULT_FIXTURE);

const failures = [];
let checked = 0;

function check(what, condition, detail) {
  checked++;
  if (condition) return;
  failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
}

// Added plus removed lines, the way a diff counts them.
function changedLines(a, b) {
  const A = a.split('\n');
  const B = b.split('\n');
  const n = A.length;
  const m = B.length;
  const t = new Int32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      t[i * (m + 1) + j] =
        A[i] === B[j]
          ? t[(i + 1) * (m + 1) + j + 1] + 1
          : Math.max(t[(i + 1) * (m + 1) + j], t[i * (m + 1) + j + 1]);
    }
  }
  return n - t[0] + (m - t[0]);
}

const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');

(async () => {
  if (!fs.existsSync(path.join(source, 'src', 'content.config.ts'))) {
    console.log(`content-entries: skipped (no project at ${source})`);
    return;
  }
  const config = await readContentConfig(source, { force: true });
  if (config.error) {
    console.error(`content-entries: could not read the config — ${config.error}`);
    process.exit(1);
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-content-'));
  fs.cpSync(path.join(source, 'src'), path.join(root, 'src'), { recursive: true });
  const by = Object.fromEntries(config.collections.map((c) => [c.name, c]));
  const entriesOf = (name) => listEntries(root, by[name]);

  // An edit to one entry, and what the file looked like before and after.
  const edit = (name, pick, edits, options) => {
    const listed = entriesOf(name);
    const entry = typeof pick === 'function' ? listed.entries.find(pick) : listed.entries[pick];
    if (!entry) throw new Error(`${name}: no entry to edit`);
    const before = read(root, entry.file);
    writeEntry(root, entry, edits, options);
    return { entry, before, after: read(root, entry.file), listed };
  };

  // --- every editable collection survives an edit and still parses ----------
  for (const collection of config.collections) {
    const listed = entriesOf(collection.name);
    if (listed.readOnly) {
      check(`${collection.name}: read-only`, listed.entries.length === 0);
      check(`${collection.name}: says why`, typeof listed.reason === 'string' && listed.reason.length > 20);
      continue;
    }
    check(`${collection.name}: has entries`, listed.entries.length > 0);
    check(
      `${collection.name}: every entry has an id and a file`,
      listed.entries.every((e) => e.id && e.file)
    );
  }

  // --- the acceptance cases -------------------------------------------------

  // One field on one markdown post: one line, and the body is untouched.
  {
    const { entry, before, after } = edit('blog', (e) => e.id === 'schema-design-for-editors', [
      { path: ['title'], value: 'Schema design for editors, revised' },
    ]);
    check('blog: a one-field edit is a one-line diff', changedLines(before, after) === 2, `${changedLines(before, after)} lines`);
    check(
      'blog: the body is byte-identical',
      formats.frontmatter.parse(before).body === formats.frontmatter.parse(after).body
    );
    check('blog: the value changed', formats.frontmatter.parse(after).data.title.endsWith('revised'));
    check(
      'blog: no defaults were written',
      !/^draft:/m.test(formats.frontmatter.parse(after).frontmatter) ||
        /^draft:/m.test(formats.frontmatter.parse(before).frontmatter),
      'a key that was not in the file appeared in it'
    );
    check('blog: id unchanged by a field edit', entry.id === 'schema-design-for-editors');
  }

  // An MDX body holds imports and JSX. Nothing may touch it.
  {
    const { before, after } = edit('caseStudies', 0, [{ path: ['client'], value: 'atlas' }]);
    check(
      'caseStudies: the MDX body survives',
      formats.frontmatter.parse(before).body === formats.frontmatter.parse(after).body
    );
  }

  // Deleting a field removes it and nothing else.
  {
    const listed = entriesOf('blog');
    const entry = listed.entries.find((e) => e.data.readingTime !== undefined);
    const before = read(root, entry.file);
    writeEntry(root, entry, [{ path: ['readingTime'], value: undefined }]);
    const after = read(root, entry.file);
    check('blog: deleting a field is a one-line diff', changedLines(before, after) === 1, `${changedLines(before, after)} lines`);
    check('blog: the field is gone', formats.frontmatter.parseData(after).readingTime === undefined);
    check('blog: its neighbours are not', formats.frontmatter.parseData(after).title !== undefined);
  }

  // A JSON array of records: one record edited, the file otherwise identical.
  {
    const { before, after } = edit('authors', (e) => e.id === 'toshi-nakamura', [
      { path: ['role'], value: 'Principal Developer Advocate' },
    ]);
    check('authors: one line', changedLines(before, after) === 2, `${changedLines(before, after)} lines`);
    check('authors: still valid JSON', formats.json.parseData(after)[2].role.startsWith('Principal'));
  }

  // A JSON object keyed by id, with a $schema key Astro ignores and an editor
  // must not eat.
  {
    const { before, after } = edit('clients', (e) => e.id === 'helios', [
      { path: ['employees'], value: 1200 },
    ]);
    check('clients: one line', changedLines(before, after) === 2, `${changedLines(before, after)} lines`);
    const data = formats.json.parseData(after);
    check('clients: keyed record patched in place', data.helios.employees === 1200);
    check('clients: sibling records untouched', JSON.stringify(data.northwind) === JSON.stringify(formats.json.parseData(before).northwind));
    check('clients: $schema kept', before.includes('$schema') === after.includes('$schema'));
  }

  // Nested objects inside a keyed record.
  {
    const { after } = edit('products', (e) => e.id === 'beacon', [
      { path: ['pricing', 'currency'], value: 'EUR' },
    ]);
    check('products: nested field patched', formats.json.parseData(after).beacon.pricing.currency === 'EUR');
  }

  // YAML with comments and block scalars.
  {
    const { before, after } = edit('team', 0, [{ path: ['title'], value: 'Head of Everything' }]);
    check('team: one line', changedLines(before, after) === 2, `${changedLines(before, after)} lines`);
    check(
      'team: comments survive',
      (before.match(/^\s*#/gm) || []).length === (after.match(/^\s*#/gm) || []).length
    );
  }

  // The grouped YAML: the record is nested two levels down inside its category,
  // and has to be patched where it sits.
  {
    const { entry, before, after } = edit('faqs', (e) => e.id === 'billing-refunds', [
      { path: ['popularity'], value: 71 },
    ]);
    check('faqs: patched in place', changedLines(before, after) === 2, `${changedLines(before, after)} lines`);
    check('faqs: found inside its category', entry.locator.join('.') === 'categories.0.questions.1');
    const data = formats.yaml.parseData(after);
    check('faqs: the right question changed', data.categories[0].questions[1].popularity === 71);
    check('faqs: block scalars survive', (before.match(/: [|>]/g) || []).length === (after.match(/: [|>]/g) || []).length);
    check('faqs: the parser is declared', entriesOf('faqs').parsed === true);
  }

  // A value that would break the file if it were written unquoted.
  {
    const { after } = edit('faqs', (e) => e.id === 'billing-cycle', [
      { path: ['question'], value: 'What happens when draft: true?' },
    ]);
    check('faqs: a colon in a value is quoted', !!formats.yaml.parseData(after), 'the file no longer parses');
    check(
      'faqs: and the value is intact',
      formats.yaml.parseData(after).categories[0].questions[0].question === 'What happens when draft: true?'
    );
  }

  // CSV: strings on disk, column order and quoting preserved.
  {
    const { before, after } = edit('testimonials', (e) => e.id === 'tst-002', [
      { path: ['featured'], value: 'false' },
    ]);
    check('testimonials: one row', changedLines(before, after) === 2, `${changedLines(before, after)} lines`);
    check('testimonials: header untouched', before.split('\n')[0] === after.split('\n')[0]);
    check(
      'testimonials: comment lines kept',
      (before.match(/^#/gm) || []).length === (after.match(/^#/gm) || []).length
    );
    const rows = formats.csv.parseData(after);
    check('testimonials: the value is a string', rows[1].featured === 'false');
    check(
      'testimonials: quoted cells stay quoted',
      (before.match(/"/g) || []).length === (after.match(/"/g) || []).length
    );
  }

  // NDJSON: every other line byte-identical.
  {
    const { before, after } = edit('jobs', (e) => e.id === 'design-systems-2026', [
      { path: ['open'], value: false },
    ]);
    const a = before.split('\n');
    const b = after.split('\n');
    check('jobs: same number of lines', a.length === b.length);
    check('jobs: exactly one line differs', a.filter((line, i) => line !== b[i]).length === 1);
    check('jobs: the record is on one line', b[1].startsWith('{') && b[1].endsWith('}'));
    check('jobs: the value changed', formats.ndjson.parseData(after)[1].open === false);
  }

  // TOML: inline tables stay inline, sub-tables stay sub-tables.
  {
    const { before, after } = edit('pricingPlans', (e) => e.id === 'team', [
      { path: ['limits', 'projects'], value: 25 },
    ]);
    check('pricingPlans: one line', changedLines(before, after) === 2, `${changedLines(before, after)} lines`);
    check('pricingPlans: the inline table is still inline', /limits = \{ projects = 25,/.test(after));
    check('pricingPlans: sub-tables kept', after.includes('[team.addOns.extraSeats]'));
    check('pricingPlans: the file comment kept', after.startsWith('#'));
    check('pricingPlans: value parsed back', formats.toml.parseData(after).team.limits.projects === 25);
  }

  // A landing page is JSON with a block union in it.
  {
    const listed = entriesOf('landingPages');
    const entry = listed.entries.find((e) => e.id === 'home');
    const before = read(root, entry.file);
    const blocks = entry.data.blocks;
    writeEntry(root, entry, [{ path: ['blocks'], value: [blocks[1], blocks[0], ...blocks.slice(2)] }]);
    const after = read(root, entry.file);
    const data = formats.json.parseData(after);
    check('landingPages: blocks reordered', data.blocks[0].type === blocks[1].type && data.blocks[1].type === blocks[0].type);
    check('landingPages: nothing else moved', data.title === entry.data.title && data.blocks.length === blocks.length);
    check('landingPages: still one file', changedLines(before, after) > 0);
  }

  // A collection with no schema at all: unknown keys are just data.
  {
    const { after } = edit('legal', (e) => e.id === 'privacy', [{ path: ['title'], value: 'Privacy notice' }]);
    const data = formats.frontmatter.parseData(after);
    check('legal: edited without a schema', data.title === 'Privacy notice');
    check('legal: its other keys survive', Object.keys(data).length > 1);
  }

  // looseObject: a field nobody declared has to still be there afterwards.
  {
    const listed = entriesOf('notes');
    const entry = listed.entries.find((e) => e.data.customFieldNobodyPlanned !== undefined);
    check('notes: the undeclared field is visible', !!entry);
    if (entry) {
      const before = read(root, entry.file);
      writeEntry(root, entry, [{ path: ['title'], value: 'Editor retro, revised' }]);
      const after = read(root, entry.file);
      check(
        'notes: the undeclared field survives a save',
        formats.frontmatter.parseData(after).customFieldNobodyPlanned !== undefined
      );
      check('notes: one line', changedLines(before, after) === 2, `${changedLines(before, after)} lines`);
    }
  }

  // Ids: what they come from, and what changes them.
  {
    const changelog = entriesOf('changelog');
    check('changelog: ids are flagged as guesses', changelog.idsAreGuesses === true);
    check('changelog: and it says why', typeof changelog.idNote === 'string');
    const blog = entriesOf('blog');
    check('blog: ids carry folders', blog.entries.some((e) => e.id.includes('/')));
    const docs = entriesOf('docs');
    check('docs: nested ids', docs.entries.some((e) => e.id === 'collections/loaders'));
  }

  fs.rmSync(root, { recursive: true, force: true });

  if (failures.length) {
    console.error(`\ncontent-entries: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    stopAllServices();
    process.exit(1);
  }
  console.log(`content-entries: ${checked} passed  [${path.basename(source)}]`);
  stopAllServices();
})();
