// Palette hover previews must provide visible text without replacing authored defaults.
// Exercise real schema parsing, exact glob selection, and the generated Astro route.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const compiler = require('@astrojs/compiler');
const {
  componentPreviewInputs,
  componentPreviewPath,
  componentPreviewPlugin,
  renderComponentPreviewPage,
} = require('../dist/electron/componentPreview.js');

const accordion = `---
type Props = {
  render?: boolean;
  heading?: string;
  headingTag?: 'h2' | 'h3';
  open?: boolean;
};
const { render = true, heading, headingTag = 'h3', open = false } = Astro.props;
const content = await slotContent(Astro.slots);
---
{render && heading && content && (
  <details open={open}><summary>{heading}</summary>{content}</details>
)}
`;

test('a conditional accordion receives its missing heading and keeps its authored behavior', () => {
  const inputs = componentPreviewInputs(accordion, 'AccordionItem');
  assert.deepEqual(inputs.props, { heading: 'AccordionItem' });
  assert.equal('open' in inputs.props, false, 'the component retains its authored closed state');
});

test('false, empty, numeric and expression defaults are not replaced or evaluated', () => {
  const source = `---
type Props = {
  title?: string; heading?: string; label?: string; render?: boolean; count?: number;
};
const {
  title = '', heading = authoredTitle(), label = 'Saved', render = false, count = 0,
} = Astro.props;
---
<h2>{title}{heading}{label}</h2>`;
  assert.deepEqual(componentPreviewInputs(source, 'Card').props, {});
  const fields = `---
type Props = {
  title?: string;
  src: string;
  href: string;
  class?: string;
  render?: boolean;
  tag: 'h2' | 'h3';
  variant?: 'small' | 'large';
  count?: number;
};
---
<slot />`;
  assert.deepEqual(componentPreviewInputs(fields, 'Card').props, {
    title: 'Card', render: true, tag: 'h2',
  });
});

test('preview metadata rejects malformed and oversized inputs', () => {
  assert.throws(() => componentPreviewInputs({}, 'Card'), /expected string/);
  assert.throws(() => componentPreviewInputs('', 'x'.repeat(201)), /exceeds length limit/);
  assert.throws(() => componentPreviewInputs('x'.repeat(10 * 1024 * 1024 + 1), 'Card'),
    /exceeds length limit/);
});

test('exact project paths distinguish duplicate component names and support layouts', () => {
  const paths = ['/src/components/One/Card.astro', '/src/components/Two/Card.astro',
    '/src/layouts/BaseLayout.astro'];
  assert.equal(componentPreviewPath(paths, 'src/components/Two/Card.astro', 'Card'), paths[1]);
  assert.equal(componentPreviewPath(paths, 'src/layouts/BaseLayout.astro', 'BaseLayout'), paths[2]);
  assert.equal(componentPreviewPath(paths, '', 'Card'), paths[0], 'legacy name URLs still work');
  for (const selected of ['../../Card.astro', '/etc/Card.astro', 'src/pages/Card.astro',
    'src/components/Missing/Card.astro']) {
    assert.equal(componentPreviewPath(paths, selected, 'Card'), undefined,
      'invalid explicit paths cannot fall back to another component with the same name');
  }
  assert.equal(componentPreviewPath(paths, '', '<script>'), undefined);
  assert.throws(() => componentPreviewPath(paths, null, 'Card'), /expected string/);
  assert.throws(() => componentPreviewPath(paths, 'a'.repeat(4097), 'Card'), /length limit/);
});

test('preview canvas keeps authored html and body backgrounds with their text colors', () => {
  const { JSDOM } = require('jsdom');
  const styles = renderComponentPreviewPage().match(/<style>([\s\S]*?)<\/style>/)?.[1];
  assert.ok(styles, 'the test exercises the actual generated preview canvas styles');
  const dom = new JSDOM(`<html><head><style>
    html { background: #111111; }
    body { background: #222222; color: #eeeeee; }
    </style><style>${styles}</style></head><body><div id="avb-stage">Card</div></body></html>`);
  try {
    const { document, getComputedStyle } = dom.window;
    assert.equal(getComputedStyle(document.documentElement).backgroundColor, 'rgb(17, 17, 17)');
    assert.equal(getComputedStyle(document.body).backgroundColor, 'rgb(34, 34, 34)');
    assert.equal(getComputedStyle(document.body).color, 'rgb(238, 238, 238)');
  } finally {
    dom.window.close();
  }
});

