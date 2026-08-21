const fs = require('fs');
const path = require('path');
const postcss = require('postcss');

// Reading a project's CSS custom properties as something an editor can show.
//
// There is no schema here and no convention to lean on: variables are declared
// wherever the author put them, named however they name things, and the only
// structure in the file is the structure a person gave it — which rule they sit
// in, which comment they sit under, and what their names have in common.
//
// So all three are used, in that order:
//
//   the file       one tab per stylesheet, because that is how the author
//                  divided the work in the first place
//   the rule       `:root` is one thing; `.theme-dark` is another. Rules that
//                  declare the same set of names are the same thing seen in
//                  different modes, and become columns of one table.
//   the comment    a comment between declarations is a heading — `/* Swatches
//                  */` says what the next few lines are.
//
// Then the names themselves. `--h1-line-height` and `--text-small-line-height`
// are the same property of two different things, and a list is the wrong shape
// for that: it reads as thirteen unrelated rows repeated eight times. Split at
// the point where the names stop agreeing and it is a table — one row per
// property, one column per thing — which is both shorter and the way the
// author was thinking when they wrote it.

const MAX_BYTES = 1024 * 1024;
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.astro', '.stacki']);

const toPosix = (p) => p.split(path.sep).join('/');

// --- reading ---------------------------------------------------------------

function findStylesheets(projectPath) {
  const roots = ['src', 'public', 'styles'].map((d) => path.join(projectPath, d));
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 8) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (/\.css$/i.test(entry.name)) found.push(full);
    }
  };
  for (const root of roots) walk(root, 0);
  return [...new Set(found)].sort();
}

// Every custom property declared in one file, with where its value sits in the
// text so it can be written back without reformatting anything around it.
function readDeclarations(text) {
  const root = postcss.parse(text);
  const rules = [];

  const contextOf = (node) => {
    const parts = [];
    let parent = node.parent;
    while (parent && parent.type !== 'root') {
      if (parent.type === 'atrule') parts.unshift(`@${parent.name} ${parent.params}`.trim());
      else if (parent.type === 'rule') parts.unshift(parent.selector);
      parent = parent.parent;
    }
    return parts;
  };

  root.walkRules((rule) => {
    const entries = [];
    for (const node of rule.nodes || []) {
      if (node.type === 'comment') {
        // Where the words are, inside the `/*` and the spacing postcss keeps in
        // raws: a heading in a single-rule file IS this comment, so renaming it
        // means writing here.
        const open = node.source?.start?.offset ?? 0;
        const textStart = open + 2 + (node.raws?.left?.length ?? 0);
        entries.push({
          kind: 'comment',
          text: node.text.trim(),
          textStart,
          textEnd: textStart + node.text.length,
        });
        continue;
      }
      if (node.type !== 'decl' || !node.prop.startsWith('--')) continue;
      // postcss gives the declaration's span; the value starts after the colon
      // that follows the property name.
      const start = node.source?.start?.offset ?? 0;
      const end = node.source?.end?.offset ?? start;
      const declText = text.slice(start, end + 1);
      const colon = declText.indexOf(':', node.prop.length);
      const leading = declText.slice(colon + 1).match(/^\s*/)[0].length;
      const valueStart = start + colon + 1 + leading;
      // Trailing `;` and whitespace are not part of the value.
      let valueEnd = start + declText.replace(/[\s;]+$/, '').length;
      if (valueEnd <= valueStart) valueEnd = valueStart + node.value.length;
      entries.push({
        kind: 'var',
        name: node.prop,
        value: text.slice(valueStart, valueEnd),
        important: !!node.important,
        valueStart,
        valueEnd,
        line: node.source?.start?.line ?? 0,
      });
    }
    if (!entries.some((e) => e.kind === 'var')) return;
    rules.push({
      selector: rule.selector,
      selectors: rule.selectors,
      context: contextOf(rule),
      line: rule.source?.start?.line ?? 0,
      entries,
    });
  });

  return rules;
}

// --- naming ----------------------------------------------------------------

const titleize = (text) =>
  String(text)
    .replace(/[-_]+/g, ' ')
    .trim()
    .replace(/^./, (c) => c.toUpperCase());

// What to call a rule. A selector list usually leads with the generic one
// (`:root, .theme-light, …`) and the name people use for it is the specific
// one, so the first plain class wins over `:root`, `*` and anything nested.
function labelForRule(rule) {
  const candidates = rule.selectors || [rule.selector];
  const simpleClass = candidates.find((s) => /^\.[a-z0-9_-]+$/i.test(s.trim()));
  const chosen = simpleClass || candidates[0] || rule.selector;
  const cleaned = String(chosen).trim();
  if (cleaned === ':root') return ':root';
  if (/^\.[a-z0-9_-]+$/i.test(cleaned)) return titleize(cleaned.slice(1));
  return cleaned;
}

// The stem shared by a set of labels, for naming a group of modes: "Theme
// light" + "Theme dark" + "Theme brand" → "Theme".
function commonStem(labels) {
  if (!labels.length) return '';
  const words = labels.map((l) => l.split(/\s+/));
  const stem = [];
  for (let i = 0; i < words[0].length; i++) {
    const word = words[0][i];
    if (!words.every((w) => w[i] === word)) break;
    stem.push(word);
  }
  return stem.join(' ');
}

// --- grouping --------------------------------------------------------------

const namesOf = (rule) => rule.entries.filter((e) => e.kind === 'var').map((e) => e.name);

const overlap = (a, b) => {
  const setB = new Set(b);
  const shared = a.filter((name) => setB.has(name)).length;
  return shared / Math.max(a.length, b.length);
};

