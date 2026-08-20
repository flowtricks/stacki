// Who still points at a component, asked of a real directory.
//
//   node test/component-users.js
//
// This is the guard on deleting a component from the palette, and it is the
// only thing standing between a click and a site that no longer builds. A page
// whose import names a file that is gone does not render a gap: Astro fails the
// build, and the message names the import rather than the component deleted
// three screens earlier.
//
// So the ways of using a component that are easy to forget are what this
// covers — imported by another component rather than a page, used by a layout,
// imported without ever being tagged, named by a similar longer name that must
// NOT count.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { componentUsers, isDeletableComponent } = require('../electron/componentUsers.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};

const projects = [];
function project(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-users-'));
  projects.push(dir);
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text, 'utf8');
  }
  return dir;
}

const HERO = 'src/components/Hero.astro';

{
  const dir = project({
    [HERO]: '---\n---\n<section>hi</section>\n',
    'src/pages/index.astro': "---\nimport Hero from '../components/Hero.astro';\n---\n<Hero />\n",
  });
  const users = componentUsers(dir, path.join(dir, HERO));
  check('a page that places it counts', users.includes('src/pages/index.astro'), users.join(','));
}

{
  // The case the palette's tag count misses entirely.
  const dir = project({
    [HERO]: '---\n---\n<section>hi</section>\n',
    'src/components/Wrapper.astro': "---\nimport Hero from './Hero.astro';\nconst pick = Hero;\n---\n<div />\n",
  });
  const users = componentUsers(dir, path.join(dir, HERO));
  check(
    'so does a file that imports it without ever tagging it',
    users.includes('src/components/Wrapper.astro'),
    users.join(',')
  );
}

{
  const dir = project({
    'src/layouts/Base.astro': '---\n---\n<html><slot /></html>\n',
    'src/pages/about.astro': "---\nimport Base from '../layouts/Base.astro';\n---\n<Base>x</Base>\n",
  });
  const users = componentUsers(dir, path.join(dir, 'src/layouts/Base.astro'));
  check('a layout a page wraps in counts', users.length === 1, users.join(','));
}

{
  const dir = project({
    [HERO]: '---\n---\n<section>hi</section>\n',
    'src/pages/index.astro': "---\nimport HeroBanner from '../components/HeroBanner.astro';\n---\n<HeroBanner />\n",
    'src/components/HeroBanner.astro': '---\n---\n<div />\n',
  });
  const users = componentUsers(dir, path.join(dir, HERO));
  check('a longer name that merely starts the same does not', users.length === 0, users.join(','));
}

{
  const dir = project({
    [HERO]: "---\n---\n<section>Hero, and <Hero /> would be a loop</section>\n",
  });
  const users = componentUsers(dir, path.join(dir, HERO));
  check('the file never counts as its own user', users.length === 0, users.join(','));
}

{
  const dir = project({
    [HERO]: '---\n---\n<section>hi</section>\n',
    'src/content/post.md': '---\ntitle: x\n---\nSome prose about a Hero.\n',
  });
  const users = componentUsers(dir, path.join(dir, HERO));
  check('prose that merely says the word does not', users.length === 0, users.join(','));
}

{
  const dir = project({
    [HERO]: '---\n---\n<section>hi</section>\n',
    'src/content/post.mdx': "import Hero from '../components/Hero.astro';\n\n<Hero />\n",
  });
  const users = componentUsers(dir, path.join(dir, HERO));
  check('but an mdx entry that imports it does', users.length === 1, users.join(','));
}

{
  const dir = project({
    [HERO]: '---\n---\n<section>hi</section>\n',
    'node_modules/pkg/index.astro': '<Hero />\n',
    'dist/index.html': '<Hero />\n',
  });
  const users = componentUsers(dir, path.join(dir, HERO));
  check('nothing outside src is read', users.length === 0, users.join(','));
}

{
  const dir = project({ [HERO]: '---\n---\n<div />\n' });
  check('a component is deletable', isDeletableComponent(dir, path.join(dir, HERO)));
  check(
    'a layout is too',
    isDeletableComponent(dir, path.join(dir, 'src/layouts/Base.astro'))
  );
  check(
    'a page is not',
    !isDeletableComponent(dir, path.join(dir, 'src/pages/index.astro'))
  );
  check(
    'nor is a stylesheet that happens to sit in components',
    !isDeletableComponent(dir, path.join(dir, 'src/components/theme.css'))
  );
  check(
    'nor anything outside src',
    !isDeletableComponent(dir, path.join(dir, 'astro.config.mjs'))
  );
}

for (const dir of projects) fs.rmSync(dir, { recursive: true, force: true });

if (failures.length) {
  console.error(`component-users: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
  process.exit(1);
}
console.log(`component-users: ${checked} passed`);
