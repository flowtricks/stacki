// The frontmatter a piece of markup depends on, and what happens to it when
// the markup moves.
//
// A page's frontmatter is the code behind what is on it: `import Card from
// '@/components/Card.astro'`, `const jobs = ["Designer", …]`, `const posts =
// await getCollection('blog')`. The markup names those things, and nothing in
// the file says so out loud — so when a piece of markup is deleted, the code it
// was the only reader of stays behind, and when it is pasted into another page,
// the code it needs stays where it came from and the paste renders nothing.
//
// Both are the same question: WHICH NAMES DOES THIS MARKUP READ. Asked of the
// page it left, the answer is what may go; asked of the markup that arrived,
// the answer is what has to come with it.
//
// The answer is a guess, and the two directions want the guess to lean opposite
// ways. Carrying one line too many leaves an unused import; dropping one line
// too many breaks the page. So `namesUsedIn` is generous — a bare word anywhere
// in the code counts — and deleting is refused for anything it cannot be sure
// about.

import { findDeclaration, findImportOf, parseDeclarations } from './dataSuggest.js';

// Words that are the language rather than something the page declared.
const KEYWORDS = new Set([
  'true', 'false', 'null', 'undefined', 'new', 'typeof', 'instanceof', 'in', 'of',
  'await', 'async', 'function', 'return', 'if', 'else', 'for', 'while', 'do',
  'const', 'let', 'var', 'class', 'extends', 'import', 'from', 'export', 'default',
  'this', 'void', 'delete', 'yield', 'try', 'catch', 'finally', 'throw', 'switch',
  'case', 'break', 'continue', 'Astro', 'Math', 'JSON', 'Object', 'Array', 'String',
  'Number', 'Boolean', 'Date', 'Promise', 'Map', 'Set', 'console', 'globalThis',
]);

// Strings are text, not names. A template is both: the words between the holes
// are text and each `${…}` is code, so the literal parts are blanked and the
// holes left standing. Done by walking rather than by a regex, because a
// template can hold a string that holds a backtick, and a pattern that gets
// that wrong turns prose into identifiers — `Since` in `\`Since ${year}\`` was
// read as a name the page might declare.
function blankStrings(code) {
  let out = '';
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      while (i < code.length && code[i] !== quote) i += code[i] === '\\' ? 2 : 1;
      out += ' ';
      continue;
    }
    if (ch === '`') {
      i++;
      let depth = 0;
      while (i < code.length) {
        const c = code[i];
        if (c === '\\') { i += 2; continue }
        if (depth === 0 && c === '`') break;
        if (c === '$' && code[i + 1] === '{') {
          depth++;
          out += ' ';
          i += 2;
          continue;
        }
        if (depth > 0) {
          if (c === '}') { depth--; out += ' '; i++; continue }
          // Inside a hole: code, kept as it is.
          out += c;
          i++;
          continue;
        }
        i++; // literal text between the holes
      }
      out += ' ';
      continue;
    }
    out += ch;
  }
  return out;
}

/** Every identifier a piece of code reads, ignoring strings and property names. */
export function identifiersIn(code) {
  const text = blankStrings(
    String(code || '')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
  );
  const out = new Set();
  const re = /(\.?)\b([A-Za-z_$][\w$]*)\b(\s*:)?/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const [, dot, name, colon] = m;
    if (dot) continue; // a property of something else, not a name of its own
    if (colon && !/\?\s*$/.test(text.slice(0, m.index))) {
      // `key: value` in an object literal — the key is not a reference. A
      // ternary's `:` is, which is what the lookbehind is checking for.
      const before = text.slice(0, m.index);
      if (/[{,]\s*$/.test(before)) continue;
    }
    if (KEYWORDS.has(name)) continue;
    out.add(name);
  }
  return out;
}

/**
 * The names a subtree reads: the components it renders, and every identifier in
 * the code attached to it — prop expressions, loop heads, conditions, `{expr}`
 * nodes.
 */
