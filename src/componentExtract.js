// Reading a block of a page well enough to lift it out of one.
//
// Extraction turns a subtree into its own .astro file. Everything here answers
// one of the two questions that makes that safe:
//
//   can it go?   A block that reads a loop's item, a const from the page's
//                frontmatter, or Astro.props is finished by the page around
//                it. The same markup in a file of its own renders undefined,
//                silently, at build time. So the references are found first
//                and the extraction is refused by name.
//
//   what goes    The imports the block still needs, and nothing else — a page
//   with it?     usually imports more than any one of its blocks uses.
//
// Kept out of App.jsx so both questions can be asked in a test against real
// parsed pages (test/create-component.js) rather than only through the UI.

/**
 * Whether `expr` reads from the variable `v` (`service`, `service.tags`) — not
 * merely contains its letters (`services`, `x.service`).
 */
export const readsVar = (expr, v) =>
  new RegExp(`(^|[^\\w$.])${v}\\b`).test(String(expr || ''));

/**
 * Comments in the frontmatter are prose about the page, and prose names the
 * things the page is built from — `// Hero copy` is talk about <Hero>, not a
 * use of it. Only whole-line `//` comments go: a trailing one can't be told
 * from the `//` inside a URL without really parsing, and cutting a string in
 * half there would hide a reference that is real.
 */
export function stripComments(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/**
 * Everything in ONE subtree that is code rather than markup — the same reading
 * codeText does for a whole page, over a node and its children.
 *
 * Text is included, unlike in codeText, because an interpolation lives inside a
 * text node (`Hello {name}`) and `name` is exactly the kind of reference that
 * decides whether this block can leave the page.
 */
export function codeInSubtree(node) {
  const parts = [];
  const walk = (n) => {
    if (n.kind === 'expr' || n.kind === 'raw-line' || n.kind === 'text') parts.push(n.value || '');
    if (n.kind === 'map') parts.push(n.head || '');
    if (n.kind === 'cond') parts.push(n.test || '');
    for (const v of Object.values(n.props || {})) {
      if (v && (v.type === 'expr' || v.type === 'spread')) parts.push(String(v.value ?? ''));
    }
    if (Array.isArray(n.children)) n.children.forEach(walk);
  };
  walk(node);
  return parts.join('\n');
}

/**
 * The names a page's frontmatter declares: consts, lets, functions, and the
 * props destructured off Astro.props.
 *
 * Deliberately shallow — it reads the left-hand side of top-level declarations
 * and nothing else. The cost of missing one is an extraction that should have
 * been refused, so the patterns cover the forms a page actually uses; the cost
 * of a false positive is a refusal, which is recoverable by renaming.
 */
export function frontmatterBindings(code) {
  const names = new Set();
  const src = stripComments(String(code || ''));
  const decl = /(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g;
  const fn = /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g;
  // `const { title, items = [] } = Astro.props` and plain object/array patterns.
  // Lazy up to the bracket that is actually followed by `=`, not the first one
  // seen: a default value brings its own brackets (`items = []`), and stopping
  // at those matched nothing at all — the whole line went unread, which is the
  // line most likely to hold what a block depends on.
  const destructured =
    /(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s*([{[][\s\S]*?[}\]])\s*=/g;
  let m;
  while ((m = decl.exec(src)) !== null) names.add(m[1]);
  while ((m = fn.exec(src)) !== null) names.add(m[1]);
  while ((m = destructured.exec(src)) !== null) {
    for (const piece of m[1].slice(1, -1).split(',')) {
      // `a: b = 1` binds b; `a = 1` binds a; `...rest` binds rest.
      const bound = piece.includes(':') ? piece.slice(piece.indexOf(':') + 1) : piece;
      const name = bound.replace(/\.\.\./, '').split('=')[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  return [...names];
}

/**
 * What the block still needs from the page around it, in the order a sentence
 * would name them. Empty means it can stand on its own.
 *
 * A dynamic tag (`const Tag = tag` then `<Tag>`) is a frontmatter binding used
 * as an element rather than in an expression, so it is looked for as a tag too
 * — otherwise a block built around one extracts into a file where `Tag` is
 * nothing, and Astro renders an empty `<undefined>`.
 */
export function externalNeeds({ node, code, loopVars = [], frontmatter = '' }) {
  const text = code ?? codeInSubtree(node);
  const dynamic = new Set();
  if (node) {
    const walk = (n) => {
      if (n.kind === 'component' && n.dynamicTag && n.name) dynamic.add(n.name);
      if (Array.isArray(n.children)) n.children.forEach(walk);
    };
    walk(node);
  }
  const declared = frontmatterBindings(frontmatter);
  return [
    ...loopVars.filter((v) => readsVar(text, v)),
    ...declared.filter((n) => readsVar(text, n) || dynamic.has(n)),
    ...(/\bAstro\.props\b/.test(text) ? ['Astro.props'] : []),
  ];
}

/** The component names a subtree puts on the page, so their imports travel with it. */
export function componentNamesIn(node) {
  const names = new Set();
  const walk = (n) => {
    if (n.kind === 'component' && n.name && !n.dynamicTag) names.add(n.name);
    if (Array.isArray(n.children)) n.children.forEach(walk);
  };
  walk(node);
  return names;
}

/**
 * A first suggestion for the new component's name, read off the thing itself:
 * its first class if it has one (`hero-card` → `HeroCard`), otherwise its tag.
 * Only ever a suggestion — the field it lands in is what decides.
 */
export function suggestedComponentName(node) {
  const cls = node?.props?.class;
  const first =
    cls && cls.type === 'string' ? String(cls.value || '').trim().split(/\s+/)[0] : '';
  const source = first || node?.name || '';
  const pascal = String(source)
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join('');
  return /^[A-Z]/.test(pascal) ? pascal : '';
}
