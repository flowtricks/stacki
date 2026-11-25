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

export const isExternalAsset = (value: unknown): boolean => {
  const text = String(value ?? '').trim();
  return /^(https?:)?\/\//.test(text) || /^(data|blob):/i.test(text);
};

// Collapses "." and ".." segments. Undefined when the path climbs out of the
// project, which no asset does.
const normalizeRel = (rel: string): string | undefined => {
  const out: string[] = [];
  for (const seg of String(rel).split('/')) {
    if (!seg || seg === '.') {
      continue;
    }
    if (seg === '..') {
      if (!out.length) {
        return undefined;
      }
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.length ? out.join('/') : undefined;
};

// The rels a value could name, best guess first. More than one only for a
// bare relative path ("hero.png"), which reads as a sibling of the file that
// wrote it but is just as likely to mean public/.
//
// `baseDirectory` is the project-relative directory of the file the value lives in
// ("src/data"); without it a relative value can only be a public/ path.
export function assetRelCandidates(value: unknown, baseDirectory?: string | undefined): readonly string[] {
  const raw = String(value ?? '').trim();
  if (!raw || isExternalAsset(raw)) {
    return [];
  }
  const path = (raw.split(/[?#]/)[0] ?? '').replace(/\\/g, '/');
  if (!path) {
    return [];
  }
  // mailto:, tel:, blob: — anything with a scheme names no file here.
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) {
    return [];
  }

  const alias = path.match(/^[@~]\/(.+)$/);
  if (alias) {
    return [normalizeRel(`src/${alias[1]}`)].filter((value): value is string => Boolean(value));
  }

  if (path.startsWith('/')) {
    // Rooted paths are served out of public/, with one exception: "/src/…" is
    // the source tree, which is how a dev server hands back an unprocessed
    // file.
    const rooted = path.startsWith('/src/') ? path.slice(1) : `public${path}`;
    return [normalizeRel(rooted)].filter((value): value is string => Boolean(value));
  }

  if (/^(public|src)\//.test(path)) {
    return [normalizeRel(path)].filter((value): value is string => Boolean(value));
  }

  // Explicitly relative ("./x.png", "../assets/x.png") is only ever relative
  // to the file — it never means public/.
  const explicit = /^\.\.?\//.test(path);
  const guesses: (string | undefined)[] = [];
  if (baseDirectory) {
    guesses.push(normalizeRel(`${baseDirectory}/${path}`));
  }
  if (!explicit || !baseDirectory) {
    guesses.push(normalizeRel(`public/${path}`));
  }
  return guesses.filter((value): value is string => Boolean(value));
}

// The single rel a value most likely names, for messages and for opening the
// picker in the right folder.
export const assetRelOf = (value: unknown, baseDirectory?: string): string | undefined => assetRelCandidates(value, baseDirectory)[0] || undefined;

// "src/data" + "src/assets/a.png" → "../assets/a.png".
export function relativeAssetPath(fromDirectory: string | undefined, toRel: string | undefined): string {
  const from = String(fromDirectory || '')
    .split('/')
    .filter((value): value is string => Boolean(value));
  const to = String(toRel || '')
    .split('/')
    .filter((value): value is string => Boolean(value));
  let i = 0;
  while (i < from.length && i < to.length && from[i] === to[i]) {
    i++;
  }
  const up = from.slice(i).map(() => '..');
  const rest = to.slice(i).join('/');
  return up.length ? `${up.join('/')}/${rest}` : `./${rest}`;
}

// What to write into the file for a picked asset: a rooted URL for public/,
// and a path relative to the file for anything under src/, which is the only
// form a bundler can follow back to the original.
export function assetValueFor(pickedRel: string | undefined, baseDirectory?: string | undefined): string {
  const rel = String(pickedRel || '').replace(/^\/+/, '');
  if (rel.startsWith('public/')) {
    return `/${rel.slice('public/'.length)}`;
  }
  if (baseDirectory) {
    return relativeAssetPath(baseDirectory, rel);
  }
  return `/${rel}`;
}