export function namesUsedIn(nodes) {
  const out = new Set();
  const walk = (list) => {
    for (const node of list || []) {
      // A component is named by being rendered.
      if (node.kind === 'component' && node.name) out.add(node.name);
      if (node.kind === 'expr' || node.kind === 'raw-line') {
        for (const n of identifiersIn(node.value)) out.add(n);
      }
      if (node.kind === 'map') for (const n of identifiersIn(node.head)) out.add(n);
      if (node.kind === 'cond') for (const n of identifiersIn(node.test)) out.add(n);
      if (Array.isArray(node.body)) for (const line of node.body) for (const n of identifiersIn(line)) out.add(n);
      for (const value of Object.values(node.props || {})) {
        if (value && (value.type === 'expr' || value.type === 'spread')) {
          for (const n of identifiersIn(value.value)) out.add(n);
        }
      }
      if (Array.isArray(node.children)) walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

/** The same, for a whole page: its markup plus its own frontmatter code. */
function namesUsedByPage(model) {
  const out = namesUsedIn(model.nodes);
  for (const n of identifiersIn(model.extraFrontmatter || '')) out.add(n);
  return out;
}

// A declaration that is safe to consider removing. Exported ones are the page's
// interface to Astro — `getStaticPaths`, `prerender` — and belong to nobody
// here. A destructure is not matched by the reader at all.
const EXPORTED_RE = (name) =>
  new RegExp(`(^|\\n)[ \\t]*export\\s+(const|let|var)\\s+${name.replace(/\$/g, '\\$')}\\b`);

/**
 * The top-level declarations in a page's frontmatter that nothing on the page
 * reads any more — after the markup that read them has gone.
 *
 * A name still mentioned anywhere in the code counts as read, including by
 * another declaration: `const posts = …` feeding `const featured = posts[0]`
 * keeps `posts` even when the markup only names `featured`.
 */
export function unusedDeclarations(model) {
  const code = String(model.extraFrontmatter || '');
  const declared = parseDeclarations(code);
  if (!declared.size) return [];
  const fromMarkup = namesUsedIn(model.nodes);
  const out = [];
  // Read against the frontmatter with the candidate taken out, so a declaration
  // that only feeds another dead one goes too — a chain of them is as unread as
  // its head. One at a time, longest chain first, is more than this needs: a
  // pass that removes what is dead, repeated until nothing is, says the same
  // thing and cannot loop.
  let rest = code;
  let changed = true;
  const gone = new Set();
  while (changed) {
    changed = false;
    for (const [name] of parseDeclarations(rest)) {
      if (gone.has(name)) continue;
      if (EXPORTED_RE(name).test(rest)) continue;
      if (fromMarkup.has(name)) continue;
      const found = findDeclaration(rest, name);
      if (!found) continue;
      const without = rest.slice(0, found.start) + rest.slice(found.end);
      // Anywhere else in the frontmatter — including inside a string, which is
      // where a name in a template can hide.
      if (new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`).test(without)) continue;
      out.push({ name, statement: found.statement });
      gone.add(name);
      rest = without;
      changed = true;
    }
  }
  return out;
}

/** A frontmatter with those declarations taken out, and the gap closed up. */
export function withoutDeclarations(code, names) {
  let out = String(code || '');
  for (const name of names) {
    const found = findDeclaration(out, name);
    if (!found) continue;
    const before = out.slice(0, found.start);
    const after = out.slice(found.end);
    // The line the statement sat on goes with it, rather than leaving a blank
    // one where it was.
    out = before.replace(/[ \t]*$/, '') + after.replace(/^[ \t]*\r?\n/, '');
  }
  return out.replace(/\n{3,}/g, '\n\n');
}

/**
 * What a piece of markup needs from the page it came from, given the names it
 * reads: the imports that bring them in and the declarations that make them,
 * closed over what THOSE need in turn.
 *
 * `has` says what the page being pasted into already has — a name it already
 * knows is its own, and is left alone rather than overwritten.
 */
export function neededFrontmatter({ names, frontmatter, imports, has }) {
  const known = has || (() => false);
  const code = String(frontmatter || '');
  const declared = parseDeclarations(code);
  const wantedImports = [];
  const statements = [];
  const seen = new Set();
  const queue = [...(names || [])];
  while (queue.length) {
    const name = queue.shift();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    if (known(name)) continue;
    const imported = (imports || []).find((i) => i.name === name) || findImportOf(code, name);
    if (imported) {
      wantedImports.push({ name, path: imported.path || imported.spec });
      continue;
    }
    if (!declared.has(name)) continue;
    const found = findDeclaration(code, name);
    if (!found) continue;
    statements.push({ name, statement: found.statement });
    // What that declaration reads in turn.
    for (const n of identifiersIn(found.value)) queue.push(n);
  }
  // In the order the file wrote them, so what arrives reads like what was left
  // behind rather than like a list of dependencies.
  statements.sort((a, b) => code.indexOf(a.statement) - code.indexOf(b.statement));
  return { imports: wantedImports, statements };
}

/** The frontmatter with those statements added at the end. */
export function withStatements(code, statements) {
  const lines = (statements || []).map((s) => s.statement).filter(Boolean);
  if (!lines.length) return String(code || '');
  const base = String(code || '').replace(/\s*$/, '');
  return base ? `${base}\n${lines.join('\n')}` : lines.join('\n');
}

export { namesUsedByPage };
