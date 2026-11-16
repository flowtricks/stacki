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
  renderComponentPreviewAttempt,
  renderComponentPreviewGuard,
  renderComponentPreviewPage,
  previewSupportFiles,
} = require('#dist/electron/previewServer/componentPreview.js');

// Null as a boundary receives it, parsed from JSON: inputs may hold it; our values never do.
const jsonNull = JSON.parse('null');

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
    title: 'Card',
    render: true,
    tag: 'h2',
  });
});

test('preview metadata rejects malformed inputs and an oversized name, never a large source', () => {
  assert.throws(() => componentPreviewInputs({}, 'Card'), /expected string/);
  assert.throws(() => componentPreviewInputs('', 'x'.repeat(201)), /exceeds length limit/);
  assert.doesNotThrow(
    () => componentPreviewInputs(`---\n---\n<p>${'x'.repeat(10 * 1024 * 1024 + 1)}</p>`, 'Card'),
    'a source past the old 10 MB bound previews',
  );
});

test('required page data blocks standalone rendering without inventing object values', () => {
  const source = `---
import type { PageData } from './queries';
interface Props { data: PageData; heading: string; }
const { data, heading } = Astro.props;
const labels = data.entries.map((entry) => entry.label);
---
<h2>{heading}</h2>`;
  assert.deepEqual(componentPreviewInputs(source, 'Overview'), {
    props: { heading: 'Overview' },
    missing: ['data'],
    slot: { kind: 'name' },
  });
});

test('optional props and authored defaults do not block previews', () => {
  const source = `---
interface Props {
  data?: PageData;
  items: Item[];
  count: number;
  title: string;
  visible: boolean;
  tag: 'h2' | 'h3';
}
const { data, items = [], count = 0, title = '', visible = false, tag } = Astro.props;
---
<h2>{title}</h2>`;
  assert.deepEqual(componentPreviewInputs(source, 'Card'), {
    props: { tag: 'h2' },
    missing: [],
    slot: { kind: 'name' },
  });
});

test('required unsampled primitive, array, and object props remain unavailable', () => {
  const source = `---
interface Props { src: string; count: number; active: boolean; items: Item[]; data: object; }
---
<div />`;
  assert.deepEqual(componentPreviewInputs(source, 'Card'), {
    props: {},
    missing: ['src', 'count', 'active', 'items', 'data'],
    slot: { kind: 'name' },
  });
});

test('a sampled instance supplies props, fills required inputs and replaces the name slot', () => {
  const source = `---
interface Props { variant?: 'primary' | 'secondary'; text?: string; src: string; data: PageData; }
const { variant = 'primary', text = 'Button Text' } = Astro.props;
---
<div class={variant}>{text}<slot /></div>`;
  const sample = { props: { text: 'Choose a campus', variant: 'secondary', src: '/a.png' }, slot: { kind: 'none' } };
  assert.deepEqual(componentPreviewInputs(source, 'ButtonMain', sample), {
    props: { text: 'Choose a campus', variant: 'secondary', src: '/a.png' },
    missing: ['data'],
    slot: { kind: 'none' },
  });
  assert.deepEqual(componentPreviewInputs(source, 'ButtonMain').slot, { kind: 'name' }, 'without an instance the name stays the slot placeholder');
});

