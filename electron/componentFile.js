// Making a component file out of a piece of a page.
//
// The markup MOVES — the page keeps `<Card />` where the element was — so what
// lands in the new file has to be everything that piece needed to render. Two
// things travel with it:
//
//   the nodes themselves, serialized exactly as the page writes them, and
//   the imports it was leaning on the page to have made.
//
// The second is the one that's easy to forget: an extracted card holding a
// <Button> renders an error, not a button, unless Button comes with it. And an
// import that came along can't simply be copied — a relative path is relative
// to the file it was written in, and the new file is somewhere else.

const fs = require('fs');
const path = require('path');
const { serializePage, serializeNodes } = require('./astroParser');

const toPosix = (p) => p.split(path.sep).join('/');

// A component's name is a filename, an import and a tag all at once — and the
// capital is load-bearing: Astro reads a lowercase tag as an HTML element, so
// `<card />` renders a literal <card> and the component never appears.
const VALID_NAME = /^[A-Z][A-Za-z0-9]*$/;

/**
 * The file to write for a new component, as `{ path, rel, text }`. Throws when
 * the name can't be used — nothing is written here; the caller does that, so
 * every write to the project stays in one place.
 */
function componentFile({ projectPath, pagePath, name, nodes, imports = [], props = [] }) {
  if (!VALID_NAME.test(String(name || ''))) {
    throw new Error('A component name has to be a word starting with a capital letter.');
  }
  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw new Error('Nothing to make a component from.');
  }

  const componentsDir = path.join(projectPath, 'src', 'components');
  const target = path.join(componentsDir, `${name}.astro`);
  // Case-insensitively: on a Mac, Card.astro and card.astro are the same file,
  // and writing the second silently replaces the first.
  const clash = fs.existsSync(componentsDir)
    ? fs.readdirSync(componentsDir).find((f) => f.toLowerCase() === `${name.toLowerCase()}.astro`)
    : null;
  if (clash) {
    throw new Error(`There's already a component called ${path.basename(clash, '.astro')}.`);
  }

  // Which of the page's imports this piece actually uses. Matched against the
  // serialized markup rather than the node kinds, so a name used inside an
  // expression (`{items.map(…)}`, `<Fragment set:html={raw} />`) counts too.
  const markup = serializeNodes(nodes);
  const used = imports.filter(
    (imp) =>
      imp?.name && new RegExp(`(^|[^A-Za-z0-9_$])${imp.name}([^A-Za-z0-9_$]|$)`).test(markup)
  );

  // `@/components/Button.astro` and bare package names mean the same thing from
  // any file and travel untouched. A relative path was written from the page's
  // folder and has to be re-aimed from src/components.
  const pageDir = path.dirname(pagePath);
  const moved = used.map((imp) => {
    const spec = String(imp.path || '');
    if (!spec.startsWith('.')) return { ...imp };
    const rel = toPosix(path.relative(componentsDir, path.resolve(pageDir, spec)));
    return { ...imp, path: rel.startsWith('.') ? rel : './' + rel };
  });

  // The values the piece was reading from the page, now read from its props
  // instead. Astro's own convention, and the one the props panel reads back:
  // a destructure off Astro.props IS the component's interface.
  const names = props.filter((p) => /^[A-Za-z_$][\w$]*$/.test(String(p || '')));
  const extraFrontmatter = names.length ? `const { ${names.join(', ')} } = Astro.props;` : '';

  const text = serializePage({
    imports: moved,
    extraFrontmatter,
    nodes,
    // No imports and no props, no `---` block: a component that needs no
    // frontmatter shouldn't be handed an empty one.
    hadFrontmatter: moved.length > 0 || names.length > 0,
  });

  return { path: target, rel: toPosix(path.relative(projectPath, target)), text };
}

module.exports = { componentFile };
