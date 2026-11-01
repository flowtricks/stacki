// Preserve the website's CSS cascade when rendering isolated components.
// Exercise import graphs and the actual Vite plugin to catch eager leaf imports.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { componentPreviewStylePaths } = require('#dist/electron/previewServer/componentPreviewStyles.js');
const { componentPreviewPlugin, renderComponentPreviewPage } = require('#dist/electron/previewServer/componentPreview.js');

const sources = {
  '/src/styles/base.css': 'button { background: transparent; padding: 0; border: 0; }',
  '/src/styles/global.css': `
    @layer base, components;
    @import "./base.css" layer(base);
    @import url('./tokens.css');
  `,
  '/src/styles/tokens.css': ':root { --button-background: purple; }',
  '/src/styles/standalone.css': 'body { color: black; }',
};

test('layered styles are loaded through their entry point without unlayered duplicates', () => {
  assert.deepEqual(componentPreviewStylePaths(sources), ['/src/styles/global.css', '/src/styles/standalone.css']);
  assert.deepEqual(componentPreviewStylePaths({}), []);
});

test('nested imports, URLs, aliases and Sass partials retain their entry points', () => {
  assert.deepEqual(
    componentPreviewStylePaths({
      '/src/styles/global.scss': `
        @use "./tokens";
        @forward "@/styles/theme";
        @import url(./nested/reset.css) layer(base) screen;
        @import "https://example.com/src/styles/remote.css";
        /* @import "./standalone.css"; */
        .example::before { content: '@import "./standalone.css";'; }
      `,
      '/src/styles/_tokens.scss': '',
      '/src/styles/theme.scss': '@import "~/styles/colors.css";',
      '/src/styles/colors.css': '',
      '/src/styles/nested/reset.css': '@import "../base.css";',
      '/src/styles/base.css': '',
      '/src/styles/remote.css': '',
      '/src/styles/standalone.css': '',
    }),
    ['/src/styles/global.scss', '/src/styles/remote.css', '/src/styles/standalone.css'],
  );
});

test('malformed, oversized and cyclic stylesheet graphs fail explicitly', () => {
  assert.throws(() => componentPreviewStylePaths({ '/src/styles/base.css': {} }), /source text/);
  assert.throws(() => componentPreviewStylePaths({ '/src/styles/base.css': 'x'.repeat(10 * 1024 * 1024 + 1) }), /source limit/);
  assert.throws(
    () => componentPreviewStylePaths(Object.fromEntries(Array.from({ length: 1025 }, (_, index) => [`/src/styles/${index}.css`, '']))),
    /count exceeds limit/,
  );
  assert.throws(
    () =>
      componentPreviewStylePaths({
        '/src/styles/one.css': '@import "./two.css";',
        '/src/styles/two.css': '@import "./one.css";',
      }),
    /no entry point/,
  );
});

test('the Vite graph contains only entry styles and reflects edited imports', (context) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-preview-styles-'));
  context.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const plugin = componentPreviewPlugin([project]);
  const id = plugin.resolveId('virtual:stacki-component-preview-styles');
  assert.equal(plugin.resolveId('/src/styles/global.css'), undefined);
  assert.equal(plugin.load(id), '', 'projects without styles still render components');
  for (const [file, source] of Object.entries(sources)) {
    const target = path.join(project, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source);
  }
  assert.equal(plugin.load(id), ['import "/src/styles/global.css";', 'import "/src/styles/standalone.css";'].join('\n'));
  fs.appendFileSync(path.join(project, 'src/styles/global.css'), '\n@import "./standalone.css";');
  assert.equal(plugin.load(id), 'import "/src/styles/global.css";');
  const template = renderComponentPreviewPage();
  assert.match(template, /import 'virtual:stacki-component-preview-styles'/);
  assert.equal(template.includes("glob('/src/styles"), false, 'even a lazy glob makes Astro collect unlayered leaf styles');
});