test('exact project paths distinguish duplicate component names and support layouts', () => {
  const paths = ['/src/components/One/Card.astro', '/src/components/Two/Card.astro', '/src/layouts/BaseLayout.astro'];
  assert.equal(componentPreviewPath(paths, 'src/components/Two/Card.astro', 'Card'), paths[1]);
  assert.equal(componentPreviewPath(paths, 'src/layouts/BaseLayout.astro', 'BaseLayout'), paths[2]);
  assert.equal(componentPreviewPath(paths, '', 'Card'), paths[0], 'legacy name URLs still work');
  for (const selected of ['../../Card.astro', '/etc/Card.astro', 'src/pages/Card.astro', 'src/components/Missing/Card.astro']) {
    assert.equal(componentPreviewPath(paths, selected, 'Card'), undefined, 'invalid explicit paths cannot fall back to another component with the same name');
  }
  assert.equal(componentPreviewPath(paths, '', '<script>'), undefined);
  assert.throws(() => componentPreviewPath(paths, jsonNull, 'Card'), /expected string/);
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
  // The component itself is drawn by the attempt component, inside a guard that catches a throw.
  const attempt = renderComponentPreviewAttempt();
  assert.match(attempt, /<C \{\.\.\.attempt\.props\}>\{name\}<\/C>/);
  assert.match(attempt, /<C \{\.\.\.attempt\.props\}><Fragment set:html=\{slot\.html\} \/>/, 'sampled plain children fill the slot');
  assert.match(attempt, /<C \{\.\.\.attempt\.props\} \/>/, 'a self-closing instance renders without slot content');
  assert.match(attempt, /<Fragment slot="fallback">/, "the next attempt is the guard's fallback");
  assert.doesNotMatch(attempt, /__STACKI_/);
  const guard = renderComponentPreviewGuard();
  assert.match(guard, /await Astro\.slots\.render\('default'\)/);
  assert.match(guard, /catch \(error\)/, 'a throw is caught and becomes a reason');
  assert.match(guard, /function previewRendersOnlyName/);
  assert.doesNotMatch(guard, /__STACKI_/);
  for (const [name, text] of Object.entries(previewSupportFiles())) {
    const compiledSupport = await compiler.transform(text, { filename: name });
    assert.equal(compiledSupport.diagnostics.filter((item) => item.severity === 1).length, 0, name);
  }
  assert.match(template, /<html \{\.\.\.htmlAttributes\} class=\{\[htmlAttributes\.class, 'stacki-designer'\]/, "the page is in the project's design mode");
  assert.match(template, /<body \{\.\.\.bodyAttributes\}>\s*\{contextStyles\.map/, 'site-wide styles follow the project stylesheets');
  assert.match(template, /avb:component-preview/);
  assert.match(template, /reportStatus\('empty', /, 'an empty preview says why');
  assert.match(template, /reportStatus\('ready'\)/);
  assert.doesNotMatch(template, /__STACKI_PREVIEW_/);
  assert.doesNotMatch(template, /require\(|componentPreview\.js|node:/, 'edge-rendered pages cannot import the app CommonJS or Node helpers');
  const compiled = await compiler.transform(template, { filename: 'preview.astro' });
  assert.equal(compiled.diagnostics.filter((item) => item.severity === 1).length, 0);
  assert.doesNotMatch(compiled.code, /__stacki_unused_|\[undefined\]/, 'the preview must not create artificial named slots');

  const loaded = [];
  const selected = '/src/components/Two/Card.astro';
  const paths = ['/src/components/One/Card.astro', selected];
  const modules = Object.fromEntries(
    paths.map((file) => [
      file,
      async () => {
        loaded.push(file);
        return { default: 'Component' };
      },
    ]),
  );
  const sources = Object.fromEntries(
    paths.map((file) => [
      file,
      async () => {
        loaded.push(file + '?raw&stacki-preview-props');
        const inputs = componentPreviewInputs(accordion, path.basename(file, '.astro'));
        return { key: 'k', missing: [], attempts: [{ label: 'authored', props: inputs.props, slot: inputs.slot }] };
      },
    ]),
  );
  const frontmatter = template
    .split('---')[1]
    .replace(/export const prerender = false;/, '')
    .replace("import 'virtual:stacki-component-preview-styles';", '')
    .replace("import { contextStyles, htmlAttributes, bodyAttributes } from 'virtual:stacki-component-preview-context';", '')
    .replace("import { packageModules, packageInputs } from 'virtual:stacki-package-components';", '')
    .replace("import Attempt from './stacki-preview-attempt.astro';", '')
    .replaceAll('import.meta.glob', 'glob');
  assert.doesNotMatch(frontmatter, /import /, 'every virtual import is removed before the frontmatter runs');
  const run = vm.runInNewContext(`(async () => { ${frontmatter}; return { name, C, attempts, missing, recipeModules }; })`, {
    Astro: { url: new URL('http://localhost/__avb/preview?p=' + selected) },
    packageModules: {},
    packageInputs: {},
    glob: (_pattern, options) => (options?.eager ? {} : options?.query ? sources : modules),
  });
  const result = await run();
  assert.equal(result.name, 'Card');
  assert.deepEqual({ ...result.attempts[0].props }, { heading: 'Card' });
  assert.equal(result.attempts[0].slot.kind, 'name');
  assert.deepEqual(loaded, [selected + '?raw&stacki-preview-props', selected]);

  // A recipe's nested components load before rendering, keyed as the recipe names them.
  loaded.length = 0;
  const nested = 'src/components/One/Card.astro';
  sources[selected] = async () => ({
    key: 'k',
    missing: [],
    attempts: [{ label: 'authored', props: {}, slot: { kind: 'recipe', node: {}, files: ['src/components/Two/Card.astro', nested] } }],
  });
  const recipe = await run();
  assert.equal(recipe.attempts[0].slot.kind, 'recipe');
  assert.deepEqual(Object.keys(recipe.recipeModules), ['src/components/Two/Card.astro', nested]);
  assert.deepEqual(loaded, [selected, '/' + nested], 'the owner loads once as the component, then the nested one');

  loaded.length = 0;
  sources[selected] = async () => ({ key: 'k', attempts: [], missing: ['data'] });
  const unavailable = await run();
  assert.equal(unavailable.C, jsonNull, 'missing required data must prevent component execution');
  assert.deepEqual(loaded, [], 'the component module is not even imported without its data');
});

test('Vite metadata exports plain ESM data and reflects source edits', async (context) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-hover-metadata-'));
  context.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const file = path.join(project, 'src', 'components', 'AccordionItem.astro');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, accordion);
  const plugin = componentPreviewPlugin([project]);
  const id = file + '?raw&stacki-preview-props';
  const first = plugin.load(id);
  assert.match(first, /^export default /);
  assert.doesNotMatch(first, /require|exports|node:|Astro\.props/);
  const imported = await import('data:text/javascript,' + encodeURIComponent(first));
  assert.deepEqual(imported.default.missing, []);
  assert.match(imported.default.key, /^[0-9a-f]{28}$/, 'every module names the key of its snapshot');
  const labels = imported.default.attempts.map((item) => item.label);
  assert.deepEqual(labels, ['sample', 'sample-minimal', 'sample-bare'], 'with no instance the route tries sample content, then plainer ones');
  assert.deepEqual(imported.default.attempts[0].props, { heading: 'AccordionItem' });
  assert.equal(imported.default.attempts[0].slot.kind, 'sample');
  fs.writeFileSync(file, accordion.replace('heading, headingTag', "heading = 'Saved', headingTag"));
  const edited = await import('data:text/javascript,' + encodeURIComponent(plugin.load(id)));
  assert.deepEqual(edited.default.attempts[0].props, {}, 'a later load sees authored defaults after a source edit');
  assert.notEqual(edited.default.key, imported.default.key, 'an edit changes the key, so its snapshot is made again');
  for (const query of ['', '?raw', '?stacki-preview-props', '?raw&not-stacki-preview-props']) {
    assert.equal(plugin.load(file + query), undefined);
  }
  for (const relative of ['src/pages/index.astro', 'src/components/../../private.astro', '../outside.astro', 'src/components/private.json']) {
    assert.throws(() => plugin.load(path.join(project, relative) + '?raw&stacki-preview-props'), /must belong to a project component or layout/);
  }
});

test('the preview page answers the pointer but never acts: clicks, presses and submits stop, and are reported', async () => {
  const { JSDOM } = require('jsdom');
  const script = renderComponentPreviewPage().match(/<script is:inline>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script, 'the test runs the generated page script itself');
  const dom = new JSDOM(
    `<body><div id="avb-stage"><a href="https://example.com/away">Link</a><form><button>Send</button></form></div><div id="avb-empty"></div></body>`,
    { url: 'http://localhost/__avb/preview', runScripts: 'outside-only', pretendToBeVisual: true },
  );
  try {
    const { window } = dom;
    const posted = [];
    window.addEventListener('message', (event) => posted.push(event.data));
    const reached = [];
    window.document.querySelector('a').addEventListener('click', () => reached.push('component click'));
    window.eval(script);
    const link = window.document.querySelector('a');
    link.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
    link.dispatchEvent(new window.MouseEvent('mousemove', { bubbles: true }));
    const press = new window.MouseEvent('mousedown', { bubbles: true, cancelable: true });
    link.dispatchEvent(press);
    assert.equal(press.defaultPrevented, true, 'a press takes no focus and starts no selection');
    const click = new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    link.dispatchEvent(click);
    assert.equal(click.defaultPrevented, true, 'a link does not navigate');
    assert.deepEqual(reached, [], "the component's own click handler never runs");
    const submit = new window.Event('submit', { bubbles: true, cancelable: true });
    window.document.querySelector('form').dispatchEvent(submit);
    assert.equal(submit.defaultPrevented, true, 'a form does not submit');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const gestures = posted.filter((data) => data.type === 'avb:component-preview-gesture').map((data) => data.gesture);
    assert.deepEqual(gestures, ['pointer', 'click'], 'the pointer coming in once, then the click; a move inside says nothing new');
  } finally {
    dom.window.close();
  }
});