// Rules that declare the same names are one thing in several modes — a light
// theme and a dark one, a size scale and its variants. They are shown as
// columns of a single table rather than as three tables nobody can compare.
const MERGE_THRESHOLD = 0.6;

function groupRules(rules) {
  const groups = [];
  const taken = new Set();

  rules.forEach((rule, index) => {
    if (taken.has(index)) return;
    const names = namesOf(rule);
    const members = [rule];
    taken.add(index);

    for (let other = index + 1; other < rules.length; other++) {
      if (taken.has(other)) continue;
      const candidate = rules[other];
      if (candidate.context.join('|') !== rule.context.join('|')) continue;
      const otherNames = namesOf(candidate);
      const same = overlap(names, otherNames);
      // One shared name is only a mode when it is the whole of both rules —
      // a page of utilities each setting `--_gap-size` is a scale, not a
      // coincidence.
      const enough =
        names.length > 1 ? same >= MERGE_THRESHOLD : same === 1 && otherNames.length === names.length;
      if (enough) {
        members.push(candidate);
        taken.add(other);
      }
    }
    groups.push(members);
  });

  return groups;
}

// --- families (the columns inside one rule) --------------------------------

// Every way a name can be cut into a prefix and a suffix at a dash.
function splits(name) {
  const body = name.replace(/^--/, '');
  const parts = body.split('-');
  const out = [];
  for (let at = 1; at < parts.length; at++) {
    out.push({ prefix: parts.slice(0, at).join('-'), suffix: parts.slice(at).join('-') });
  }
  return out;
}

/**
 * The tables hiding in a list of names.
 *
 * A family is a set of prefixes that share a set of suffixes: {h1, h2, …} all
 * having {line-height, margin-top, …}. The suffix that the most prefixes agree
 * on picks the family; every other suffix that most of those prefixes also have
 * becomes a row. A name that is only the prefix (`--h1`) is the family's own
 * value, and is the first row.
 */
// The suffixes most of these prefixes declare. "Most" rather than "all",
// because one variant carrying an extra property is normal and should not cost
// everyone else the table.
function rowsFor(prefixes, bySuffix, used) {
  const rows = [];
  for (const [suffix, owners] of bySuffix) {
    const shared = prefixes.filter((p) => owners.has(p) && !used.has(`--${p}-${suffix}`));
    if (shared.length >= Math.max(2, Math.ceil(prefixes.length * 0.5))) rows.push(suffix);
  }
  return rows;
}

function findFamilies(names) {
  const bySuffix = new Map(); // suffix -> Set(prefix)
  for (const name of names) {
    for (const { prefix, suffix } of splits(name)) {
      if (!bySuffix.has(suffix)) bySuffix.set(suffix, new Set());
      bySuffix.get(suffix).add(prefix);
    }
  }

  const nameSet = new Set(names);
  const families = [];
  const used = new Set();


  for (;;) {
    // Every suffix is a candidate seed: the prefixes that share it might be a
    // family. Which one is picked matters — `--h1-margin-top` and
    // `--h1-trim-top` both end in `top`, so "top" seeds a wide, shallow family
    // of fourteen `*-margin`/`*-trim` prefixes that would eat two rows out of
    // the real one. The family that accounts for the most declarations wins,
    // which is the deep one: seven headings by thirteen properties.
    let best = null;
    for (const [suffix, prefixes] of bySuffix) {
      const seed = [...prefixes].filter((p) => !used.has(`--${p}-${suffix}`));
      if (seed.length < 2) continue;
      const rows = rowsFor(seed, bySuffix, used);
      // A prefix that is also a variable of its own — `--gap-1` beside
      // `--gap-1-min` — is a row too: the family's own value. Without counting
      // it, a scale with one part each looks like a single-row table and stays
      // a list.
      const self = seed.some((p) => nameSet.has(`--${p}`) && !used.has(`--${p}`));
      const height = rows.length + (self ? 1 : 0);
      if (height < 2) continue;
      const score = seed.length * height;
      if (!best || score > best.score) best = { score, prefixes: seed, rows };
    }
    if (!best) break;

    const prefixes = best.prefixes;
    const rows = best.rows;

    // Source order is what the author chose, so rows and columns follow the
    // order the names appeared in rather than anything alphabetical.
    const order = new Map();
    names.forEach((name, index) => {
      for (const { prefix, suffix } of splits(name)) {
        if (prefixes.includes(prefix) && !order.has(suffix)) order.set(suffix, index);
      }
    });
    rows.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));

    const columnOrder = new Map();
    names.forEach((name, index) => {
      const body = name.replace(/^--/, '');
      for (const prefix of prefixes) {
        if ((body === prefix || body.startsWith(`${prefix}-`)) && !columnOrder.has(prefix)) {
          columnOrder.set(prefix, index);
        }
      }
    });
    const columns = [...prefixes].sort((a, b) => (columnOrder.get(a) ?? 0) - (columnOrder.get(b) ?? 0));

    const family = { prefixes: columns, rows: [], self: false };
    // `--h1` itself, if it exists: the value the family is named for.
    if (columns.some((p) => nameSet.has(`--${p}`))) {
      family.self = true;
      for (const p of columns) used.add(`--${p}`);
    }
    for (const suffix of rows) {
      family.rows.push(suffix);
      for (const p of columns) used.add(`--${p}-${suffix}`);
    }
    families.push(family);
    if (families.length > 24) break; // a stylesheet, not a database
  }

  return { families, used };
}

// --- sections --------------------------------------------------------------

