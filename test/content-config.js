// What the content-config reader has to get right, checked against a real
// Astro project.
//
//   node test/content-config.js [projectDir]
//   STACKI_CONTENT_FIXTURE=/path/to/project node test/content-config.js
//
// The reader loads src/content.config.ts with astro:content and astro/loaders
// stubbed, and reports what each collection is (see electron/contentConfig.js).
// Everything asserted here is something an editor gets wrong if the reader is
// wrong, and wrong in a way that damages a repo rather than just looking odd:
//
//   loader kind    a custom loader's entries are regenerated on every sync, so
//                  a save button over one writes to a file the next sync
//                  overwrites. Read-only is not a nicety.
//   ids            a glob collection with generateId takes its id from a
//                  field, so the field that looks like data is the thing that
//                  renames the entry and breaks every reference to it.
//   references     a ref field holds a string in the file and an object after
//                  parsing. Writing the parsed shape back corrupts the file.
//   dates          a coerced date has no input type at all in JSON Schema, so
//                  without the marker a date field reads as "anything".
//   transforms     testimonials.featured is the string "true" on disk and a
//                  boolean in the entry. Same trap, one level nastier.
//   unions         a discriminated union is a type switcher, not an object.
//   recursion      z.lazy() must come back as a $ref rather than blowing up.
//   loose objects  a field nobody declared still has to survive a save.
//
// No fixture is checked in: the reader needs a project with its dependencies
// installed, because it runs the project's own esbuild and zod. Point it at
// one, or it skips.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { readContentConfig, stopAllServices } = require('../electron/contentConfig.js');

const DEFAULT_FIXTURE = path.join(os.homedir(), 'Downloads', 'awesome-client-main');
const projectPath = path.resolve(
  process.argv[2] || process.env.STACKI_CONTENT_FIXTURE || DEFAULT_FIXTURE
);

const failures = [];
let checked = 0;

function check(what, condition, detail) {
  checked++;
  if (condition) return;
  failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
}

// The property at a dotted path, following arrays and $defs, so an assertion
// can name a field the way the schema does.
function propAt(schema, dotted) {
  let node = schema;
  for (const key of dotted.split('.')) {
    if (!node) return null;
    if (node.$ref) node = defOf(schema, node.$ref);
    if (node.type === 'array') node = node.items;
    node = node?.properties?.[key];
  }
  return node || null;
}

const defOf = (root, ref) => root?.$defs?.[String(ref).split('/').pop()] || null;

