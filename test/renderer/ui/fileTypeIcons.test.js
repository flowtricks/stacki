// Goal: pin the one table of what a listed file looks like (ui/ElementIcons.tsx, file-type icons): each kind of file
// an Astro project shows wears the mark and the colour agreed for it, a type with no Central mark keeps a plain
// uncoloured icon, and every colour the table names is a theme token the stylesheet defines.
// Method: bundle the real module with esbuild, ask `fileLookOf` for a table of names (whole names, extensions, paths,
// case, near misses), render `FileTypeIcon` on the server to check the drawing and the box, and read styles.css.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const esbuild = require('esbuild');
const { repoPath } = require('../../helpers/sources.js');

async function loadIcons() {
  const { outputFiles } = await esbuild.build({
    stdin: {
      contents: [
        "import { createElement } from 'react';",
        "import { renderToStaticMarkup } from 'react-dom/server';",
        "import { FileTypeIcon, fileLookOf } from './src/ui/ElementIcons';",
        'export { fileLookOf };',
        'export const render = (name, size) => renderToStaticMarkup(createElement(FileTypeIcon, { name, size }));',
      ].join('\n'),
      resolveDir: repoPath('.'),
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    jsx: 'automatic',
    external: ['react', 'react/jsx-runtime', 'react-dom/server'],
    write: false,
  });
  const bundled = outputFiles[0];
  assert.ok(bundled);
  const filename = repoPath('node_modules/.stacki-test/file-type-icons.cjs');
  const bundleModule = { exports: {} };
  new Function('require', 'module', 'exports', bundled.text)(createRequire(filename), bundleModule, bundleModule.exports);
  return bundleModule.exports;
}

const LOOKS = [
  ['index.astro', 'astro', 'astro'],
  ['src/pages/[slug].astro', 'astro', 'astro'],
  ['astro.config.mjs', 'astro', 'astro'],
  ['consts.ts', 'typescript', 'blue'],
  ['types.TS', 'typescript', 'blue'],
  ['env.d.ts', 'typescript', 'blue'],
  ['load.mts', 'typescript', 'blue'],
  ['load.cts', 'typescript', 'blue'],
  ['tsconfig.json', 'typescript', 'blue'],
  ['tsconfig.build.json', 'typescript', 'blue'],
  ['jsconfig.json', 'javascript', 'yellow'],
  ['Card.tsx', 'react', 'cyan'],
  ['Card.jsx', 'react', 'cyan'],
  ['main.js', 'javascript', 'yellow'],
  ['eslint.config.mjs', 'javascript', 'yellow'],
  ['old.cjs', 'javascript', 'yellow'],
  ['data.json', 'json', 'yellow'],
  ['settings.jsonc', 'json', 'yellow'],
  ['package.json', 'npm', 'red'],
  ['package-lock.json', 'npm', 'red'],
  ['.npmrc', 'npm', 'red'],
  ['bun.lock', 'bun', undefined],
  ['yarn.lock', 'braces', undefined],
  ['post.md', 'markdown', 'blue'],
  ['post.mdx', 'markdown', 'yellow'],
  ['README.md', 'info', 'blue'],
  ['readme-notes.md', 'markdown', 'blue'],
  ['LICENSE', 'license', 'yellow'],
  ['LICENCE.txt', 'license', 'yellow'],
  ['license.ts', 'typescript', 'blue'],
  ['.env', 'lock', 'yellow'],
  ['.env.production', 'lock', 'yellow'],
  ['env.ts', 'typescript', 'blue'],
  ['server.pem', 'lock', 'yellow'],
  ['.gitignore', 'git', 'orange'],
  ['.gitattributes', 'git', 'orange'],
  ['vercel.json', 'vercel', undefined],
  ['netlify.toml', 'netlify', 'cyan'],
  ['App.vue', 'vue', 'green'],
  ['App.svelte', 'svelte', 'orange'],
  ['tool.py', 'python', 'blue'],
  ['mail.php', 'php', 'purple'],
  ['deploy.sh', 'terminal', 'green'],
  ['logo.svg', 'vector', 'orange'],
  ['photo.webp', 'image', 'purple'],
  ['favicon.ico', 'image', 'purple'],
  ['clip.mp4', 'video', 'orange'],
  ['song.mp3', 'audio', 'purple'],
  ['Inter.woff2', 'font', 'red'],
  ['guide.pdf', 'pdf', 'red'],
  ['site.zip', 'archive', 'grey'],
  ['rows.csv', 'table', 'green'],
  ['robots.txt', 'text', undefined],
  // No Central mark: a plain icon that borrows no type's colour.
  ['global.css', 'code', undefined],
  ['theme.scss', 'code', undefined],
  ['theme.less', 'code', undefined],
  ['index.html', 'code', undefined],
  ['config.yaml', 'code', undefined],
  ['pnpm-lock.yaml', 'code', undefined],
  ['wrangler.toml', 'code', undefined],
  ['sitemap.xml', 'code', undefined],
  ['mystery', 'file', undefined],
  ['ts', 'file', undefined],
  ['', 'file', undefined],
];

test('every kind of file in an Astro project wears its mark and colour', async () => {
  const { fileLookOf } = await loadIcons();
  for (const [name, glyph, hue] of LOOKS) {
    assert.deepEqual(fileLookOf(name), { glyph, hue }, name);
  }
});

test('only the last segment of a path is read, whatever its folders are called', async () => {
  const { fileLookOf } = await loadIcons();
  assert.deepEqual(fileLookOf('README/main.ts'), fileLookOf('main.ts'));
  assert.deepEqual(fileLookOf('.env/readme.css'), fileLookOf('readme.css'));
});

test('the drawn icon is the Central mark, in a square box, naming its type and colour', async () => {
  const { render } = await loadIcons();
  const typescript = render('consts.ts', 14);
  assert.match(typescript, /data-file-type="typescript"/);
  assert.match(typescript, /data-file-hue="blue"/);
  assert.match(typescript, /data-central-icon="brand-typescript"/);
  assert.match(typescript, /width:16px;height:16px/);
  assert.match(typescript, /fill="currentColor"/);
  assert.match(render('consts.ts', 12), /width:12px;height:12px/);
  assert.match(render('logo.svg', 14), /data-central-icon="vector-logo"/);
  const css = render('global.css', 14);
  assert.match(css, /data-central-icon="code"/);
  assert.doesNotMatch(css, /data-file-hue/);
});

test('every colour the table names is a theme token the stylesheet defines and applies', async () => {
  const { fileLookOf } = await loadIcons();
  const styles = fs.readFileSync(repoPath('src/app/styles.css'), 'utf8');
  const hues = new Set(LOOKS.map(([name]) => fileLookOf(name).hue).filter((hue) => hue !== undefined));
  assert.ok(hues.size >= 8);
  for (const hue of hues) {
    assert.match(styles, new RegExp(`--file-${hue}: #[0-9a-f]{6};`), hue);
    assert.ok(styles.includes(`[data-file-hue='${hue}'] {\n  color: var(--file-${hue});`), hue);
  }
});
