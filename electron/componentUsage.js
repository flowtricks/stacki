// Where a component is used.
//
// The palette says "23 instances" — a number the panel works out by counting
// `<Name` across every .astro file under src. That count is the interesting
// half of a question it doesn't answer: 23 instances WHERE. Same count, same
// regex, now with the files it came from, so the number can be opened.
//
// Matched the way the count is matched, deliberately: if the two disagreed, the
// list would be missing something the number promised, and nothing would say
// which of them was lying.

const fs = require('fs');
const path = require('path');
const { aliasMap, boundNames, resolveSpec } = require('./cmsRefs');

const toPosix = (p) => p.split(path.sep).join('/');

/** Every file that can hold an instance: .astro anywhere, and markdown pages,
 *  which render components too. The same set the palette's own count walks. */
function astroFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.astro') || (d.includes(`${path.sep}pages`) && /\.mdx?$/i.test(entry.name))) {
        out.push(full);
      }
    }
  };
  walk(dir);
  return out;
}

/**
 * The markup, without the frontmatter above it — where instances actually are.
 *
 * A component's own code talks about itself: Lumos's Card.astro carries three
 * `console.warn('[lumos] <Card variant="…">…')` lines, and counting the file's
 * text as a whole read those as three more cards on the page. The number in the
 * palette was the number of times the name appeared, which is not the same
 * thing as the number of times the component is used.
 */
function templateOf(source) {
  return String(source ?? '').replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/, '');
}

/** How many times `source` uses `<Name …>`. Closing tags and frontmatter code
 *  don't count. */
function countIn(source, name) {
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(String(name || ''))) return 0;
  return (templateOf(source).match(new RegExp(`<${name}[\\s/>]`, 'g')) || []).length;
}

const IMPORT_RE = /^[ \t]*import\s+([^;'"]*?)\s+from\s*['"]([^'"]+)['"]/gm;

/**
 * What each import in a file brings in, as `{ names, candidates }`.
 *
 * A tag is a local binding, not a filename. Every page in a Lumos project says
 *
 *   import Layout from "@/layouts/BaseLayout.astro";
 *   <Layout> … </Layout>
 *
 * so counting `<BaseLayout` found nothing and the palette reported 0 instances
 * of a layout on every page in the project. The name to count is whatever THAT
 * file calls it.
 */
function importsOf(source, file, aliases) {
  const out = [];
  IMPORT_RE.lastIndex = 0;
  let m;
  while ((m = IMPORT_RE.exec(String(source))) !== null) {
    const names = boundNames(m[1]);
    if (!names.length) continue;
    const candidates = new Set();
    for (const base of resolveSpec(m[2], file, aliases)) {
      candidates.add(base);
      // A specifier can leave the extension off; components are .astro.
      if (!/\.[a-z]+$/i.test(base)) candidates.add(`${base}.astro`);
    }
    if (candidates.size) out.push({ names, candidates });
  }
  return out;
}

/**
 * How many instances of one component a file holds — counted under the name
 * that file imports it as. A file that doesn't import it falls back to the
 * component's own name: markdown pages and auto-import integrations render
 * components they never name in an import.
 */
function instancesIn(source, { file, targetPath, name, aliases = [] }) {
  const target = targetPath ? path.resolve(targetPath) : null;
  if (target) {
    const imports = importsOf(source, file, aliases);
    const local = [];
    for (const imp of imports) {
      if ([...imp.candidates].some((c) => path.resolve(c) === target)) local.push(...imp.names);
    }
    if (local.length) return local.reduce((n, alias) => n + countIn(source, alias), 0);
    // The name is taken by something else here. `import Section from
    // './ui/Section.astro'` in a file that doesn't use OURS means every
    // `<Section>` on the page belongs to that one, not to this component.
    if (imports.some((imp) => imp.names.includes(name))) return 0;
  }
  return countIn(source, name);
}

/**
 * The files that hold instances of `name`, most-used first, each as
 * `{ rel, path, kind, count }`. `kind` is where the file lives — a page, a
 * layout, or another component — which is how the caller knows whether opening
 * it means going to a page or drilling into a component.
 *
 * The component's own file is left out: a file is not one of its own users, and
 * a recursive component would otherwise list itself above everything else.
 */
function componentUsage({ projectPath, name, exclude }) {
  const src = path.join(projectPath, 'src');
  const skip = exclude ? path.resolve(exclude) : null;
  // `exclude` is the component's own file, which is also the file every other
  // file's import has to resolve to for its local name to count.
  const aliases = aliasMap(projectPath);
  const kindOf = (file) => {
    const rel = toPosix(path.relative(src, file));
    if (rel.startsWith('pages/')) return 'page';
    if (rel.startsWith('layouts/')) return 'layout';
    if (rel.startsWith('components/')) return 'component';
    return 'file';
  };

  const files = [];
  for (const file of astroFiles(src)) {
    if (skip && path.resolve(file) === skip) continue;
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const count = instancesIn(text, { file, targetPath: exclude, name, aliases });
    if (!count) continue;
    files.push({
      rel: toPosix(path.relative(projectPath, file)),
      path: file,
      kind: kindOf(file),
      count,
    });
  }
  // Most instances first, then by name — the file it's really "in" leads.
  files.sort((a, b) => b.count - a.count || a.rel.localeCompare(b.rel));
  return { files, total: files.reduce((n, f) => n + f.count, 0) };
}

module.exports = { componentUsage, countIn, instancesIn, importsOf, templateOf, astroFiles };
