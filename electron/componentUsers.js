// Who still points at a component file.
//
// Answered from the files themselves, at the moment it is asked. The palette's
// own "N instances" is not the same question twice over: it is read at scan
// time and is a moment behind the last edit, and it counts TAGS — a component
// imported by another component but not yet placed reads zero and is very much
// in use.
//
// Getting this wrong is not a cosmetic loss. A page whose import points at a
// file that is gone does not render a gap; it fails to build, and the error
// names the import rather than the thing that was deleted three screens ago.
//
// Kept out of main.js so it can be run against a real directory
// (test/component-users.js) rather than only through the app.

const fs = require('fs');
const path = require('path');

const toPosix = (p) => p.split(path.sep).join('/');

const USE_EXT = /\.(astro|md|mdx|[jt]sx?)$/i;
const USE_SKIP = new Set(['node_modules', 'dist', '.git', '.astro', 'release', '.avb']);

/**
 * Every file under `src/` that places the component as a tag or imports its
 * file, as project-relative paths. The component's own file never counts.
 *
 * Both forms are looked for because either one alone is a way to be wrong: a
 * layout is imported and used as `<Layout>`, a component can be imported and
 * passed around without a tag, and Astro's own `<Fragment set:html>` pages
 * import markup they never tag. The cost of matching too much is a delete
 * refused for a reason the user can go and look at; the cost of matching too
 * little is a site that no longer builds.
 */
function componentUsers(projectPath, componentAbs) {
  const name = path.basename(componentAbs, path.extname(componentAbs));
  const tag = new RegExp(`<${name}[\\s/>]`);
  const spec = new RegExp(`from\\s*['"][^'"]*${name}\\.astro['"]`);
  const self = path.resolve(componentAbs);
  const hits = [];

  const walk = (dir) => {
    let items;
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      if (USE_SKIP.has(item.name) || item.name.startsWith('.')) continue;
      const abs = path.join(dir, item.name);
      if (item.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!USE_EXT.test(item.name) || path.resolve(abs) === self) continue;
      let text;
      try {
        text = fs.readFileSync(abs, 'utf8');
      } catch {
        continue;
      }
      if (tag.test(text) || spec.test(text)) hits.push(toPosix(path.relative(projectPath, abs)));
    }
  };
  walk(path.join(projectPath, 'src'));
  return hits;
}

/** Whether this path is a component or layout file the palette may delete. */
function isDeletableComponent(projectPath, abs) {
  const src = path.resolve(projectPath, 'src');
  const inside = ['components', 'layouts'].some((d) =>
    (abs + path.sep).startsWith(path.join(src, d) + path.sep)
  );
  return inside && /\.astro$/i.test(abs);
}

module.exports = { componentUsers, isDeletableComponent };
