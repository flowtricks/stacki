// The form the editor draws, checked against content that is known to be good.
//
//   node test/renderer/content/contentFields.test.js [projectDir]
//
// src/features/content/contentSchema.ts turns a collection's JSON Schema into field
// descriptors — which control to draw, whether a value is required, what it is
// bounded by. The failure mode is quiet: a misread constraint shows the user an
// error on content that is perfectly valid, or a control that cannot express
// what the schema wants.
//
// So the check runs the real descriptors over the project's real entries. The
// project builds, so every entry is valid, so every field it holds must come
// back clean. Anything that does not is this file's reading of the schema being
// wrong, not the content.

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { LIMITS } = require('#dist/shared/core/limits.js');
const loadRenderer = require('../../helpers/rendererModule.js');
const { readContentConfig, stopAllServices, validateEntry } = require('#dist/electron/content/contentConfig.js');
const { listEntries } = require('#dist/electron/content/contentEntries.js');

const DEFAULT_FIXTURE = path.join(os.homedir(), 'Downloads', 'awesome-client-main');
const source = path.resolve(process.argv[2] || process.env.STACKI_CONTENT_FIXTURE || DEFAULT_FIXTURE);

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};

const isPlainObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

(async () => {
  if (!fs.existsSync(path.join(source, 'src', 'content.config.ts'))) {
    console.log(`content-fields: skipped (no project at ${source})`);
    return;
  }
  // The renderer's module, loaded the way the renderer loads it.
  const { collectionFields, describeField, fieldIssue, editsBetween, memberFor, hintFor } = loadRenderer('src/features/content/contentSchema.ts');

  const config = await readContentConfig(source, { force: true });
  if (config.error) {
    console.error(`content-fields: could not read the config — ${config.error}`);
    process.exit(1);
  }

  // Walks a value with the field that describes it, the way the form does.
  const walk = (field, value, at, depth, report) => {
    assert.ok(depth <= LIMITS.ipcDepthMax, 'walk: value depth limit');
    if (value === undefined || value === null) {
      return;
    }
    const issue = fieldIssue(field, value);
    if (issue) {
      report(`${at}: ${issue} (value ${JSON.stringify(value)?.slice(0, 60)})`);
    }
    if (field.control === 'object' && isPlainObject(value)) {
      for (const child of field.fields || []) {
        walk(child, value[child.key], `${at}.${child.key}`, depth + 1, report);
      }
    } else if (field.control === 'list' && Array.isArray(value)) {
      value.forEach((item, i) => walk(field.item || {}, item, `${at}[${i}]`, depth + 1, report));
    } else if (field.control === 'record' && isPlainObject(value)) {
      for (const [key, item] of Object.entries(value)) {
        walk(field.value || {}, item, `${at}.${key}`, depth + 1, report);
      }
    } else if (field.control === 'union' && isPlainObject(value)) {
      const member = memberFor(field, value);
      for (const child of member?.fields || []) {
        walk(child, value[child.key], `${at}.${child.key}`, depth + 1, report);
      }
    }
  };

  let fieldsSeen = 0;
  const controls = new Set();

  for (const collection of config.collections) {
    const listed = listEntries(source, collection);
    if (listed.readOnly) {
      continue;
    }
    const shape = collectionFields(collection.schema);

    if (collection.freeform) {
      check(`${collection.name}: freeform`, shape.freeform === true);
      continue;
    }

    const fields = shape.union ? shape.union.members.flatMap((member) => member.fields) : shape.fields;
    check(`${collection.name}: has fields`, fields.length > 0);
    for (const field of fields) {
      fieldsSeen++;
      controls.add(field.control);
      check(`${collection.name}.${field.key}: has a control`, field.control !== 'unknown', field.control);
      check(`${collection.name}.${field.key}: has a label`, !!field.label);
    }

    // Valid content must not light up the form.
    for (const entry of listed.entries) {
      const complaints = [];
      const report = (message) => complaints.push(message);
      if (shape.union) {
        const member = memberFor(shape.union, entry.data);
        for (const field of member?.fields || []) {
          walk(field, entry.data[field.key], `${field.key}`, 0, report);
        }
      } else {
        for (const field of shape.fields) {
          walk(field, entry.data[field.key], field.key, 0, report);
        }
      }
      check(`${collection.name}/${entry.id}: valid content reads as valid`, complaints.length === 0, complaints.slice(0, 3).join('\n    '));
    }
  }

  // Every control the form knows how to draw should be reachable; a schema
  // feature nobody can edit is worse than one nobody uses.
  for (const control of [
    'text',
    'longtext',
    'number',
    'boolean',
    'enum',
    'date',
    'image',
    'reference',
    'references',
    'tags',
    'object',
    'list',
    'union',
    'record',
    'url',
  ]) {
    check(`the ${control} control is used by this project`, controls.has(control), [...controls].join(', '));
  }

  // Editing nothing writes nothing. This is the rule that keeps a save from
  // filling every file with the schema's defaults.
  for (const collection of config.collections) {
    const listed = listEntries(source, collection);
    if (listed.readOnly || !listed.entries.length) {
      continue;
    }
    const entry = listed.entries[0];
    check(`${collection.name}: an untouched entry produces no edits`, editsBetween(entry.data, entry.data).length === 0);
    // And a copy of the same data is still no edits: the comparison is by
    // value, not by identity.
    check(`${collection.name}: a copy produces no edits either`, editsBetween(entry.data, JSON.parse(JSON.stringify(entry.data))).length === 0);
  }

  // The zod round trip agrees with the form: what the fixture holds parses.
  {
    const blog = config.collections.find((collection) => collection.name === 'blog');
    const entry = listEntries(source, blog).entries[0];
    const result = await validateEntry(source, { collection: 'blog', data: entry.data });
    check('a real entry parses against its real schema', (result.issues || []).length === 0, JSON.stringify(result.issues));
    const broken = await validateEntry(source, {
      collection: 'blog',
      data: { ...entry.data, category: 'nope' },
    });
    check(
      'and a broken one does not',
      (broken.issues || []).some((i) => i.path[0] === 'category'),
    );
  }

  // The rules no single field can check, landing on the field they belong to.
  {
    const jobs = listEntries(
      source,
      config.collections.find((collection) => collection.name === 'jobs'),
    ).entries[0];
    const closes = await validateEntry(source, {
      collection: 'jobs',
      data: { ...jobs.data, closesAt: '2020-01-01' },
    });
    check(
      'a closing date before the posting date is caught',
      (closes.issues || []).some((i) => i.path.join('.') === 'closesAt'),
      JSON.stringify(closes.issues),
    );
    const salary = await validateEntry(source, {
      collection: 'jobs',
      data: { ...jobs.data, salary: { ...jobs.data.salary, max: jobs.data.salary.min - 10 } },
    });
    check(
      'a maximum salary below the minimum is caught, on salary.max',
      (salary.issues || []).some((i) => i.path.join('.') === 'salary.max'),
      JSON.stringify(salary.issues),
    );
    check(
      "and the message is the project's own words",
      (salary.issues || [])[0]?.message?.length > 10 && !/zod/i.test((salary.issues || [])[0]?.message || ''),
    );
  }

  // A hint is what the user reads instead of the schema.
  {
    const settings = config.collections.find((collection) => collection.name === 'siteSettings');
    const brand = collectionFields(settings.schema).union.members[0];
    const theme = brand.fields.find((field) => field.key === 'themeColor');
    check('a regex becomes a sentence', /hex colour/.test(hintFor(theme) || ''), hintFor(theme));
    const field = describeField({ type: 'string', pattern: '^[a-z0-9-]+$' }, 'slug', {});
    check('and an unknown one still says something', /lowercase/.test(hintFor(field) || ''), hintFor(field));
    const products = config.collections.find((collection) => collection.name === 'products');
    const sku = collectionFields(products.schema)
      .fields.find((field) => field.key === 'variants')
      .item.fields.find((field) => field.key === 'sku');
    check('a sku pattern reads as an example', /BCN-STD/.test(hintFor(sku) || ''), hintFor(sku));
  }

  if (failures.length) {
    console.error(`\ncontent-fields: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    stopAllServices();
    process.exit(1);
  }
  console.log(`content-fields: ${checked} passed  [${fieldsSeen} fields, ${controls.size} controls]`);
  stopAllServices();
})();
