// Goal: retiring the regex schema reader (Phase 1 of docs/plans/prop-controls.md)
// changed nothing a panel shows, except where a difference is stated below
// with its reason. The prop model now answers what the regex reader used to;
// this test holds its answers to the old ones, prop by prop.
//
// Method: test/fixtures/propModelParity/regexReader.json is the output of the
// old reader at commit 00c79b97, captured before it was deleted: for every
// `.astro` file under test/ (the prop zoo's 80 components, the parser corpus
// and the editor fixtures), the instance schema (`parsePropSchema`, with the
// zoo's imported types) and the Properties panel's list
// (`readComponentProperties`). Each file is read again through the model and
// compared field by field and key by key:
//   - a key that matches is held;
//   - a key listed in INTENDED is a deliberate change, and must differ from
//     the snapshot in exactly the stated way (a stale entry fails too);
//   - the model's new facts (ADDED_KEYS) may appear on any field;
//   - anything else fails: a regression, or an intended change to state here.
// Rerun it alone with `env -u ELECTRON_RUN_AS_NODE npm test -- electron/properties/propModelParity`.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { repoPath } = require('../../helpers/sources.js');
const { parsePropSchema } = require('#dist/electron/parse/astroParser.js');
const { importedTypes } = require('#dist/electron/properties/propDefaults.js');
const { readComponentProperties } = require('#dist/electron/properties/propertyDefinitions.js');

const SNAPSHOT = JSON.parse(fs.readFileSync(repoPath('test/fixtures/propModelParity/regexReader.json'), 'utf8'));
const ZOO = 'test/fixtures/propZoo/';

// Keys the model adds to a schema field; the old reader had no such facts.
const ADDED_KEYS = new Set(['deprecated', 'usage']);

// Deliberate differences, keyed `file#reader.prop.key` (`reader` is schema or
// panel; `names` is the order of the list). Each states the old and new value.
const INTENDED = {
  // The regex reader skipped a member that shares its line with a block
  // comment (`/* A block comment. */ subtitle?: string;`), so subtitle was
  // found only later in the destructure, sorted last, and the comment landed
  // on the next member, count. The syntax tree reads the line as written.
  [`${ZOO}src/components/CommentsInType.astro#schema.names`]: {
    old: ['title', 'count', 'mode', 'subtitle'],
    new: ['title', 'subtitle', 'count', 'mode'],
  },
  [`${ZOO}src/components/CommentsInType.astro#schema.count.doc`]: { old: 'A block comment.', new: undefined },
  [`${ZOO}src/components/CommentsInType.astro#schema.subtitle.doc`]: { old: undefined, new: 'A block comment.' },
  [`${ZOO}src/components/CommentsInType.astro#panel.names`]: {
    old: ['title', 'count', 'mode', 'subtitle'],
    new: ['title', 'subtitle', 'count', 'mode'],
  },
  // `meta: { tags = [], reading = 1 } = {}` destructures meta with a default of
  // `{}`. The regex reader skipped nested patterns entirely; the model reads
  // the entry's default, which the Properties panel already showed.
  [`${ZOO}src/components/NestedDestructure.astro#schema.meta.default`]: { old: undefined, new: '{}' },
  [`${ZOO}src/components/NestedDestructure.astro#schema.meta.defaultExpr`]: { old: undefined, new: true },
  // The Properties panel listed declared and destructured props only, so a
  // prop the component reads as `Astro.props.year` was offered on instances
  // but missing from the panel (propZoo's DirectAccessUntyped gap). Both
  // panels now list what the model reads.
  [`${ZOO}src/components/DirectAccessUntyped.astro#panel.names`]: { old: [], new: ['year', 'label'] },
};

const shown = (value) => JSON.stringify(value) ?? 'undefined';

function readNow(file) {
  const absolute = repoPath(file);
  const source = fs.readFileSync(absolute, 'utf8');
  const project = file.startsWith(ZOO) ? repoPath(ZOO) : path.dirname(absolute);
  const entry = {};
  entry.schema = JSON.parse(JSON.stringify(parsePropSchema(source, importedTypes(source, absolute, project))));
  try {
    const properties = readComponentProperties(source).properties;
    entry.panel = properties.map(({ name, type, required, readonly, defaultValue, description }) => ({
      name,
      type,
      required,
      readonly,
      defaultValue,
      description,
    }));
  } catch (error) {
    entry.panelError = String(error);
  }
  return entry;
}

// Every [key, old, new] where the two lists of named records differ.
function differences(reader, before, after) {
  const out = [];
  const oldNames = (before ?? []).map((item) => item.name);
  const newNames = (after ?? []).map((item) => item.name);
  if (shown(oldNames) !== shown(newNames)) {
    out.push([`${reader}.names`, oldNames, newNames]);
  }
  const byName = new Map((after ?? []).map((item) => [item.name, item]));
  for (const item of before ?? []) {
    const now = byName.get(item.name);
    if (now === undefined) {
      continue;
    }
    for (const key of new Set([...Object.keys(item), ...Object.keys(now)])) {
      if (ADDED_KEYS.has(key) && !(key in item)) {
        continue;
      }
      if (shown(item[key]) !== shown(now[key])) {
        out.push([`${reader}.${item.name}.${key}`, item[key], now[key]]);
      }
    }
  }
  return out;
}

test('the snapshot covers every component under test/', () => {
  const files = Object.keys(SNAPSHOT.files);
  assert.ok(files.length >= 140, `the corpus has ${files.length} files`);
  assert.ok(files.filter((file) => file.startsWith(`${ZOO}src/components/`)).length === 80, 'the whole prop zoo is in the corpus');
  for (const key of Object.keys(INTENDED)) {
    assert.ok(SNAPSHOT.files[key.split('#')[0]], `${key}: an intended change names a corpus file`);
  }
});

const seen = new Set();
for (const [file, before] of Object.entries(SNAPSHOT.files)) {
  test(file, () => {
    const after = readNow(file);
    const found = [...differences('schema', before.schema, after.schema), ...differences('panel', before.panel, after.panel)];
    assert.equal(after.panelError, before.panelError, 'the panel fails, or reads, as it did');
    for (const [key, old, now] of found) {
      const intended = INTENDED[`${file}#${key}`];
      assert.ok(intended, `${file}#${key}: old ${shown(old)}, new ${shown(now)}`);
      assert.equal(shown(old), shown(intended.old), `${file}#${key}: the snapshot still says what the change replaced`);
      assert.equal(shown(now), shown(intended.new), `${file}#${key}: the model says what the change states`);
      seen.add(`${file}#${key}`);
    }
  });
}

test('every intended change still happens', () => {
  assert.deepEqual(
    Object.keys(INTENDED).filter((key) => !seen.has(key)),
    [],
  );
});
