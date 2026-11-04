// Goal: a palette preview renders a component the way the site's pages do. Pages put
// site-wide CSS in inline <style> blocks of shared components, classes on <html> and
// <body> in their layout, and literal props on each instance; the preview must carry all
// three, and must not copy styles or props that belong to one page or need evaluation.
//
// Method: build a small project on disk (a layout, a GlobalStyles embed, a page-only
// section, a button with a variant prop), then exercise the pure readers and the real Vite
// plugin. A fake plugin context records watched files; deleting files without telling the
// plugin proves later loads come from its cached index, and watchChange proves the
// cache is discarded on edits.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  componentPreviewContextModule,
  componentPreviewDocumentAttributes,
  componentPreviewGlobalFiles,
  componentPreviewInlineStyles,
  componentPreviewInstance,
  componentPreviewSample,
  readPreviewProjectIndex,
} from '#dist/electron/previewServer/componentPreviewContext.js';
import { componentPreviewPlugin } from '#dist/electron/previewServer/componentPreview.js';

const layout = `---
import '@/styles/site.css';
const { title = '' } = Astro.props;
---
<html lang="en" class="theme-light" data-theme="light" data-dynamic={title}>
<head><style is:inline>.lenis { height: auto; }</style></head>
<body class="u-body">
<slot />
</body>
</html>`;

const globalStyles = `---
interface Props {}
---
<div class="u-position-fixed"><div class="w-embed">
<style is:inline>
button { background-color: unset; padding: unset; }
</style>
<style>.scoped-only { color: red; }</style>
<style is:global lang="scss">.nested { .child { color: red; } }</style>
</div></div>`;

const button = `---
interface Props { text?: string; variant?: 'primary' | 'secondary'; }
const { text = 'Button Text', variant = 'primary' } = Astro.props;
---
<div class:list={['button_main_wrap', variant]}><button>{text}</button><div class="button_main_icon"><slot /></div></div>`;

const heading = `---
interface Props { tag?: 'h1' | 'h2'; }
---
<h2><slot /></h2>`;

const section = `---
---
<section><style is:inline>.page-only { color: red; }</style><slot /></section>`;

const index = `---
import Layout from '@/layouts/Layout.astro';
import GlobalStyles from '@/components/global/GlobalStyles.astro';
import ButtonMain from '../components/button/ButtonMain.astro';
import Heading from '~/components/Heading.astro';
import Section from '/src/components/Section.astro';
---
<Layout title="Home">
<GlobalStyles />
<Section>
<Heading tag="h1" client:load>Find <strong>hope</strong></Heading>
<ButtonMain text="Choose a campus" variant="primary" link={'/campuses'} count={2} wide data={page} {...rest} />
<ButtonMain text="Plan your visit" variant="secondary" />
</Section>
</Layout>`;

const about = `---
import Layout from '@/layouts/Layout.astro';
import GlobalStyles from '@/components/global/GlobalStyles.astro';
import ButtonMain from '@/components/button/ButtonMain.astro';
---
<Layout><GlobalStyles /><ButtonMain text="About" /></Layout>`;

const contact = `---
import Layout from '@/layouts/Layout.astro';
import GlobalStyles from '@/components/global/GlobalStyles.astro';
---
<Layout><GlobalStyles /></Layout>`;

function project(context: { readonly after: (callback: () => void) => void }): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-preview-context-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files: Readonly<Record<string, string>> = {
    'src/layouts/Layout.astro': layout,
    'src/components/global/GlobalStyles.astro': globalStyles,
    'src/components/button/ButtonMain.astro': button,
    'src/components/Heading.astro': heading,
    'src/components/Section.astro': section,
    'src/pages/about.astro': about,
    'src/pages/contact.astro': contact,
    'src/pages/give.astro': contact,
    'src/pages/index.astro': index,
    'src/styles/site.css': ':root { --brand: #0072da; }',
  };
  for (const [relative, source] of Object.entries(files)) {
    fs.mkdirSync(path.join(root, path.dirname(relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), source);
  }
  return root;
}

