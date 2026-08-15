// Where an asset value points, and what to write when one is picked.
//
// A path to an image is written differently depending on where it lives and
// what reads it: a file in public/ is a rooted URL ("/logo.svg"), while one in
// src/ is referenced relative to the file that names it
// ("../assets/hero.png" from src/data/authors.json — the form Astro's
// `image()` schema wants), or through the "~/" and "@/" aliases a project may
// have configured. And plenty of values name nothing in the project at all,
// because the image is hosted somewhere else.
//
// Everything here works in project-relative rels ("public/logo.svg",
// "src/assets/hero.png") — the same strings `assets:list` returns.

export const isExternalAsset = (value) => {
  const v = String(value ?? '').trim();
  return /^(https?:)?\/\//.test(v) || /^(data|blob):/i.test(v);
};

// Collapses "." and ".." segments. Null when the path climbs out of the
// project, which no asset does.
const normalizeRel = (rel) => {
  const out = [];
  for (const seg of String(rel).split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (!out.length) return null;
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.length ? out.join('/') : null;
};

// The rels a value could name, best guess first. More than one only for a
// bare relative path ("hero.png"), which reads as a sibling of the file that
// wrote it but is just as likely to mean public/.
//
// `baseDir` is the project-relative directory of the file the value lives in
// ("src/data"); without it a relative value can only be a public/ path.
export function assetRelCandidates(value, baseDir) {
  const raw = String(value ?? '').trim();
  if (!raw || isExternalAsset(raw)) return [];
  const p = raw.split(/[?#]/)[0].replace(/\\/g, '/');
  if (!p) return [];
  // mailto:, tel:, blob: — anything with a scheme names no file here.
  if (/^[a-z][a-z0-9+.-]*:/i.test(p)) return [];

  const alias = p.match(/^[@~]\/(.+)$/);
  if (alias) return [normalizeRel(`src/${alias[1]}`)].filter(Boolean);

  if (p.startsWith('/')) {
    // Rooted paths are served out of public/, with one exception: "/src/…" is
    // the source tree, which is how a dev server hands back an unprocessed
    // file.
    const rooted = p.startsWith('/src/') ? p.slice(1) : `public${p}`;
    return [normalizeRel(rooted)].filter(Boolean);
  }

  if (/^(public|src)\//.test(p)) return [normalizeRel(p)].filter(Boolean);

  // Explicitly relative ("./x.png", "../assets/x.png") is only ever relative
  // to the file — it never means public/.
  const explicit = /^\.\.?\//.test(p);
  const guesses = [];
  if (baseDir) guesses.push(normalizeRel(`${baseDir}/${p}`));
  if (!explicit || !baseDir) guesses.push(normalizeRel(`public/${p}`));
  return guesses.filter(Boolean);
}

// The single rel a value most likely names, for messages and for opening the
// picker in the right folder.
export const assetRelOf = (value, baseDir) => assetRelCandidates(value, baseDir)[0] || null;

// "src/data" + "src/assets/a.png" → "../assets/a.png".
export function relativeAssetPath(fromDir, toRel) {
  const from = String(fromDir || '').split('/').filter(Boolean);
  const to = String(toRel || '').split('/').filter(Boolean);
  let i = 0;
  while (i < from.length && i < to.length && from[i] === to[i]) i++;
  const up = from.slice(i).map(() => '..');
  const rest = to.slice(i).join('/');
  return up.length ? `${up.join('/')}/${rest}` : `./${rest}`;
}

// What to write into the file for a picked asset: a rooted URL for public/,
// and a path relative to the file for anything under src/, which is the only
// form a bundler can follow back to the original.
export function assetValueFor(pickedRel, baseDir) {
  const rel = String(pickedRel || '').replace(/^\/+/, '');
  if (rel.startsWith('public/')) return `/${rel.slice('public/'.length)}`;
  if (baseDir) return relativeAssetPath(baseDir, rel);
  return `/${rel}`;
}