// Names sharing a leading part, where that part is not itself a variable:
// `--selection-background` and `--selection-text` belong to the selection,
// while `--background` and `--background-2` do not belong to a background —
// there is one, and it is a variable in its own right.
//
// The longest shared start wins, so `--button-2-*` is its own thing rather than
// six more rows of `--button-*`.
function prefixSections(names) {
  const nameSet = new Set(names);
  const counts = new Map();
  for (const name of names) {
    const body = name.replace(/^--/, '');
    const parts = body.split('-');
    for (let at = 1; at < parts.length; at++) {
      const prefix = parts.slice(0, at).join('-');
      if (nameSet.has(`--${prefix}`)) continue;
      counts.set(prefix, (counts.get(prefix) || 0) + 1);
    }
  }

  const qualifies = (prefix) => (counts.get(prefix) || 0) >= 2;
  const assigned = new Map(); // prefix -> [names]
  const loose = [];
  for (const name of names) {
    const body = name.replace(/^--/, '');
    const parts = body.split('-');
    let chosen = null;
    for (let at = 1; at < parts.length; at++) {
      const prefix = parts.slice(0, at).join('-');
      if (qualifies(prefix)) chosen = prefix;
    }
    if (!chosen) {
      loose.push(name);
      continue;
    }
    if (!assigned.has(chosen)) assigned.set(chosen, []);
    assigned.get(chosen).push(name);
  }

  // A section of one is not a section — those names go back in the main list,
  // in the place they were declared.
  const sections = new Map();
  const orphans = new Set();
  for (const [prefix, group] of assigned) {
    if (group.length >= 2) sections.set(prefix, group);
    else group.forEach((n) => orphans.add(n));
  }
  const mainList = names.filter((n) => loose.includes(n) || orphans.has(n));
  return { loose: mainList, sections };
}

// --- what a value is ---------------------------------------------------------
//
// A variable is worth showing as a swatch when it resolves to a colour, and
// resolving means following `var(--x)` until it stops moving. Two things stop
// it: a value with no variables left in it, and a value that cannot be worked
// out at all — `color-mix(in lab, currentcolor 10%, transparent)` depends on
// what it lands on, and no editor can preview that honestly.

const NAMED_COLORS = new Set([
  'transparent', 'currentcolor', 'black', 'white', 'red', 'green', 'blue', 'yellow', 'orange',
  'purple', 'pink', 'gray', 'grey', 'brown', 'cyan', 'magenta', 'lime', 'navy', 'teal', 'olive',
  'maroon', 'silver', 'gold', 'beige', 'ivory', 'coral', 'salmon', 'khaki', 'indigo', 'violet',
]);