function watcher() {
  const watched: string[] = [];
  return {
    watched,
    addWatchFile: (file: string) => {
      watched.push(file);
    },
  };
}

test('files shared by a majority of the pages are global, in page import order', () => {
  const pages = [
    ['src/layouts/Layout.astro', 'src/components/Global.astro', 'src/components/Hero.astro'],
    ['src/layouts/Layout.astro', 'src/components/Global.astro'],
    ['src/layouts/Layout.astro', 'src/components/Footer.astro', 'src/components/Footer.astro'],
  ];
  assert.deepEqual(componentPreviewGlobalFiles(pages), ['src/layouts/Layout.astro', 'src/components/Global.astro']);
  assert.deepEqual(componentPreviewGlobalFiles([]), []);
  assert.deepEqual(componentPreviewGlobalFiles([['src/components/Only.astro']]), ['src/components/Only.astro'], 'a one-page site shares everything');
  assert.throws(
    () => componentPreviewGlobalFiles([Array.from({ length: 513 }, (_, index) => `src/components/C${index}.astro`)]),
    /imports per page exceed limit/,
  );
});

test('only literal inline and global CSS is copied from a template', () => {
  assert.deepEqual(componentPreviewInlineStyles(globalStyles), ['button { background-color: unset; padding: unset; }']);
  assert.deepEqual(componentPreviewInlineStyles('---\nconst css = "<style is:inline>.x{}</style>";\n---\n<div />'), [], 'frontmatter text is not markup');
  assert.deepEqual(componentPreviewInlineStyles('<style is:global>  </style><style is:global>.a { color: red; }</style>'), ['.a { color: red; }']);
});

test('document attributes keep literal classes and data attributes only', () => {
  assert.deepEqual(componentPreviewDocumentAttributes(layout), {
    html: { class: 'theme-light', 'data-theme': 'light' },
    body: { class: 'u-body' },
  });
  assert.deepEqual(componentPreviewDocumentAttributes(button), { html: {}, body: {} });
});

test('the first instance supplies literal props and plain children, never expressions', () => {
  assert.deepEqual(componentPreviewInstance(index, 'ButtonMain'), {
    props: { text: 'Choose a campus', variant: 'primary', link: '/campuses', count: 2, wide: true },
    slot: { kind: 'none' },
  });
  assert.deepEqual(componentPreviewInstance(index, 'Heading'), {
    props: { tag: 'h1' },
    slot: { kind: 'html', html: 'Find <strong>hope</strong>' },
  });
  assert.deepEqual(componentPreviewInstance(index, 'Section')?.slot, { kind: 'name' }, 'component children need the page scope');
  assert.deepEqual(componentPreviewInstance('<Card>{items.map((item) => <li>{item}</li>)}</Card>', 'Card')?.slot, { kind: 'name' });
  assert.deepEqual(componentPreviewInstance('<Card>\n</Card>', 'Card'), { props: {}, slot: { kind: 'none' } });
  assert.deepEqual(componentPreviewInstance('<Card title=`${x}` size={1e9} label={"Saved"}>', 'Card'), { props: { label: 'Saved' }, slot: { kind: 'name' } });
  assert.equal(componentPreviewInstance('<CardList />', 'Card'), undefined, 'a longer tag name is another component');
  assert.throws(() => componentPreviewInstance('<a />', 'a b'), /identifier/);
  const many = Array.from({ length: 257 }, (_, at) => `p${at}="x"`).join(' ');
  assert.throws(() => componentPreviewInstance(`<Card ${many} />`, 'Card'), /props exceed limit/);
});

