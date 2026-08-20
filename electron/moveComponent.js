// Moving a component file, and keeping every import that points at it pointing
// at it.
//
// The asymmetry with pages is the whole reason this exists. `page:move` rewrites
// the imports the moved file CONTAINS, because nothing imports a page. A
// component is the other way round: everything imports it, and moving one into
// a folder breaks every `import Hero from '../components/Hero.astro'` in the
// project. The site does not render a gap — it fails to build, naming an import
// rather than the drag that caused it.
//
// So both directions are rewritten:
//
//   the file's own    `./Button.astro` from src/components/ is `../Button.astro`
//                     once it sits in src/components/marketing/
//   everyone else's   a page's `../components/Hero.astro` becomes
//                     `../components/marketing/Hero.astro`, and an aliased
//                     `@/components/Hero.astro` keeps its alias and changes
//                     only the part under it
//
// Nothing is written until every rewrite has been worked out. A half-applied
// move is a project that neither builds nor can be undone by dragging it back.

const fs = require('fs');
const path = require('path');
const { aliasMap, walkCodeFiles, IMPORT_RE } = require('./cmsRefs');

const toPosix = (p) => p.split(path.sep).join('/');

const relSpec = (fromDir, toAbs) => {
  const rel = toPosix(path.relative(fromDir, toAbs));
  return rel.startsWith('.') ? rel : `./${rel}`;
};

// Where a spec points, and — when it got there through an alias — which alias
// and which of its bases, so the rewrite can keep the spelling the author chose
// instead of turning everyone's aliases into relative paths.
function matchSpec(spec, fromFile, aliases) {
  if (spec.startsWith('.')) {
    return { resolved: path.resolve(path.dirname(fromFile), spec), alias: null };
  }
  for (const alias of aliases) {
    if (alias.wildcard ? spec.startsWith(alias.prefix) : spec === alias.prefix) {
      const rest = spec.slice(alias.prefix.length);
      for (const base of alias.targets) {
        // Only a wildcard alias has a path under it to rewrite. A bare one
        // (`"@hero": ["src/components/Hero.astro"]`) names the file itself, and
        // the thing that would have to change is the tsconfig.
        if (!alias.wildcard) return { resolved: path.resolve(base, rest), alias, base, bare: true };
        return { resolved: path.resolve(base, rest), alias, base };
      }
    }
  }
  return { resolved: null, alias: null }; // a package specifier
}

// An import may be written with the extension or without it. Both point at the
// same file, and the rewrite has to give back the same spelling — adding
// `.astro` to a project that writes them off would be a diff in every file it
// touched.
function pointsAt(resolved, targetAbs) {
  if (!resolved) return null;
  if (path.resolve(resolved) === path.resolve(targetAbs)) return { extension: true };
  if (path.resolve(resolved + path.extname(targetAbs)) === path.resolve(targetAbs)) {
    return { extension: false };
  }
  return null;
}

const specFor = (fromFile, toAbs, match, keepExtension) => {
  const target = keepExtension ? toAbs : toAbs.slice(0, -path.extname(toAbs).length);
  if (!match.alias) return relSpec(path.dirname(fromFile), target);
  return match.alias.prefix + toPosix(path.relative(match.base, target));
};

/**
 * What moving `fromAbs` to `toAbs` would rewrite, without touching anything.
 *
 *   { file, files: [{ file, rel, next }], bare: [rel] }
 *
 * `file` is the moved source itself, already re-aimed. `files` is every other
 * file that had to change. `bare` names importers reaching it through a
 * non-wildcard alias, which no rewrite here can fix — the alias itself is what
 * points at the old path, and it lives in tsconfig.
 */
function planMove(projectPath, fromAbs, toAbs) {
  const aliases = aliasMap(projectPath);
  const from = path.resolve(fromAbs);
  const to = path.resolve(toAbs);
  const files = [];
  const bare = [];

  // The moved file's own relative imports, seen from where it is going.
  let moved = fs.readFileSync(from, 'utf8');
  if (path.dirname(from) !== path.dirname(to)) {
    moved = moved.replace(
      /(import\s[^'"]*?from\s*['"])(\.\.?\/[^'"]+)(['"])/g,
      (m, pre, spec, post) => `${pre}${relSpec(path.dirname(to), path.resolve(path.dirname(from), spec))}${post}`
    );
  }

  for (const file of walkCodeFiles(path.join(projectPath, 'src'))) {
    if (path.resolve(file) === from) continue;
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (!text.includes('import')) continue;
    let touched = false;
    let sawBare = false;
    const next = text.replace(IMPORT_RE, (match, indent, clause, spec) => {
      const found = matchSpec(spec, file, aliases);
      const hit = pointsAt(found.resolved, from);
      if (!hit) return match;
      if (found.bare) {
        sawBare = true;
        return match;
      }
      touched = true;
      return match.replace(spec, specFor(file, to, found, hit.extension));
    });
    if (sawBare) bare.push(toPosix(path.relative(projectPath, file)));
    if (touched) {
      files.push({ file, rel: toPosix(path.relative(projectPath, file)), next });
    }
  }

  return { file: { file: to, source: moved }, files, bare };
}

/** Apply a plan. Everything is worked out before anything is written. */
function applyMove(projectPath, fromAbs, toAbs, plan, markSelfWrite = () => {}) {
  const from = path.resolve(fromAbs);
  const to = path.resolve(toAbs);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  for (const hit of plan.files) {
    markSelfWrite(hit.file);
    fs.writeFileSync(hit.file, hit.next, 'utf8');
  }
  markSelfWrite(to);
  fs.writeFileSync(to, plan.file.source, 'utf8');
  markSelfWrite(from);
  fs.rmSync(from);
  return { newPath: to, rewritten: plan.files.map((h) => h.rel), bare: plan.bare };
}

module.exports = { planMove, applyMove };
