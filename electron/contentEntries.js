const fs = require('fs');
const path = require('path');

const frontmatter = require('./formats/frontmatter');
const jsonFormat = require('./formats/json');
const yamlFormat = require('./formats/yaml');
const tomlFormat = require('./formats/toml');
const csvFormat = require('./formats/csv');
const ndjsonFormat = require('./formats/ndjson');

// Finding, reading and writing the entries of a content collection.
//
// Where an entry lives depends on the loader (see contentConfig.js): a glob
// collection keeps one file per entry, a file collection keeps all of them
// inside one data file. What an entry *is* depends on the format that file is
// written in, and no two of those are edited the same way — so every write goes
// through ./formats, which patches the file rather than re-serializing it.
//
// The id is the other half of the problem. Astro derives it differently per
// collection — from the file path, from a field, from the key an object sits
// under — and an id is what every reference() in the project points at. So it
// is computed here, once, and the rules are named rather than assumed.

const MAX_BYTES = 2 * 1024 * 1024;

const FORMATS = {
  md: frontmatter,
  mdx: frontmatter,
  mdoc: frontmatter,
  markdown: frontmatter,
  json: jsonFormat,
  yaml: yamlFormat,
  yml: yamlFormat,
  toml: tomlFormat,
  csv: csvFormat,
  ndjson: ndjsonFormat,
};

const extensionOf = (file) => (file.split('.').pop() || '').toLowerCase();
const formatFor = (file) => FORMATS[extensionOf(file)] || null;
const formatName = (file) => {
  const ext = extensionOf(file);
  return FORMATS[ext] === frontmatter ? 'frontmatter' : ext;
};

const toPosix = (p) => p.split(path.sep).join('/');
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// A glob pattern as a regular expression: `**` crosses folders, `*` does not,
// and `{a,b}` is a choice. Enough for the patterns a content config writes.
function globToRegExp(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        out += pattern[i + 2] === '/' ? '(?:.*\\/)?' : '.*';
        i += pattern[i + 2] === '/' ? 2 : 1;
      } else out += '[^/]*';
    } else if (ch === '{') {
      const close = pattern.indexOf('}', i);
      out += `(?:${pattern
        .slice(i + 1, close)
        .split(',')
        .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('|')})`;
      i = close;
    } else if (ch === '?') out += '[^/]';
    else out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

function walkFiles(dir, base = dir, out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, base, out);
    else out.push(toPosix(path.relative(base, full)));
  }
  return out;
}