test('the homepage instance is preferred, and aliases resolve to project files', (context) => {
  const root = project(context);
  const index = readPreviewProjectIndex(root);
  assert.equal(index.pages[0]?.relative, 'src/pages/index.astro');
  assert.deepEqual(
    index.pages[0]?.imports.map((entry) => entry.relative),
    [
      'src/layouts/Layout.astro',
      'src/components/global/GlobalStyles.astro',
      'src/components/button/ButtonMain.astro',
      'src/components/Heading.astro',
      'src/components/Section.astro',
    ],
  );
  const found = componentPreviewSample(index, 'src/components/button/ButtonMain.astro');
  assert.equal(found?.host, 'src/pages/index.astro');
  assert.equal(found?.sample.props['text'], 'Choose a campus');
  assert.equal(componentPreviewSample(index, 'src/layouts/Layout.astro')?.sample.slot.kind, 'name');
  assert.equal(componentPreviewSample(index, 'src/components/Unused.astro'), undefined);
  assert.throws(() => componentPreviewSample(index, 'node_modules/x/Card.astro'), /project files/);
});

test('the context module carries global CSS and document attributes, not page-only styles', async (context) => {
  const root = project(context);
  const module = componentPreviewContextModule(root, readPreviewProjectIndex(root));
  const imported: unknown = await import('data:text/javascript,' + encodeURIComponent(module.code));
  assert.deepEqual(JSON.parse(JSON.stringify(imported)), {
    contextStyles: ['.lenis { height: auto; }', 'button { background-color: unset; padding: unset; }'],
    htmlAttributes: { class: 'theme-light', 'data-theme': 'light' },
    bodyAttributes: { class: 'u-body' },
  });
  assert.doesNotMatch(module.code, /page-only|scoped-only|\.nested/);
  assert.deepEqual(module.watchFiles, [path.join(root, 'src/layouts/Layout.astro'), path.join(root, 'src/components/global/GlobalStyles.astro')]);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-preview-context-empty-'));
  context.after(() => fs.rmSync(empty, { recursive: true, force: true }));
  assert.equal(
    componentPreviewContextModule(empty, readPreviewProjectIndex(empty)).code,
    'export const contextStyles = [];\nexport const htmlAttributes = {};\nexport const bodyAttributes = {};\n',
  );
});

test('the Vite plugin samples instances from a cached index and watches what it read', (context) => {
  const root = project(context);
  const plugin = componentPreviewPlugin([root]);
  const contextID = plugin.resolveId('virtual:stacki-component-preview-context');
  assert.equal(contextID, '\0virtual:stacki-component-preview-context');
  const fake = watcher();
  assert.match(plugin.load.call(fake, contextID) ?? '', /background-color: unset/);
  assert.deepEqual(fake.watched, [path.join(root, 'src/layouts/Layout.astro'), path.join(root, 'src/components/global/GlobalStyles.astro')]);

  const propsID = path.join(root, 'src/components/button/ButtonMain.astro') + '?raw&stacki-preview-props';
  const expected =
    'export default {"props":{"text":"Choose a campus","variant":"primary","link":"/campuses","count":2,"wide":true},"missing":[],"slot":{"kind":"none"}};';
  const first = watcher();
  assert.equal(plugin.load.call(first, propsID), expected);
  assert.deepEqual(first.watched, [path.join(root, 'src/pages/index.astro')], 'editing the sampled page reloads the inputs');

  // The second open reads no page: removing every page leaves the cached sample in place.
  fs.rmSync(path.join(root, 'src/pages'), { recursive: true });
  assert.equal(plugin.load.call(watcher(), propsID), expected);
  plugin.watchChange(path.join(root, 'src/styles/site.css'));
  assert.equal(plugin.load.call(watcher(), propsID), expected, 'non-Astro edits keep the index');
  plugin.watchChange(path.join(root, 'src/pages/index.astro'));
  assert.equal(
    plugin.load.call(watcher(), propsID),
    'export default {"props":{},"missing":[],"slot":{"kind":"name"}};',
    'an Astro edit discards the index, so the deleted pages no longer supply a sample',
  );
});