test('generated Astro route keeps its default slot and loads the selected source', async () => {
  const template = renderComponentPreviewPage();
  assert.match(template, /src\/layouts\/\*\*\/\*\.astro/);
  assert.match(template, /<C \{\.\.\.props\}>/);
  assert.match(template, /<C \{\.\.\.props\}>\{name\}<\/C>/);
  assert.match(template, /avb:component-preview/);
  assert.match(template, /reportStatus\('empty'\)/);
  assert.match(template, /reportStatus\('ready'\)/);
  assert.doesNotMatch(template, /__STACKI_PREVIEW_/);
  assert.doesNotMatch(template, /require\(|componentPreview\.js|node:/,
    'edge-rendered pages cannot import the app CommonJS or Node helpers');
  const compiled = await compiler.transform(template, { filename: 'preview.astro' });
  assert.equal(compiled.diagnostics.filter((item) => item.severity === 1).length, 0);
  assert.doesNotMatch(compiled.code, /__stacki_unused_|\[undefined\]/,
    'the preview must not create artificial named slots');

  const loaded = [];
  const selected = '/src/components/Two/Card.astro';
  const paths = ['/src/components/One/Card.astro', selected];
  const modules = Object.fromEntries(paths.map((file) => [file, async () => {
    loaded.push(file); return { default: 'Component' };
  }]));
  const sources = Object.fromEntries(paths.map((file) => [file, async () => {
    loaded.push(file + '?raw&stacki-preview-props');
    return componentPreviewInputs(accordion, path.basename(file, '.astro'));
  }]));
  const frontmatter = template.split('---')[1]
    .replace(/export const prerender = false;/, '')
    .replaceAll('import.meta.glob', 'glob');
  const run = vm.runInNewContext(`(async () => { ${frontmatter}; return { name, C, props }; })`, {
    Astro: { url: new URL('http://localhost/__avb/preview?p=' + selected) },
    glob: (_pattern, options) => options?.eager ? {} : options?.query ? sources : modules,
  });
  const result = await run();
  assert.equal(result.name, 'Card');
  assert.deepEqual({ ...result.props }, { heading: 'Card' });
  assert.deepEqual(loaded, [selected + '?raw&stacki-preview-props', selected]);
});

test('Vite metadata exports plain ESM data and reflects source edits', async (t) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-hover-metadata-'));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const file = path.join(project, 'src', 'components', 'AccordionItem.astro');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, accordion);
  const plugin = componentPreviewPlugin([project]);
  const id = file + '?raw&stacki-preview-props';
  const first = plugin.load(id);
  assert.match(first, /^export default /);
  assert.doesNotMatch(first, /require|exports|node:|Astro\.props/);
  const imported = await import('data:text/javascript,' + encodeURIComponent(first));
  assert.deepEqual(imported.default, { props: { heading: 'AccordionItem' } });
  fs.writeFileSync(file, accordion.replace('heading, headingTag', "heading = 'Saved', headingTag"));
  assert.equal(plugin.load(id), 'export default {"props":{}};',
    'a later load sees authored defaults after a source edit');
  for (const query of ['', '?raw', '?stacki-preview-props', '?raw&not-stacki-preview-props']) {
    assert.equal(plugin.load(file + query), undefined);
  }
  for (const relative of ['src/pages/index.astro', 'src/components/../../private.astro',
    '../outside.astro', 'src/components/private.json']) {
    assert.throws(() => plugin.load(path.join(project, relative) + '?raw&stacki-preview-props'),
      /must belong to a project component or layout/);
  }
});