(async () => {
  if (!fs.existsSync(path.join(projectPath, 'src', 'content.config.ts'))) {
    console.log(`content-config: skipped (no project at ${projectPath})`);
    return;
  }

  const result = await readContentConfig(projectPath, { force: true });
  if (result.error) {
    console.error(`content-config: could not read the config — ${result.error}`);
    process.exit(1);
  }

  const by = Object.fromEntries(result.collections.map((c) => [c.name, c]));
  const has = (name) => {
    const c = by[name];
    if (!c) failures.push(`  ${name}: not in the manifest`);
    return c;
  };

  // Loader kinds decide what is editable at all.
  for (const name of ['blog', 'docs', 'landingPages', 'apiEndpoints']) {
    const c = has(name);
    check(`${name}: glob loader`, c?.loader?.kind === 'glob', `got ${c?.loader?.kind}`);
    check(`${name}: editable`, c?.editable === true);
  }
  for (const name of ['authors', 'pricingPlans', 'testimonials', 'jobs']) {
    const c = has(name);
    check(`${name}: file loader`, c?.loader?.kind === 'file', `got ${c?.loader?.kind}`);
    check(`${name}: names its file`, !!c?.loader?.file);
  }
  for (const name of ['events', 'releases', 'iconLibrary', 'announcements', 'buildInfo']) {
    const c = has(name);
    check(`${name}: custom loader`, c?.loader?.kind === 'custom', `got ${c?.loader?.kind}`);
    check(`${name}: read-only`, c?.editable === false);
  }

  // A parser reshapes the file, so the entry is not the record on disk.
  check('faqs: parser flagged', by.faqs?.loader?.parser === true);
  check('testimonials: parser flagged', by.testimonials?.loader?.parser === true);
  check('authors: no parser', by.authors?.loader?.parser === false);

  // Bodies exist for markdown-ish globs and nothing else.
  check('blog: has a body (brace pattern)', by.blog?.hasBody === true);
  check('tutorials: has a body (.mdoc)', by.tutorials?.hasBody === true);
  check('landingPages: no body (.json glob)', by.landingPages?.hasBody === false);
  check('authors: no body (file loader)', by.authors?.hasBody === false);

  // generateId means the id comes from the entry, not the path.
  check('blog: id from the file path', by.blog?.idFromFile === true);
  check('changelog: id is generated', by.changelog?.idFromFile === false);
  check('localized: id is generated', by.localized?.idFromFile === false);

  // No schema at all: every key is the user's.
  check('legal: freeform', by.legal?.freeform === true && by.legal?.schema === null);

  // Cross-field rules, which no single field can enforce.
  check('recipes: cross-field checks', by.recipes?.crossFieldChecks === true);
  check('jobs: cross-field checks', by.jobs?.crossFieldChecks === true);
  check('blog: no cross-field checks', by.blog?.crossFieldChecks === false);

  const blog = by.blog?.schema;
  check('blog.title: length bounds', propAt(blog, 'title')?.minLength === 3 && propAt(blog, 'title')?.maxLength === 120);
  check('blog.author: reference to authors', propAt(blog, 'author')?.astroReference === 'authors');
  check(
    'blog.contributors: array of references, default []',
    propAt(blog, 'contributors')?.items?.astroReference === 'authors' &&
      Array.isArray(propAt(blog, 'contributors')?.default)
  );
  check('blog.heroImage: image', propAt(blog, 'heroImage')?.astroImage === true);
  check('blog.pubDate: date', propAt(blog, 'pubDate')?.astroDate === true);
  check('blog.pubDate: required', (blog?.required || []).includes('pubDate'));
  check('blog.heroImage: optional', !(blog?.required || []).includes('heroImage'));
  check('blog.draft: default false', propAt(blog, 'draft')?.default === false);
  check('blog.category: enum', (propAt(blog, 'category')?.enum || []).includes('engineering'));
  check('blog.tags: item bounds', propAt(blog, 'tags')?.minItems === 1 && propAt(blog, 'tags')?.maxItems === 8);
  check('blog.seo.ogImage: image, nested', propAt(blog, 'seo.ogImage')?.astroImage === true);

  // A value that is one thing on disk and another in the entry.
  const featured = propAt(by.testimonials?.schema, 'featured');
  check('testimonials.featured: transform flagged', featured?.astroTransform === true);
  check('testimonials.featured: string on disk', (featured?.enum || []).includes('true'));

  // Nullable is not optional: the key is required, the value may be null.
  const docsUrl = propAt(by.products?.schema, 'docsUrl');
  check(
    'products.docsUrl: nullable',
    (docsUrl?.anyOf || []).some((s) => s.type === 'null'),
    JSON.stringify(docsUrl)
  );

  // Discriminated unions, at entry level and inside an array.
  const settings = by.siteSettings?.schema;
  check('siteSettings: union of kinds', Array.isArray(settings?.oneOf) && settings.oneOf.length === 5);
  check(
    'siteSettings: discriminator is a literal',
    settings?.oneOf?.[0]?.properties?.kind?.const === 'brand'
  );
  const blocks = propAt(by.landingPages?.schema, 'blocks');
  check('landingPages.blocks: at least one', blocks?.minItems === 1);
  check('landingPages.blocks: block union', (blocks?.items?.oneOf || []).length === 12);
  check(
    'landingPages.blocks: a block can hold an image',
    (blocks?.items?.oneOf || []).some((b) =>
      Object.values(b.properties || {}).some((f) => f.astroImage === true)
    )
  );
  check(
    'landingPages.blocks: a block can hold a reference',
    (blocks?.items?.oneOf || []).some((b) =>
      Object.values(b.properties || {}).some(
        (f) => f.astroReference || f.items?.astroReference
      )
    )
  );

  // z.lazy(): the tree has to point at itself rather than unrolling forever.
  const nav = by.navigation?.schema;
  const items = nav?.properties?.items;
  check('navigation.items: recursive $ref', typeof items?.items?.$ref === 'string');
  const navItem = defOf(nav, items?.items?.$ref);
  check('navigation: item children recurse', navItem?.properties?.children?.items?.$ref === items?.items?.$ref);
  check(
    'navigation: a section header has no href',
    (navItem?.properties?.href?.anyOf || []).some((s) => s.type === 'null')
  );

  // looseObject: fields nobody declared still exist and must survive a save.
  check('notes: extra keys allowed', !!by.notes?.schema && by.notes.schema.additionalProperties !== false);

  // Patterns reach the UI as patterns, so a field can say what it wants.
  check('apiEndpoints.path: leading slash', propAt(by.apiEndpoints?.schema, 'path')?.pattern?.includes('^'));
  check('docs.version: pattern', typeof propAt(by.docs?.schema, 'version')?.pattern === 'string');

  const total = result.collections.length;
  if (failures.length) {
    console.error(`\ncontent-config: ${failures.length} failed, ${checked - failures.length} passed  [${total} collections]\n`);
    console.error(failures.join('\n') + '\n');
    stopAllServices();
    process.exit(1);
  }
  // Logged before the service is stopped: with nothing left holding the loop
  // open, node can exit before a piped stdout has flushed.
  console.log(`content-config: ${checked} passed  [${total} collections, ${path.basename(projectPath)}]`);
  stopAllServices();
})();