// The title an entry shows in a list. Its own name if it has one, its id
// otherwise — an id is always something, which is more than can be said for a
// record whose fields are all optional.
const TITLE_KEYS = ['title', 'name', 'label', 'heading', 'question', 'siteName', 'quote'];
function titleOf(data, id) {
  if (isPlainObject(data)) {
    for (const key of TITLE_KEYS) {
      const value = data[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  }
  return id;
}

/**
 * Every entry of one collection, as { id, file, format, locator, data, body }.
 * `locator` is the path to the record inside its file, empty for a collection
 * that keeps one file per entry.
 */
function listEntries(projectPath, collection) {
  const loader = collection.loader || {};
  if (loader.kind === 'glob') return globEntries(projectPath, collection);
  if (loader.kind === 'file') return fileEntries(projectPath, collection);
  return { entries: [], readOnly: true, reason: readOnlyReason(collection) };
}

function readOnlyReason(collection) {
  const loader = collection.loader || {};
  if (loader.kind === 'custom') {
    return `${collection.name} is built by a loader in this project, not stored in a file. Its entries are rebuilt from scratch on every sync, so anything written here would be overwritten.`;
  }
  return null;
}

function globEntries(projectPath, collection) {
  const { base, pattern } = collection.loader;
  const root = path.resolve(projectPath, base.replace(/^\.\//, ''));
  const matchers = [].concat(pattern || []).map(globToRegExp);
  const files = walkFiles(root).filter((rel) => matchers.some((re) => re.test(rel)));
  files.sort();

  const entries = [];
  for (const rel of files) {
    const abs = path.join(root, rel);
    const format = formatFor(rel);
    if (!format) continue;
    let text = '';
    try {
      if (fs.statSync(abs).size > MAX_BYTES) continue;
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    const entry = {
      // Astro's own rule: the path under the base, without its extension.
      id: rel.replace(/\.[^./]+$/, ''),
      file: toPosix(path.relative(projectPath, abs)),
      format: formatName(rel),
      locator: [],
    };
    try {
      if (format === frontmatter) {
        const parsed = frontmatter.parse(text);
        entry.data = parsed.data || {};
        entry.body = parsed.body;
        entry.hasBody = true;
      } else {
        entry.data = format.parseData(text);
      }
    } catch (err) {
      entry.error = String(err.message || err);
      entry.data = {};
    }
    entry.title = titleOf(entry.data, entry.id);
    entries.push(entry);
  }

  const generated = collection.loader.generateId;
  return {
    entries,
    readOnly: false,
    // The id is not the file path, and nothing outside the loader knows the
    // rule it uses — so an id shown here is a guess, and renaming the file is
    // not what renames the entry.
    idsAreGuesses: !!generated,
    idNote: generated
      ? `${collection.name} builds its ids in the loader, from the entry's own fields. The ids shown are the file paths, which is not what other collections reference.`
      : null,
  };
}

// Where the records are inside a data file, and what identifies each one.
//   [ { id: … } ]        → the id field, addressed by position
//   { key: { … } }       → the key itself
//   anything else        → any object with an id, wherever it sits, which is
//                          what a parser-shaped file looks like
function locateRecords(data) {
  if (Array.isArray(data)) {
    if (!data.length || !data.every(isPlainObject)) return { shape: 'array', records: [] };
    return {
      shape: 'array',
      records: data.map((record, index) => ({
        id: typeof record.id === 'string' ? record.id : String(index),
        idKey: typeof record.id === 'string' ? 'id' : null,
        locator: [index],
        record,
      })),
    };
  }
  if (!isPlainObject(data)) return { shape: 'unknown', records: [] };

  const keys = Object.keys(data).filter((k) => k !== '$schema');
  if (keys.length && keys.every((k) => isPlainObject(data[k]))) {
    return {
      shape: 'keyed',
      records: keys.map((key) => ({ id: key, idKey: null, keyed: true, locator: [key], record: data[key] })),
    };
  }

  // Nested: the file groups its records under something. Every object with a
  // string id counts, wherever it is — which is how a grouped file (categories
  // holding questions) comes apart without knowing what the grouping means.
  const records = [];
  const visit = (node, locator) => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, [...locator, index]));
      return;
    }
    if (!isPlainObject(node)) return;
    if (typeof node.id === 'string' && locator.length) {
      records.push({ id: node.id, idKey: 'id', locator, record: node });
      return;
    }
    for (const [key, value] of Object.entries(node)) visit(value, [...locator, key]);
  };
  visit(data, []);
  return { shape: records.length ? 'nested' : 'single', records };
}

function fileEntries(projectPath, collection) {
  const rel = toPosix(collection.loader.file).replace(/^\.\//, '');
  const abs = path.resolve(projectPath, rel);
  const format = formatFor(rel);
  if (!format) {
    return { entries: [], readOnly: true, reason: `Stacki cannot read ${path.extname(rel)} data files yet.` };
  }
  let text = '';
  try {
    if (fs.statSync(abs).size > MAX_BYTES) {
      return { entries: [], readOnly: true, reason: 'This file is too large to edit here.' };
    }
    text = fs.readFileSync(abs, 'utf8');
  } catch (err) {
    return { entries: [], readOnly: true, reason: `Could not read ${rel} — ${err.message}` };
  }

  let data;
  try {
    data = format.parseData(text);
  } catch (err) {
    return { entries: [], readOnly: true, reason: `${rel} could not be parsed — ${err.message}` };
  }

  const { shape, records } = locateRecords(data);
  const entries = records.map(({ id, locator, record, keyed }) => ({
    id,
    file: rel,
    format: formatName(rel),
    locator,
    keyed: !!keyed,
    data: record,
    title: titleOf(record, id),
  }));

  return {
    entries,
    readOnly: false,
    shape,
    // A parser stands between the file and the entries, so some of what an
    // entry holds was never in the file — and the fields it invented cannot be
    // written back through it.
    parsed: !!collection.loader.parser,
    parserNote: collection.loader.parser
      ? `${collection.name} is parsed by a function in the content config before Astro sees it. Fields that are not in the file itself were made by that parser: they are shown, but editing one here would have nowhere to go.`
      : null,
  };
}

/**
 * Applies edits to one entry. `edits` are { path, value } against the entry's
 * own data — the locator that puts it inside its file is added here — plus an
 * optional `body` for the formats that have one.
 */
function writeEntry(projectPath, entry, edits, { body } = {}) {
  const abs = path.resolve(projectPath, entry.file);
  const format = formatFor(entry.file);
  if (!format) throw new Error(`Stacki cannot write ${path.extname(entry.file)} files.`);
  const text = fs.readFileSync(abs, 'utf8');

  const locator = entry.locator || [];
  const prefixed = edits.map((edit) =>
    // A rename names a key rather than setting a value, so it carries no value
    // at all — and must not be read as one being cleared.
    edit.rename !== undefined
      ? { path: [...locator, ...edit.path], rename: edit.rename }
      : { path: [...locator, ...edit.path], value: edit.value === undefined ? format.DELETE : edit.value }
  );

  const next =
    format === frontmatter
      ? frontmatter.applyEdits(text, prefixed, { body })
      : format.applyEdits(text, prefixed);
  if (next === text) return { ok: true, changed: false };
  fs.writeFileSync(abs, next, 'utf8');
  return { ok: true, changed: true };
}

/**
 * How many entries a collection has, without reading them. The panel shows a
 * count next to every collection, and parsing a hundred markdown files to draw
 * a number is a cost with nothing to show for it.
 */
function countEntries(projectPath, collection) {
  const loader = collection.loader || {};
  if (loader.kind === 'glob') {
    const root = path.resolve(projectPath, String(loader.base).replace(/^\.\//, ''));
    const matchers = [].concat(loader.pattern || []).map(globToRegExp);
    return walkFiles(root).filter((rel) => matchers.some((re) => re.test(rel))).length;
  }
  if (loader.kind === 'file') {
    try {
      return listEntries(projectPath, collection).entries.length;
    } catch {
      return 0;
    }
  }
  return 0;
}

/**
 * The files a content collection already owns. They are edited through their
 * schema, not as loose JSON, so the file-based editor leaves them alone rather
 * than offering a second way in with different rules.
 */
function coveredPaths(collections) {
  const files = [];
  const dirs = [];
  for (const collection of collections) {
    const loader = collection.loader || {};
    if (loader.kind === 'file' && loader.file) files.push(toPosix(loader.file).replace(/^\.\//, ''));
    if (loader.kind === 'glob' && loader.base) dirs.push(toPosix(loader.base).replace(/^\.\//, '').replace(/\/$/, ''));
  }
  return { files, dirs };
}

module.exports = {
  listEntries,
  writeEntry,
  countEntries,
  coveredPaths,
  locateRecords,
  globToRegExp,
  formatFor,
  formatName,
};
