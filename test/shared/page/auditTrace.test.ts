// Goal: a rendered head value is traced to where it is written, through a
// layout's props: a literal on the page's instance wins; a prop nobody passes
// lands on the component's default, or on the site constant the default reads;
// an element that writes its value as a literal is its own source.
// Method: my-site's structure — a page passing `description` to BaseLayout,
// which spreads `{...seo}` into BaseHead, whose `<meta content={description}>`
// defaults to SITE_DESCRIPTION — parsed with the editor's parser, traced, and the
// answer pinned for each way the value can be supplied.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePage } from '#dist/electron/parse/astroParser.js';
import { parsePageResult } from '#dist/shared/page/pageNode.js';
import { destructuredProps, propBehind, traceAuthored } from '#dist/shared/page/auditTrace.js';

function file(name: string, kind: 'page' | 'component' | 'layout', source: string) {
  const parsed = parsePageResult(parsePage(source, { locs: true }));
  assert.ok(parsed.editable);
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(source)?.[1] ?? '';
  return { file: name, kind, nodes: parsed.model.nodes, imports: parsed.model.imports, frontmatter, source, route: undefined };
}

const BASE_HEAD = file(
  'src/components/utility/BaseHead.astro',
  'component',
  `---\nimport { SITE_DESCRIPTION, SITE_NAME } from "@/consts";\nconst {\n  title,\n  description = SITE_DESCRIPTION,\n  noindex,\n} = Astro.props;\nconst pageTitle = title ? \`\${title} | \${SITE_NAME}\` : SITE_NAME;\n---\n<title>{pageTitle}</title>\n<meta name="description" content={description} />\n<link rel="canonical" href="https://a.example/" />`,
);
const LAYOUT = file(
  'src/layouts/BaseLayout.astro',
  'layout',
  `---\nimport BaseHead from "@/components/utility/BaseHead.astro";\nconst { theme = "inherit", ...seo } = Astro.props;\n---\n<html lang="en"><head><BaseHead {...seo} /></head><body><slot /></body></html>`,
);
const pageWith = (props: string) =>
  file('src/pages/example-components.astro', 'page', `---\nimport Layout from "@/layouts/BaseLayout.astro";\n---\n<Layout ${props}><h1>Hi</h1></Layout>`);
const FILES_OF = (page: ReturnType<typeof pageWith>) => new Map([page, LAYOUT, BASE_HEAD].map((entry) => [entry.file, entry]));
const resolve = (_from: unknown, tag: string) => (tag === 'Layout' ? LAYOUT.file : tag === 'BaseHead' ? BASE_HEAD.file : undefined);
const META = [1]; // BaseHead's second root: the meta.
const trace = (page: ReturnType<typeof pageWith>, leaf: { readonly path: readonly number[]; readonly attr: string | undefined }) =>
  traceAuthored({ page, files: FILES_OF(page), resolve, leaf: { file: BASE_HEAD.file, ...leaf } });

test('a literal on the page’s Layout instance is where the description is written', () => {
  const page = pageWith('title="Example Components" description="Every layout variant, side by side."');
  assert.deepEqual(trace(page, { path: META, attr: 'content' }), { kind: 'node', file: page.file, path: [0], tag: 'Layout', prop: 'description' });
  assert.deepEqual(
    trace(page, { path: [0], attr: undefined }),
    { kind: 'node', file: page.file, path: [0], tag: 'Layout', prop: 'title' },
    'the title, through `pageTitle`',
  );
});

test('a description nobody passes is the component default’s, which reads a site constant', () => {
  const page = pageWith('theme="dark"');
  assert.deepEqual(trace(page, { path: META, attr: 'content' }), { kind: 'constant', from: BASE_HEAD.file, name: 'SITE_DESCRIPTION', module: '@/consts' });
});

test('a literal in the element is its own source; an unrendered file traces to its frontmatter', () => {
  const page = pageWith('');
  assert.deepEqual(trace(page, { path: [2], attr: 'href' }), { kind: 'node', file: BASE_HEAD.file, path: [2], tag: 'link', prop: undefined });
  const lonely = file('src/pages/other.astro', 'page', '<p>x</p>');
  assert.deepEqual(
    traceAuthored({
      page: lonely,
      files: new Map([
        [lonely.file, lonely],
        [BASE_HEAD.file, BASE_HEAD],
      ]),
      resolve,
      leaf: { file: BASE_HEAD.file, path: META, attr: 'content' },
    }),
    {
      kind: 'file',
      file: BASE_HEAD.file,
    },
  );
});

test('destructuring is read with defaults, renames and rest; props behind local constants are found', () => {
  const read = destructuredProps('const { title, description = SITE_DESCRIPTION, heading: label, list = [1, 2], ...seo } = Astro.props;');
  assert.deepEqual(
    [...read.names],
    [
      ['title', 'title'],
      ['description', 'description'],
      ['label', 'heading'],
      ['list', 'list'],
    ],
  );
  assert.equal(read.defaults.get('description'), 'SITE_DESCRIPTION');
  assert.equal(read.defaults.get('list'), '[1, 2]');
  assert.equal(read.rest, 'seo');
  assert.equal(propBehind(BASE_HEAD, 'pageTitle'), 'title');
  assert.equal(propBehind(BASE_HEAD, '"literal"'), undefined);
});