const COLOR_FN = /^(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i;

function resolveValue(value, map, depth = 0) {
  if (depth > 8) return value;
  const next = String(value).replace(/var\(\s*(--[\w-]+)\s*(?:,([^()]*(?:\([^()]*\)[^()]*)*))?\)/g,
    (whole, name, fallback) => {
      const found = map.get(name);
      if (found !== undefined) return found;
      return fallback !== undefined ? fallback.trim() : whole;
    });
  return next === String(value) ? next : resolveValue(next, map, depth + 1);
}

function colorOf(resolved) {
  const value = String(resolved).trim();
  if (!value) return null;
  if (/^#[0-9a-f]{3,8}$/i.test(value)) return value;
  if (COLOR_FN.test(value)) return value;
  if (NAMED_COLORS.has(value.toLowerCase())) return value;
  return null;
}

// True for values that name a colour but cannot be drawn as one — the swatch
// shows a checkerboard rather than pretending.
const isUncomputableColor = (resolved) => /(^|\s|\()color-mix\(/i.test(String(resolved));

// What kind of thing a variable holds, which is what picks its glyph — the same
// four the style panel's variable picker uses, so a colour is a droplet in both
// places and a bare number is a number in both.
const FONT_WORDS = /(serif|sans-serif|monospace|cursive|system-ui|uppercase|lowercase|capitalize|balance|pretty|italic|normal|inherit)/i;

function kindOf(value, resolved) {
  const text = String(resolved ?? value).trim();
  if (!text) return 'size';
  if (colorOf(text) || isUncomputableColor(text)) return 'color';
  // Unitless: a line height, a weight, a column count, a fluid-scale bound.
  if (/^-?\d*\.?\d+$/.test(text)) return 'number';
  if (/^-?\d*\.?\d+([a-z%]+)$/i.test(text) || /^(calc|clamp|min|max)\(/i.test(text)) return 'size';
  if (/[a-z]/i.test(text) && (FONT_WORDS.test(text) || text.includes(',') || /^[a-z-]+$/i.test(text))) {
    return 'font';
  }
  return 'size';
}

// --- the model -------------------------------------------------------------

function buildGroup(members, file) {
  const columns = members.map((rule, index) => ({
    id: `${index}`,
    label: labelForRule(rule),
    selector: rule.selector,
    context: rule.context,
    line: rule.line,
  }));
  const byName = members.map((rule) => {
    const map = new Map();
    for (const entry of rule.entries) if (entry.kind === 'var') map.set(entry.name, { ...entry, selector: rule.selector });
    return map;
  });

  const cellsFor = (name) =>
    byName.map((map, index) => {
      const entry = map.get(name);
      if (!entry) return null;
      return {
        name,
        value: entry.value,
        file,
        // Which rule declared it: what a move looks the declaration up by.
        selector: entry.selector,
        valueStart: entry.valueStart,
        valueEnd: entry.valueEnd,
        line: entry.line,
        column: columns[index].id,
      };
    });

  const blocks = [];
  const multi = members.length > 1;

  if (multi) {
    // The columns are the modes, so the names are the rows. Sub-sections come
    // from shared prefixes.
    const names = [];
    for (const map of byName) for (const name of map.keys()) if (!names.includes(name)) names.push(name);
    const { loose, sections } = prefixSections(names);
    if (loose.length) {
      blocks.push({ kind: 'rows', title: null, rows: loose.map((n) => ({ label: shortLabel(n), name: n, cells: cellsFor(n) })) });
    }
    for (const [prefix, group] of sections) {
      blocks.push({
        kind: 'rows',
        title: prefix,
        rows: group.map((n) => ({ label: shortLabel(n, prefix), name: n, cells: cellsFor(n) })),
      });
    }
    return { kind: 'modes', label: commonStem(columns.map((c) => c.label)) || columns[0].label, columns, blocks };
  }

  // One rule: comments are headings, and the names inside each heading may form
  // tables of their own.
  const rule = members[0];
  const sections = [];
  let current = { title: null, names: [] };
  for (const entry of rule.entries) {
    if (entry.kind === 'comment') {
      // A heading with nothing under it is kept. It used to be dropped, which
      // was tidy right up until the panel grew a way to MAKE one: a new group
      // starts empty, and a group you cannot see is one you cannot fill.
      // (Untitled runs with no names are still nothing at all.)
      if (current.names.length || current.title != null) sections.push(current);
      current = { title: entry.text, titleStart: entry.textStart, titleEnd: entry.textEnd, names: [] };
      continue;
    }
    current.names.push(entry.name);
  }
  if (current.names.length || current.title != null) sections.push(current);

  for (const section of sections) {
    const { families, used } = findFamilies(section.names);
    const claimed = new Set();
    for (const family of families) {
      const rows = [];
      if (family.self) {
        rows.push({
          label: 'value',
          cells: family.prefixes.map((p) => cellFor(byName[0], `--${p}`, file, '0')),
        });
      }
      for (const suffix of family.rows) {
        rows.push({
          label: suffix,
          cells: family.prefixes.map((p) => cellFor(byName[0], `--${p}-${suffix}`, file, '0')),
        });
      }
      if (family.self) for (const p of family.prefixes) claimed.add(`--${p}`);
      for (const suffix of family.rows) for (const p of family.prefixes) claimed.add(`--${p}-${suffix}`);
      blocks.push({
        kind: 'matrix',
        title: section.title,
        titleStart: section.titleStart,
        titleEnd: section.titleEnd,
        columns: family.prefixes.map((p) => ({ id: p, label: p })),
        rows: rows.filter((r) => r.cells.some(Boolean)),
      });
    }
    const leftovers = section.names.filter((n) => !claimed.has(n) && !used.has(n));
    if (leftovers.length || (!families.length && section.title != null)) {
      blocks.push({
        kind: 'rows',
        title: families.length ? null : section.title,
        ...(families.length ? {} : { titleStart: section.titleStart, titleEnd: section.titleEnd }),
        rows: leftovers.map((n) => ({ label: shortLabel(n), name: n, cells: [cellFor(byName[0], n, file, '0')] })),
      });
    }
  }

  return { kind: 'single', label: labelForRule(rule), columns, blocks };
}

function cellFor(map, name, file, column) {
  const entry = map.get(name);
  if (!entry) return null;
  return {
    name,
    value: entry.value,
    file,
    selector: entry.selector,
    valueStart: entry.valueStart,
    valueEnd: entry.valueEnd,
    line: entry.line,
    column,
  };
}

// A cell's value said three ways: what the file holds, what it comes out as,
// and what colour to draw beside it (if any).
function describeCell(cell, map) {
  if (!cell) return null;
  const single = String(cell.value).trim().match(/^var\(\s*(--[\w-]+)\s*(?:,[^)]*)?\)$/);
  const resolved = resolveValue(cell.value, map);
  return {
    ...cell,
    // A value that is nothing but another variable is shown as that variable's
    // name — which is what the author wrote, and what they would search for.
    ref: single ? single[1] : null,
    resolved: resolved === cell.value ? null : resolved,
    color: colorOf(resolved),
    unknownColor: isUncomputableColor(resolved),
    kind: kindOf(cell.value, resolved),
  };
}

const shortLabel = (name, prefix) => {
  const body = name.replace(/^--/, '');
  return prefix && body.startsWith(`${prefix}-`) ? body.slice(prefix.length + 1) : body;
};

/**
 * Every stylesheet in the project that declares custom properties, as groups of
 * tables. Files with none are left out — a variables panel is a place to find
 * variables, not a file browser.
 */
function readVariables(projectPath) {
  const files = [];
  for (const abs of findStylesheets(projectPath)) {
    let text;
    try {
      if (fs.statSync(abs).size > MAX_BYTES) continue;
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    const rel = toPosix(path.relative(projectPath, abs));
    let rules;
    try {
      rules = readDeclarations(text);
    } catch (err) {
      files.push({ rel, name: path.basename(abs), error: `Could not parse — ${err.message}`, groups: [] });
      continue;
    }
    if (!rules.length) continue;
    const groups = groupRules(rules).map((members) => buildGroup(members, rel));
    files.push({
      rel,
      name: path.basename(abs),
      groups,
      declarations: rules,
      count: rules.reduce((sum, r) => sum + namesOf(r).length, 0),
    });
  }
  // Values reference each other across files as freely as within one, so the
  // map every value is resolved against is the project's, not the file's.
  const map = new Map();
  for (const file of files) {
    for (const rule of file.declarations || []) {
      for (const entry of rule.entries) if (entry.kind === 'var') map.set(entry.name, entry.value);
    }
  }
  const values = Object.fromEntries(map);
  for (const file of files) {
    delete file.declarations;
    for (const group of file.groups) {
      for (const block of group.blocks) {
        for (const row of block.rows) row.cells = row.cells.map((cell) => describeCell(cell, map));
      }
    }
  }
  return { files, values };
}

/**
 * Replaces one variable's value in place. The value it is replacing has to be
 * the value that was read, or the file has changed underneath the panel and the
 * offsets no longer mean anything.
 */
function setVariable(projectPath, { file, valueStart, valueEnd, expect, value }) {
  const abs = path.resolve(projectPath, file);
  const text = fs.readFileSync(abs, 'utf8');
  const current = text.slice(valueStart, valueEnd);
  if (expect !== undefined && current !== expect) {
    return { ok: false, stale: true, error: 'This file changed since the panel read it.' };
  }
  const next = text.slice(0, valueStart) + value + text.slice(valueEnd);
  fs.writeFileSync(abs, next, 'utf8');
  return { ok: true };
}

/**
 * Renames a heading that is a comment.
 *
 * A file with one rule takes its headings from the comments in it, so the
 * heading is not a property of anything — it is those words, and renaming it is
 * writing them. Like a value, it is written back only if the file still says
 * what the panel read.
 */
function setSectionTitle(projectPath, { file, start, end, expect, title }) {
  const next = String(title ?? '').trim();
  if (!next) return { ok: false, error: 'A heading needs a name.' };
  // The words live inside a comment, and `*/` would end it early — the rest of
  // the rule would become the comment's text and the variables under it would
  // stop existing.
  if (next.includes('*/')) return { ok: false, error: 'A heading cannot contain "*/".' };

  const abs = path.resolve(projectPath, file);
  const text = fs.readFileSync(abs, 'utf8');
  const current = text.slice(start, end);
  if (expect !== undefined && current !== expect) {
    return { ok: false, stale: true, error: 'This file changed since the panel read it.' };
  }
  fs.writeFileSync(abs, text.slice(0, start) + next + text.slice(end), 'utf8');
  return { ok: true };
}

/**
 * Removes a heading that is a comment.
 *
 * The variables under it do not go anywhere — they join the section above,
 * which is what a heading meant in the first place: a line drawn between two
 * runs of declarations. Rubbing the line out leaves both runs.
 *
 * Takes the same range as a rename (where the WORDS are) and grows outwards to
 * the `/*` and `*\/` around them, then to the whole line when the comment has
 * one to itself — a heading removed by cutting the words alone would leave an
 * empty comment behind.
 */
function removeSection(projectPath, { file, start, end, expect }) {
  const abs = path.resolve(projectPath, file);
  const text = fs.readFileSync(abs, 'utf8');
  if (expect !== undefined && text.slice(start, end) !== expect) {
    return { ok: false, stale: true, error: 'This file changed since the panel read it.' };
  }
  const open = text.lastIndexOf('/*', start);
  const close = text.indexOf('*/', end);
  if (open === -1 || close === -1) return { ok: false, error: 'That heading is no longer a comment.' };
  let from = open;
  let to = close + 2;
  // A line of its own goes with it; a comment sharing a line with something
  // else leaves that something else where it is.
  const lineStart = text.lastIndexOf('\n', from - 1) + 1;
  const lineEnd = text.indexOf('\n', to);
  const before = text.slice(lineStart, from);
  const after = text.slice(to, lineEnd === -1 ? text.length : lineEnd);
  if (!before.trim() && !after.trim()) {
    from = lineStart;
    to = lineEnd === -1 ? text.length : lineEnd + 1;
  }
  fs.writeFileSync(abs, text.slice(0, from) + text.slice(to), 'utf8');
  return { ok: true };
}

/**
 * Moves a heading, and only the heading.
 *
 * The variables do not travel with it, because they were never inside it: a
 * group is the run of lines between one comment and the next, so dragging a
 * comment up past three variables is how those three variables come to be under
 * it. Moving the run wholesale is a different gesture (moveSection) and a
 * different intent.
 *
 * `before` is the declaration it should sit above; null puts it after the last
 * one, where it heads whatever is added next.
 */
function moveHeading(projectPath, { file, selector, start, end, expect, before }) {
  const abs = path.resolve(projectPath, file);
  const text = fs.readFileSync(abs, 'utf8');
  if (expect !== undefined && text.slice(start, end) !== expect) {
    return { ok: false, stale: true, error: 'This file changed since the panel read it.' };
  }
  const open = text.lastIndexOf('/*', start);
  const close = text.indexOf('*/', end);
  if (open === -1 || close === -1) return { ok: false, error: 'That heading is no longer a comment.' };

  const comment = text.slice(open, close + 2);
  let from = open;
  let to = close + 2;
  const lineStart = text.lastIndexOf('\n', from - 1) + 1;
  const lineEnd = text.indexOf('\n', to);
  if (!text.slice(lineStart, from).trim() && !text.slice(to, lineEnd === -1 ? text.length : lineEnd).trim()) {
    from = lineStart;
    to = lineEnd === -1 ? text.length : lineEnd + 1;
  }
  const cut = text.slice(0, from) + text.slice(to);

  const root = postcss.parse(cut);
  let rule = null;
  root.walkRules((candidate) => {
    if (!rule && candidate.selector === selector) rule = candidate;
  });
  if (!rule) return { ok: false, error: `${selector} is no longer in ${file}.` };

  const decls = (rule.nodes || []).filter((n) => n.type === 'decl');
  const anchorDecl = before ? decls.find((d) => d.prop === before) : null;
  let at;
  if (anchorDecl) {
    at = cut.lastIndexOf('\n', anchorDecl.source.start.offset - 1) + 1;
  } else {
    // After everything: the line following the last declaration, or just inside
    // the brace when the rule has none left.
    const last = decls[decls.length - 1];
    if (last) {
      const nl = cut.indexOf('\n', last.source.end.offset);
      at = nl === -1 ? cut.length : nl + 1;
    } else {
      at = cut.indexOf('{', rule.source.start.offset) + 2;
    }
  }
  const indent = cut.slice(cut.lastIndexOf('\n', at - 1) + 1, at).match(/^\s*/)[0] || '  ';
  fs.writeFileSync(abs, `${cut.slice(0, at)}${indent}${comment}\n${cut.slice(at)}`, 'utf8');
  return { ok: true };
}

/**
 * Writes another heading into the rule.
 *
 * A heading is a line between declarations, so a second one is how a run of
 * variables becomes two runs — and an empty one, written directly above another
 * heading, is a group waiting to be filled.
 *
 * `at` puts it on the line holding that offset (above an existing heading);
 * `before` puts it above a named declaration. Either way it takes the
 * indentation of the line it lands on.
 */
function addSection(projectPath, { file, selector, title, before, at }) {
  const next = String(title ?? '').trim();
  if (!next) return { ok: false, error: 'A heading needs a name.' };
  if (next.includes('*/')) return { ok: false, error: 'A heading cannot contain "*/".' };

  const abs = path.resolve(projectPath, file);
  const text = fs.readFileSync(abs, 'utf8');

  let offset = at;
  if (typeof offset !== 'number') {
    const root = postcss.parse(text);
    let rule = null;
    root.walkRules((candidate) => {
      if (!rule && candidate.selector === selector) rule = candidate;
    });
    if (!rule) return { ok: false, error: `${selector} is no longer in ${file}.` };
    const decls = (rule.nodes || []).filter((n) => n.type === 'decl');
    const anchorDecl = (before && decls.find((d) => d.prop === before)) || decls[decls.length - 1];
    if (!anchorDecl) return { ok: false, error: `${selector} has nothing to head.` };
    offset = anchorDecl.source.start.offset;
  }
  if (offset < 0 || offset > text.length) return { ok: false, error: 'That place is no longer in the file.' };

  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  const indent = text.slice(lineStart, offset).match(/^\s*/)[0];
  fs.writeFileSync(abs, `${text.slice(0, lineStart)}${indent}/* ${next} */\n${text.slice(lineStart)}`, 'utf8');
  return { ok: true, title: next };
}

/**
 * Moves one declaration to sit before another inside the same rule. The panel
 * reorders rows; the file is what actually holds the order, so a row that moves
 * moves the line — indentation, trailing comment and all — rather than being
 * rewritten somewhere else.
 *
 * `target` is the name to land in front of; null means the end of the rule.
 */
function moveVariable(projectPath, { file, selector, name, target, at: landAt }) {
  const abs = path.resolve(projectPath, file);
  const text = fs.readFileSync(abs, 'utf8');
  const root = postcss.parse(text);

  let rule = null;
  root.walkRules((candidate) => {
    if (!rule && candidate.selector === selector) rule = candidate;
  });
  if (!rule) return { ok: false, error: `${selector} is no longer in ${file}.` };

  const declOf = (prop) => (rule.nodes || []).find((n) => n.type === 'decl' && n.prop === prop);
  const moved = declOf(name);
  if (!moved) return { ok: false, error: `${name} is no longer declared there.` };
  const before = target ? declOf(target) : null;
  if (target && !before) return { ok: false, error: `${target} is no longer declared there.` };

  // A declaration owns its whole line: the indentation in front of it and the
  // newline after it. Taking less leaves a blank line behind and lands the
  // moved line inside another one.
  const lineSpan = (node) => {
    const start = node.source.start.offset;
    // postcss ends a declaration on its last character, which for a line that
    // ends in a newline IS that newline — so the search for the end of the line
    // starts there, not after it, or the span swallows the line below.
    const end = node.source.end.offset;
    const lineStart = text.lastIndexOf('\n', start - 1) + 1;
    const nextLine = text.indexOf('\n', end);
    return { from: lineStart, to: nextLine === -1 ? text.length : nextLine + 1 };
  };

  const span = lineSpan(moved);
  const line = text.slice(span.from, span.to);
  // Landing in front of a declaration is not enough on its own: a group ends at
  // a COMMENT, and "in front of the next declaration" steps over that comment
  // and into the next group. So a drop at the end of a group says where it
  // means, as an offset — the start of the line the variable should land above,
  // comment or not.
  const at = typeof landAt === 'number'
    ? text.lastIndexOf('\n', Math.max(0, Math.min(landAt, text.length)) - 1) + 1
    : before
      ? lineSpan(before).from
      : lineSpan((rule.nodes || []).filter((n) => n.type === 'decl').pop()).to;

  // Cut first, then insert at a position corrected for the cut.
  const withoutLine = text.slice(0, span.from) + text.slice(span.to);
  const insertAt = at > span.from ? at - (span.to - span.from) : at;
  const next = withoutLine.slice(0, insertAt) + line + withoutLine.slice(insertAt);
  if (next === text) return { ok: true, changed: false };
  fs.writeFileSync(abs, next, 'utf8');
  return { ok: true, changed: true };
}

/**
 * Moves a whole group — the comment that heads it and every declaration under
 * it — to sit in front of another group's first declaration, or to the end of
 * the rule. Same idea as moving one row, except that a group is several lines
 * that are not always next to each other (a family's names interleave), so they
 * are cut out and re-inserted together, in the order they were in.
 */
function moveSection(projectPath, { file, selector, names, target }) {
  const abs = path.resolve(projectPath, file);
  const text = fs.readFileSync(abs, 'utf8');
  const root = postcss.parse(text);

  let rule = null;
  root.walkRules((candidate) => {
    if (!rule && candidate.selector === selector) rule = candidate;
  });
  if (!rule) return { ok: false, error: `${selector} is no longer in ${file}.` };

  const nodes = rule.nodes || [];
  const declOf = (prop) => nodes.find((n) => n.type === 'decl' && n.prop === prop);
  const lineSpan = (node) => {
    const start = node.source.start.offset;
    const end = node.source.end.offset;
    const lineStart = text.lastIndexOf('\n', start - 1) + 1;
    const nextLine = text.indexOf('\n', end);
    return { from: lineStart, to: nextLine === -1 ? text.length : nextLine + 1 };
  };

  const decls = names.map(declOf).filter(Boolean);
  if (!decls.length) return { ok: false, error: 'Those variables are no longer declared there.' };

  const spans = decls.map(lineSpan);
  // The comment above the first one is the group's name — it goes too.
  const firstAt = nodes.indexOf(decls[0]);
  const heading = firstAt > 0 && nodes[firstAt - 1].type === 'comment' ? nodes[firstAt - 1] : null;
  if (heading) spans.unshift(lineSpan(heading));

  spans.sort((a, b) => a.from - b.from);
  // The blank line under a group belongs to it — leaving it behind closes the
  // gap where the group was and glues the group to whatever it lands on.
  const last = spans[spans.length - 1];
  const blank = text.slice(last.to).match(/^[ \t]*\r?\n/);
  if (blank) last.to += blank[0].length;
  let block = spans.map((s) => text.slice(s.from, s.to)).join('');

  const landing = target ? declOf(target) : null;
  if (target && !landing) return { ok: false, error: `${target} is no longer declared there.` };
  // In front of the target group's own heading, if it has one.
  const landingAt = landing ? nodes.indexOf(landing) : -1;
  const landingHeading =
    landingAt > 0 && nodes[landingAt - 1].type === 'comment' ? nodes[landingAt - 1] : null;
  const at = landing
    ? lineSpan(landingHeading || landing).from
    : lineSpan(nodes.filter((n) => n.type === 'decl').pop()).to;
  // At the end of the rule there is nothing to separate from below, so the
  // group keeps its gap above instead of leaving one before the closing brace.
  if (!landing) block = block.replace(/(?:[ \t]*\r?\n)+$/, '\n').replace(/^/, '\n');
  // Landing in front of another group, it needs a gap under it — the group it
  // came from may not have had one to bring along.
  else if (!/\n[ \t]*\r?\n$/.test(block)) block += '\n';

  // Cut from the bottom up so the offsets above stay valid, then insert at the
  // target corrected for everything removed before it.
  let out = text;
  for (const span of [...spans].reverse()) out = out.slice(0, span.from) + out.slice(span.to);
  const removedBefore = spans.reduce((sum, s) => (s.to <= at ? sum + (s.to - s.from) : sum), 0);
  const insertAt = at - removedBefore;
  const next = out.slice(0, insertAt) + block + out.slice(insertAt);
  if (next === text) return { ok: true, changed: false };
  fs.writeFileSync(abs, next, 'utf8');
  return { ok: true, changed: true };
}

/**
 * Adds a declaration to a rule, under the group it belongs to. `after` is the
 * name it should follow — the last variable of that group — so a new one lands
 * at the bottom of its own group rather than at the bottom of the rule, which
 * for a file like this would be two hundred lines away from what it belongs to.
 */
function addVariable(projectPath, { file, selector, name, value = '', after }) {
  const abs = path.resolve(projectPath, file);
  const text = fs.readFileSync(abs, 'utf8');
  const root = postcss.parse(text);

  let rule = null;
  root.walkRules((candidate) => {
    if (!rule && candidate.selector === selector) rule = candidate;
  });
  if (!rule) return { ok: false, error: `${selector} is no longer in ${file}.` };

  const decls = (rule.nodes || []).filter((n) => n.type === 'decl');
  if (decls.some((d) => d.prop === name)) {
    return { ok: false, error: `${name} is already declared in ${selector}.` };
  }

  const previous = (after && decls.find((d) => d.prop === after)) || decls[decls.length - 1] || null;
  const indentOf = (node) => {
    const start = node.source.start.offset;
    return text.slice(text.lastIndexOf('\n', start - 1) + 1, start);
  };
  const line = `${previous ? indentOf(previous) : '  '}${name}: ${value};\n`;

  let at;
  if (previous) {
    const end = previous.source.end.offset;
    const nextLine = text.indexOf('\n', end);
    at = nextLine === -1 ? text.length : nextLine + 1;
  } else {
    // An empty rule: just inside the brace.
    at = text.indexOf('{', rule.source.start.offset) + 2;
  }

  fs.writeFileSync(abs, text.slice(0, at) + line + text.slice(at), 'utf8');
  return { ok: true, name };
}


// --- renaming ----------------------------------------------------------------
//
// A custom property's name is not kept anywhere but in the text: it is the
// declaration `--brand: …` and every `var(--brand)` that reads it, spread across
// however many stylesheets and components the project has. So a rename is one
// substitution over all of them, and it either happens everywhere or the name is
// silently broken somewhere the panel cannot show.
//
// Groups are not stored either — the panel derives them from shared name
// prefixes (see prefixSections), so renaming a group is renaming each of its
// members. Both arrive here as a list of renames applied in a single pass, which
// is also what makes a swap (`a`→`b`, `b`→`a`) come out right instead of
// collapsing into one name.

// Where a name can be written. CSS files hold most of them; an Astro component
// keeps its rules in a `<style>` block, and a `style="--x: 1"` can sit in markup
// or a template — a token spelled `--x` in any of these is that variable.
const RENAME_EXTS = /\.(css|s[ac]ss|less|pcss|postcss|astro|html|htm|md|mdx|mdoc|svelte|vue|jsx|tsx|[cm]?[jt]s)$/i;

/**
 * Every file in the project that could spell a variable's name.
 *
 * The panel READS variables from `src`, `public` and `styles` — that is where a
 * project keeps its stylesheets. References are not so tidy: a `style` attribute
 * in a layout, a `--x` in a Tailwind or Astro config at the root, a themed
 * string in a helper module. So this walks the project rather than those three
 * roots, and skips only what is not the project's own text (dependencies, build
 * output, version control, caches).
 *
 * Broad on purpose. A missed reference is a variable that silently stops
 * resolving somewhere the panel cannot see, which is the failure that has no
 * symptom until someone looks at the page.
 */
function findRenameTargets(projectPath) {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 10) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      // Dotted directories are caches and version control; a dotted FILE at the
      // root can still be a config that names a variable (`.postcssrc`), so the
      // skip is for directories only.
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
        walk(path.join(dir, entry.name), depth + 1);
      } else if (RENAME_EXTS.test(entry.name)) {
        found.push(path.join(dir, entry.name));
      }
    }
  };
  walk(projectPath, 0);
  return [...new Set(found)].sort();
}

/** A custom property name, as a name and not as a prefix of a longer one. */
const NAME_RE = /^--[^\s:;{}()'"\\,]+$/;
// `--space` must not match inside `--space-2` or `--x--space`, in either
// direction — the parts of a name are separated by hyphens, so a hyphen on
// either side is part of a longer name rather than a boundary.
const EDGE = '[-\\w\\u00a0-\\uffff]';

/**
 * Renames custom properties across the project — declarations and references
 * alike, in one pass.
 *
 * `renames` is [{ from, to }]; `markWrite` is called with each file about to be
 * written. Everything is checked before anything is written:
 * a rename that would land on a name already in use, or that is not a name at
 * all, takes the whole batch down rather than leaving a group half renamed.
 */
function renameVariables(projectPath, { renames, markWrite }) {
  const list = (renames || []).filter((r) => r && r.from !== r.to);
  if (!list.length) return { ok: true, files: 0, occurrences: 0 };

  const froms = new Set();
  const tos = new Set();
  for (const { from, to } of list) {
    if (!NAME_RE.test(String(from || ''))) return { ok: false, error: `${from} is not a variable name.` };
    if (!NAME_RE.test(String(to || ''))) {
      return { ok: false, error: `"${String(to || '').replace(/^--/, '')}" cannot be a variable name.` };
    }
    if (froms.has(from)) return { ok: false, error: `${from} is renamed twice in one go.` };
    if (tos.has(to)) return { ok: false, error: `Two variables would both be called ${to}.` };
    froms.add(from);
    tos.add(to);
  }

  // Taken names, minus the ones this batch is freeing up: renaming a group means
  // every member moves at once, and a swap within it is legitimate.
  const declared = new Set();
  for (const abs of findStylesheets(projectPath)) {
    let text;
    try {
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    for (const m of text.matchAll(/(^|[;{}\s])(--[^\s:;{}()'"\\,]+)\s*:/g)) declared.add(m[2]);
  }
  for (const to of tos) {
    if (declared.has(to) && !froms.has(to)) {
      return { ok: false, error: `${to} already exists.` };
    }
  }

  const by = new Map(list.map(({ from, to }) => [from, to]));
  // One alternation over every name being renamed, longest first — so that with
  // both `--a` and `--a-b` in the batch, `--a-b` is the one that matches.
  const alternation = [...by.keys()]
    .sort((a, b) => b.length - a.length)
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  const re = new RegExp(`(?<!${EDGE})(${alternation})(?!${EDGE})`, 'g');

  const writes = [];
  let occurrences = 0;
  for (const abs of findRenameTargets(projectPath)) {
    let text;
    try {
      if (fs.statSync(abs).size > MAX_BYTES) continue;
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    let hits = 0;
    const next = text.replace(re, (match) => {
      hits += 1;
      return by.get(match) ?? match;
    });
    if (!hits) continue;
    occurrences += hits;
    writes.push([abs, next]);
  }

  // Written only once every file has been read and rewritten in memory: a
  // half-applied rename is worse than a refused one. Each file is announced as
  // the app's own write just before it happens, so the watcher does not read it
  // back as somebody editing the project from outside.
  for (const [abs, next] of writes) {
    markWrite?.(abs);
    fs.writeFileSync(abs, next, 'utf8');
  }
  return { ok: true, files: writes.length, occurrences };
}

module.exports = {
  readVariables,
  renameVariables,
  setSectionTitle,
  removeSection,
  addSection,
  moveHeading,
  setVariable,
  moveVariable,
  moveSection,
  addVariable,
  readDeclarations,
  findFamilies,
  groupRules,
  labelForRule,
  findStylesheets,
};
