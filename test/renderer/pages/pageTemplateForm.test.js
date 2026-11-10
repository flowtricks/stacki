// Goal: the Pages panel's + offers both kinds of page in the app's menu, and the template
// form turns what a designer typed into a valid draft or one plain sentence.
// Method: the pure form model is driven field by field; the real panel and dialog are
// mounted in JSDOM with a fake bridge, clicked through, and their requests inspected.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const React = require('react');
const { act } = React;
const { repoPath, ROOT } = require('../../helpers/sources');
const output = repoPath('node_modules/.stacki-test/page-template-form.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
buildSync({
  stdin: {
    contents: `export { default as PagesPanel, pageCreateMenuItems } from './src/features/pages/PagesPanel';
    export * from './src/features/pages/pageTemplateForm';`,
    resolveDir: ROOT,
    loader: 'tsx',
  },
  outfile: output,
  bundle: true,
  format: 'cjs',
  platform: 'node',
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  loader: { '.css': 'empty' },
  logLevel: 'silent',
});
// React decides how to listen for input as it loads, so a document exists before it does.
const loading = new JSDOM('<!doctype html>', { pretendToBeVisual: true });
global.window = loading.window;
global.document = loading.window.document;
global.navigator = loading.window.navigator;
const form = require(output);

const CONNECTION = '00000000-0000-4000-8000-000000000000';
const contentForm = { ...form.EMPTY_TEMPLATE_FORM, route: '/blog/[slug]', collection: 'blog' };
const httpForm = {
  ...form.EMPTY_TEMPLATE_FORM,
  kind: 'http-json',
  route: '/items/[slug]',
  url: 'https://api.example.com/items',
  slugPath: 'id',
  fields: [{ path: 'title', kind: 'string' }],
};
const sanityForm = {
  ...httpForm,
  kind: 'sanity',
  url: '',
  connectionId: CONNECTION,
  sanityAccess: 'public',
  projectId: 'abc123',
  documentType: 'post',
  slugPath: 'slug.current',
};
const problem = (values) => {
  const draft = form.templateDraft(values, undefined);
  assert.equal(draft.ok, false);
  return draft.error;
};

test('defaults follow the source until the route is typed', () => {
  assert.equal(form.suggestedRoute('blog'), '/blog/[slug]');
  assert.equal(form.suggestedRoute('teamMembers'), '/team-members/[slug]');
  assert.equal(form.suggestedRoute('Blog posts'), '/blog-posts/[slug]');
  assert.equal(form.suggestedRoute(''), '/[slug]');
  const fields = (...paths) => paths.map((item) => ({ path: item, kind: 'string', example: '', address: { kind: 'exact' } }));
  assert.equal(form.suggestedSlugPath(fields('title', 'id', 'slug.current')), 'slug.current');
  assert.equal(form.suggestedSlugPath(fields('title', 'id')), 'id');
  assert.equal(form.suggestedSlugPath(fields('title')), 'title');
  assert.equal(form.suggestedSlugPath([{ path: 'tags', kind: 'list', example: '' }]), '');
  const list = { path: '', count: 1, fields: [...fields('title', 'slug.current'), { path: 'slug', kind: 'object', example: '' }] };
  assert.deepEqual(form.templateFields(list), [
    { path: 'title', kind: 'string' },
    { path: 'slug', kind: 'object' },
  ]);
  const full = Array.from({ length: 8 }, () => ({ name: 'A', env: 'A', scheme: 'plain' }));
  assert.equal(form.withHeaderRow(full).length, 8, 'rows stop at the limit');
  assert.equal(form.withHeaderRow([]).length, 1);
});

test('address choices lead with what works, explain what does not, and default safely', () => {
  const stat = (item, address) => ({ path: item, kind: 'string', example: '', address });
  const fields = [
    stat('Heading', { kind: 'unusable', reason: 'Two entries would share the address uptime' }),
    stat('Description', { kind: 'unusable', reason: 'Too long for a page address' }),
    stat('Number', { kind: 'slugified', example: '25' }),
    stat('code', { kind: 'exact' }),
    { path: 'featured', kind: 'boolean', example: 'true' },
  ];
  assert.deepEqual(form.addressOptions(fields, '/stats/[slug]'), [
    { value: 'code', label: 'code' },
    { value: 'Number', label: 'Number', description: 'Cleaned up: /stats/25' },
    { value: 'Heading', label: 'Heading', description: 'Two entries would share the address uptime', disabled: true },
    { value: 'Description', label: 'Description', description: 'Too long for a page address', disabled: true },
  ]);
  assert.equal(form.addressExample('/stats/[...path]', '25'), '/stats/25');
  assert.equal(form.addressExample('', '25'), '/25');
  assert.equal(form.suggestedSlugPath(fields), 'code', 'as-is beats slugified');
  assert.equal(form.suggestedSlugPath(fields.filter((field) => field.path !== 'code')), 'Number');
  assert.equal(form.suggestedSlugPath(fields.slice(0, 2)), '', 'an unusable field is never the default');
  assert.equal(form.slugTreatmentOf(fields, 'Number'), 'slugified');
  assert.equal(form.slugTreatmentOf(fields, 'code'), 'exact');
  assert.equal(form.EMPTY_TEMPLATE_FORM.contentSlug, form.ENTRY_ID);
  assert.equal(form.withFirstCollection(form.EMPTY_TEMPLATE_FORM, ['stats']).contentSlug, form.ENTRY_ID, 'the default stays Entry id');
});

test('a filled form becomes the draft for each source', () => {
  const layout = { name: 'Base', path: '/site/src/layouts/Base.astro' };
  const content = form.templateDraft(contentForm, layout);
  assert.deepEqual(content.ok && content.value.source, { kind: 'content-collection', collection: 'blog', origin: 'existing', slug: { kind: 'entry-id' } });
  assert.deepEqual(content.ok && content.value.layout, layout);
  const byField = form.templateDraft({ ...contentForm, contentSlug: 'path', slugTreatment: 'slugified' }, undefined);
  assert.deepEqual(byField.ok && byField.value.source.slug, { kind: 'field', name: 'path', treatment: 'slugified' });
  const created = form.templateDraft({ ...contentForm, collection: form.NEW_COLLECTION, newCollection: 'Blog posts' }, undefined);
  assert.deepEqual(created.ok && created.value.source, { kind: 'content-collection', collection: 'blogPosts', origin: 'new', slug: { kind: 'entry-id' } });
  const external = form.templateDraft({ ...httpForm, headers: [{ name: 'Authorization', env: 'API_TOKEN', scheme: 'bearer' }] }, undefined);
  assert.deepEqual(external.ok && external.value.source.headers, [{ name: 'Authorization', env: 'API_TOKEN', scheme: 'bearer' }]);
  const open = form.templateDraft(sanityForm, undefined);
  assert.equal(open.ok && open.value.source.tokenEnv, undefined, 'a public dataset needs no token');
  const closed = form.templateDraft({ ...sanityForm, sanityAccess: 'private' }, undefined);
  assert.equal(closed.ok && closed.value.source.tokenEnv, 'SANITY_API_TOKEN');
  const missing = [{ name: 'SANITY_API_TOKEN', state: 'missing' }];
  assert.deepEqual(form.connectionKeyCopy(sanityForm, missing), { connectionId: CONNECTION, env: 'SANITY_API_TOKEN' });
  assert.equal(form.connectionKeyCopy({ ...sanityForm, connectionKey: 'skip' }, missing), undefined);
  assert.equal(form.connectionKeyCopy(sanityForm, [{ name: 'SANITY_API_TOKEN', state: 'set' }]), undefined, 'a variable already set stays');
  assert.equal(form.connectionKeyCopy(contentForm, missing), undefined);
});

test('each missing or wrong value is named in a sentence', () => {
  assert.match(problem({ ...contentForm, route: '/blog' }), /needs a placeholder/);
  assert.match(problem({ ...contentForm, collection: '' }), /Choose a collection/);
  assert.match(problem({ ...contentForm, collection: form.NEW_COLLECTION, newCollection: '  ' }), /Name the collection/);
  assert.match(problem({ ...contentForm, collection: form.NEW_COLLECTION, newCollection: '9 lives' }), /starts with a letter/);
  assert.match(problem({ ...sanityForm, connectionId: '' }), /Connect Sanity/);
  assert.match(problem({ ...sanityForm, sanityAccess: 'unknown' }), /Reading what/);
  assert.match(problem({ ...sanityForm, documentType: '' }), /document type/);
  assert.match(problem({ ...httpForm, url: 'https://x.example/?api_key=1' }), /looks like a secret/);
  assert.match(problem({ ...httpForm, headers: [{ name: 'Bad Name', env: 'A', scheme: 'plain' }] }), /header name/);
  assert.match(problem({ ...httpForm, headers: [{ name: 'X-A', env: 'lower', scheme: 'plain' }] }), /capital letters/);
  assert.match(problem({ ...httpForm, slugPath: '' }), /Fetch a sample/);
  assert.match(problem({ ...httpForm, fields: [] }), /at least one field/);
});

function fixture(context, bridge = {}) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  require('../../helpers/popupDom').installPopupDOM(dom.window);
  dom.window.Element.prototype.scrollIntoView = () => {};
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  // CodeMirror measures and watches the page; JSDOM has no layout to measure.
  global.MutationObserver = dom.window.MutationObserver;
  global.requestAnimationFrame = dom.window.requestAnimationFrame;
  global.cancelAnimationFrame = dom.window.cancelAnimationFrame;
  dom.window.Range.prototype.getClientRects = () => [];
  dom.window.Range.prototype.getBoundingClientRect = () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 });
  const calls = { plan: [], sample: [], setEnv: [] };
  const plan = {
    ok: true,
    value: {
      route: '/blog/[slug]',
      env: [],
      changes: [{ path: 'src/pages/blog/[slug].astro', action: 'create', text: '---\nconst shown = true;\n---\n\n<h1>Hi</h1>\n' }],
    },
  };
  dom.window.avb = {
    contentCollections: async () => ({ collections: [{ name: 'blog', count: 2 }] }),
    cmsConnections: async () => ({ encryption: 'available', connections: [] }),
    contentRemoteRead: async () => ({ ok: true, value: { name: 'blog', source: undefined, fields: [] } }),
    planPageTemplate: async (input) => {
      calls.plan.push(input);
      return plan;
    },
    sampleDataSource: async (input) => {
      calls.sample.push(input);
      return {
        ok: true,
        value: {
          kind: 'lists',
          lists: [
            {
              path: 'items',
              count: 2,
              fields: [
                { path: 'id', kind: 'number', example: '7', address: { kind: 'exact' } },
                { path: 'title', kind: 'string', example: 'One', address: { kind: 'exact' } },
              ],
            },
          ],
        },
      };
    },
    setProjectEnv: async (input) => {
      calls.setEnv.push(input);
      return { ok: true, value: { gitignore: 'added' } };
    },
    ...bridge,
  };
  const { createRoot } = require('react-dom/client');
  const root = createRoot(document.getElementById('root'));
  context.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
  });
  return { dom, root, calls };
}

const panelProps = (overrides) => ({
  projectPath: '/site',
  scan: { pages: [], pageFolders: [], layouts: [] },
  currentPage: undefined,
  onSelect() {},
  onCreate() {},
  onCreateTemplate: async () => undefined,
  connectSanity: () => undefined,
  onDelete() {},
  onMovePage() {},
  onCreateFolder: async () => undefined,
  onRename: async () => {},
  onRenameFolder() {},
  onDeleteFolder() {},
  ...overrides,
});

const click = (element) => act(async () => element.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true })));
const byText = (selector, text) => [...document.querySelectorAll(selector)].find((element) => element.textContent.trim() === text);
const typeInto = (dom, input, value) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
const settled = () => act(async () => new Promise((resolve) => setTimeout(resolve, 300)));
// A sample tree draws the data picker's rows (ui/DataTree.tsx): a row by the name it shows.
const row = (label) => [...document.querySelectorAll('.page-template-popover .dp-row')].find((item) => item.querySelector('.dp-key').textContent === label);
const shownValue = (label) => row(label).querySelector('.dp-val').textContent;

test('+ opens a menu with both kinds, and Create page keeps today’s flow', async (context) => {
  const { root } = fixture(context);
  await act(async () => root.render(React.createElement(form.PagesPanel, panelProps())));
  await click(document.querySelector('button[title="New page"]'));
  const items = [...document.querySelectorAll('.more-menu [role="menuitem"]')];
  assert.deepEqual(
    items.map((item) => item.textContent),
    ['Create page', 'Create page template'],
  );
  assert.ok(
    items.every((item) => item.querySelector('svg')),
    'each row carries its icon',
  );
  await click(items[0]);
  await settled();
  assert.equal(document.querySelector('.modal-header').textContent, 'New Page');
});

test('Create page template plans from a chosen collection, shows the code, and creates', async (context) => {
  const { dom, root, calls } = fixture(context);
  const created = [];
  const props = panelProps({
    onCreateTemplate: async (draft) => {
      created.push(draft);
      return 'The disk is full.';
    },
  });
  await act(async () => root.render(React.createElement(form.PagesPanel, props)));
  await click(document.querySelector('button[title="New page"]'));
  await click(byText('.more-menu [role="menuitem"]', 'Create page template'));
  await settled();
  assert.equal(document.querySelector('.modal-header').textContent, 'Create page template');
  assert.ok(
    [...document.querySelectorAll('.modal .dd-label')].some((label) => label.textContent === 'blog'),
    'the first collection is chosen',
  );
  assert.match(document.querySelector('.page-template-address').textContent, /^yoursite\.com\/blog\//, 'the address is filled from it');
  assert.equal(document.querySelectorAll('.page-template-problem').length, 0, 'nothing is wrong yet');
  assert.ok(!document.querySelector('.modal-body').textContent.includes('Choose a collection'));
  assert.equal(byText('.modal-footer button', 'Create template').disabled, false, 'it can be created as it opens');
  assert.equal(calls.plan.at(-1).draft.source.collection, 'blog');
  await click(document.querySelector('.page-template-code-toggle'));
  const code = document.querySelector('.page-template-code');
  assert.match(code.textContent, /const shown = true;/);
  assert.equal(code.tagName, 'PRE', 'shown, not edited');
  assert.equal(document.querySelectorAll('.modal .dd-trigger').length, 0, 'the code takes the form’s place, so the dialog does not grow');
  assert.match(document.querySelector('.page-template-files h4').textContent, /New file src\/pages\/blog\/\[slug\]\.astro/);
  await click(document.querySelector('.page-template-code-toggle'));
  assert.ok(document.querySelector('.modal .dd-trigger'), 'the form comes back');
  await click(byText('.modal-footer button', 'Create template'));
  await settled();
  assert.equal(created.length, 1);
  assert.match(document.querySelector('.page-template-problem').textContent, /The disk is full/, 'a failure stays in the form');
});

test('the address select disables what cannot work and shows what a slugified one makes', async (context) => {
  const { root, calls } = fixture(context, {
    sampleDataSource: async () => ({
      ok: true,
      value: {
        kind: 'lists',
        lists: [
          {
            path: '',
            count: 2,
            fields: [
              { path: 'Number', kind: 'string', example: '25%', address: { kind: 'slugified', example: '25' } },
              { path: 'Heading', kind: 'string', example: 'Uptime', address: { kind: 'unusable', reason: 'Two entries would share the address uptime' } },
            ],
          },
        ],
      },
    }),
  });
  await act(async () => root.render(React.createElement(form.PagesPanel, panelProps())));
  await click(document.querySelector('button[title="New page"]'));
  await click(byText('.more-menu [role="menuitem"]', 'Create page template'));
  await settled();
  await click(byText('.page-template-trigger', 'Entry id'));
  assert.ok(row('Entry id').lastElementChild.matches('.dp-check'), 'the choice has its check at the right end');
  assert.match(row('Number').textContent, /Cleaned up: \/blog\/25/);
  assert.equal(row('Heading').getAttribute('aria-disabled'), 'true');
  assert.match(row('Heading').textContent, /would share the address uptime/);
  await click(row('Heading'));
  assert.ok(row('Entry id').classList.contains('selected'), 'a choice that cannot work is not taken');
  await click(row('Number'));
  await settled();
  assert.deepEqual(calls.plan.at(-1).draft.source.slug, { kind: 'field', name: 'Number', treatment: 'slugified' });
});

test('hovering a select’s option changes nothing until it is chosen', async (context) => {
  const { dom, root, calls } = fixture(context);
  await act(async () => root.render(React.createElement(form.PagesPanel, panelProps())));
  await click(document.querySelector('button[title="New page"]'));
  await click(byText('.more-menu [role="menuitem"]', 'Create page template'));
  await settled();
  const hover = async (label) => {
    await act(async () => byText('.dd-option', label).dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true })));
    await settled();
  };
  const planned = calls.plan.length;
  await click([...document.querySelectorAll('.modal button')].find((button) => button.textContent.includes('Content collection')));
  await hover('Data from a link');
  assert.equal(document.querySelectorAll('.modal input[placeholder^="https://api"]').length, 0, 'the source stays until chosen');
  await hover('Sanity');
  assert.equal(document.querySelectorAll('.page-template-connect').length, 0);
  assert.equal(calls.plan.length, planned, 'a hover plans nothing');
  await click(byText('.dd-option', 'Data from a link'));
  assert.equal(document.querySelectorAll('.modal input[placeholder^="https://api"]').length, 1, 'a click chooses it');
});

const SANITY_CONNECTION = { kind: 'sanity', id: CONNECTION, label: 'Marketing', projectId: 'abc123', dataset: 'production' };
const sanitySamples = (calls) => async (input) => {
  calls.sample.push(input);
  return input.request.kind === 'sanity-types'
    ? { ok: true, value: { kind: 'types', types: ['author', 'post'], access: 'private' } }
    : {
        ok: true,
        value: {
          kind: 'lists',
          lists: [
            {
              path: '',
              count: 1,
              fields: [
                { path: 'slug.current', kind: 'string', example: 'one', address: { kind: 'exact' } },
                { path: 'title', kind: 'string', example: 'One', address: { kind: 'exact' } },
              ],
            },
          ],
        },
      };
};
async function openSanity(root, props = panelProps()) {
  await act(async () => root.render(React.createElement(form.PagesPanel, props)));
  await click(document.querySelector('button[title="New page"]'));
  await click(byText('.more-menu [role="menuitem"]', 'Create page template'));
  await settled();
  await click([...document.querySelectorAll('.modal button')].find((button) => button.textContent.includes('Content collection')));
  await click(byText('.dd-option', 'Sanity'));
  await settled();
}

test('with a connection, Sanity asks for nothing typed and loads its types', async (context) => {
  const sample = { calls: { sample: [] } };
  const { root } = fixture(context, {
    cmsConnections: async () => ({ encryption: 'available', connections: [SANITY_CONNECTION] }),
    sampleDataSource: async (input) =>
      input.request.kind === 'content-collection' ? { ok: true, value: { kind: 'lists', lists: [] } } : sanitySamples(sample.calls)(input),
  });
  const created = [];
  await openSanity(root, panelProps({ onCreateTemplate: async (draft, keyCopy) => void created.push({ draft, keyCopy }) }));
  assert.match(document.querySelector('.modal-body').textContent, /Using Marketing: abc123, production\./);
  assert.equal(document.querySelectorAll('.modal input[type="password"]').length, 0, 'no token field');
  assert.equal(sample.calls.sample[0].request.connectionId, CONNECTION);
  assert.equal(document.querySelectorAll('.page-template-problem').length, 0);
  await click([...document.querySelectorAll('.modal button')].find((button) => button.textContent.includes('Choose a type')));
  await click(byText('.dd-option', 'post'));
  await settled();
  assert.equal(sample.calls.sample.at(-1).request.documentType, 'post');
  assert.match(document.querySelector('.page-template-address').textContent, /yoursite\.com\/post\/one/);
  assert.match(document.querySelector('.page-template-preview').textContent, /1 page, like: One/);
});

test('without a connection, Connect Sanity opens the sign-in and the form survives it', async (context) => {
  let connections = [];
  const sample = { calls: { sample: [] } };
  const { dom, root } = fixture(context, {
    cmsConnections: async () => ({ encryption: 'available', connections }),
    sampleDataSource: sanitySamples(sample.calls),
  });
  const popups = [];
  const connectSanity = (input) => {
    popups.push(input);
    return React.createElement('button', { 'data-connect-sanity': true, onClick: input.close });
  };
  await openSanity(root, panelProps({ connectSanity }));
  await click(byText('.page-template-preview button', 'Edit'));
  await typeInto(dom, document.querySelector('.modal input[placeholder="/blog/[slug]"]'), '/news/[slug]');
  await click(byText('.page-template-connect button', 'Connect Sanity'));
  await settled();
  assert.equal(popups[0].projectPath, '/site', 'the popup the app supplies opens for this project');
  assert.ok(document.querySelector('[data-connect-sanity]'));
  connections = [SANITY_CONNECTION];
  await click(document.querySelector('[data-connect-sanity]'));
  await settled();
  await settled();
  assert.equal(document.querySelectorAll('[data-connect-sanity]').length, 0);
  assert.match(document.querySelector('.modal-body').textContent, /Using Marketing/);
  assert.equal(document.querySelector('.modal input[placeholder="/blog/[slug]"]').value, '/news/[slug]', 'what was entered stays');
  assert.equal(sample.calls.sample.at(-1).request.kind, 'sanity-types', 'its types load on return');
});

test('the layout is asked for only when there is a choice, and never as “no layout”', async (context) => {
  const layout = (name) => ({ name, path: `/site/src/layouts/${name}.astro` });
  const open = async (root, layouts) => {
    const scan = { pages: [], pageFolders: [], layouts };
    await act(async () => root.render(React.createElement(form.PagesPanel, panelProps({ scan }))));
    await click(document.querySelector('button[title="New page"]'));
    await click(byText('.more-menu [role="menuitem"]', 'Create page template'));
    await settled();
  };
  const hasLayoutField = () => [...document.querySelectorAll('.modal label')].some((label) => label.textContent === 'Layout');
  const none = fixture(context);
  await open(none.root, []);
  assert.equal(hasLayoutField(), false);
  assert.equal(none.calls.plan.at(-1).draft.layout, undefined, 'no layout makes a plain page');
  await act(async () => none.root.unmount());
  const one = fixture(context);
  await open(one.root, [layout('Base')]);
  assert.equal(hasLayoutField(), false);
  assert.equal(one.calls.plan.at(-1).draft.layout.name, 'Base', 'the only layout is used');
  await act(async () => one.root.unmount());
  const two = fixture(context);
  await open(two.root, [layout('Base'), layout('Post')]);
  assert.equal(hasLayoutField(), true);
  assert.equal(two.calls.plan.at(-1).draft.layout.name, 'Base', 'the first leads');
  await click([...document.querySelectorAll('.modal button')].find((button) => button.textContent.includes('Base')));
  assert.deepEqual(
    [...document.querySelectorAll('.dd-option')].map((option) => option.textContent.trim()),
    ['Base', 'Post'],
  );
  await click(byText('.dd-option', 'Post'));
  await settled();
  assert.deepEqual(two.calls.plan.at(-1).draft.layout, layout('Post'), 'the chosen one reaches the page');
});

test('editing the address ends with Done, Enter, Escape or leaving, unless it cannot work', async (context) => {
  const { dom, root } = fixture(context);
  await act(async () => root.render(React.createElement(form.PagesPanel, panelProps())));
  await click(document.querySelector('button[title="New page"]'));
  await click(byText('.more-menu [role="menuitem"]', 'Create page template'));
  await settled();
  const input = () => document.querySelector('.page-template-preview input');
  const edit = () => click(byText('.page-template-preview button', 'Edit'));
  const key = (name) => act(async () => input().dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })));
  const shown = () => document.querySelector('.page-template-address')?.textContent;

  await edit();
  await typeInto(dom, input(), '/one/[slug]');
  await click(byText('.page-template-preview button', 'Done'));
  assert.match(shown(), /\/one\//, 'Done keeps the edit');

  await edit();
  await typeInto(dom, input(), '/two/[slug]');
  await key('Enter');
  assert.match(shown(), /\/two\//, 'Enter keeps the edit');

  await edit();
  await typeInto(dom, input(), '/three/[slug]');
  await act(async () => input().dispatchEvent(new dom.window.FocusEvent('focusout', { bubbles: true })));
  assert.match(shown(), /\/three\//, 'leaving keeps the edit');

  await edit();
  await typeInto(dom, input(), '/four/[slug]');
  await key('Escape');
  assert.match(shown(), /\/three\//, 'Escape takes it back');
  assert.ok(document.querySelector('.modal-header'), 'and leaves the dialog open');

  await edit();
  await typeInto(dom, input(), '/no-placeholder');
  await key('Enter');
  await click(byText('.page-template-preview button', 'Done'));
  await act(async () => input().dispatchEvent(new dom.window.FocusEvent('focusout', { bubbles: true })));
  assert.ok(input(), 'a route that cannot work stays open');
  assert.match(document.querySelector('.page-template-problem').textContent, /needs a placeholder/);
  await key('Escape');
  assert.match(shown(), /\/three\//, 'and Escape still gets out');
});

test('a project without collections leads with a new one, and stays quiet until touched', async (context) => {
  const { dom, root } = fixture(context, { contentCollections: async () => ({ collections: [] }) });
  await act(async () => root.render(React.createElement(form.PagesPanel, panelProps())));
  await click(document.querySelector('button[title="New page"]'));
  await click(byText('.more-menu [role="menuitem"]', 'Create page template'));
  await settled();
  const trigger = [...document.querySelectorAll('.modal button')].find((button) => button.textContent.includes('Choose a collection'));
  assert.ok(trigger, 'the empty choice says so');
  assert.equal(document.querySelectorAll('.page-template-problem').length, 0, 'no red before anything is done');
  await click(trigger);
  assert.equal(document.querySelector('.dd-option').textContent.trim(), 'New collection…');
  await click(document.querySelector('.dd-option'));
  await settled();
  assert.equal(document.querySelectorAll('.page-template-problem').length, 0, 'an unnamed collection is unfinished, not wrong');
  await typeInto(dom, document.querySelector('.modal input[placeholder="Blog posts"]'), '9 lives');
  await settled();
  assert.match(document.querySelector('.page-template-problem').textContent, /starts with a letter/);
});

test('each collection carries the CMS icon, and the new row keeps its plus', async (context) => {
  const { root } = fixture(context);
  await act(async () => root.render(React.createElement(form.PagesPanel, panelProps())));
  await click(document.querySelector('button[title="New page"]'));
  await click(byText('.more-menu [role="menuitem"]', 'Create page template'));
  await settled();
  await click([...document.querySelectorAll('.modal button')].find((button) => button.textContent.includes('Content collection')));
  const cms = byText('.dd-option', 'Data from a link').querySelector('.dd-icon svg').outerHTML;
  await click([...document.querySelectorAll('.modal button')].find((button) => button.textContent.includes('Content collection')));
  await click([...document.querySelectorAll('.modal button')].find((button) => button.textContent.trim() === 'blog'));
  const options = [...document.querySelectorAll('.dd-option')];
  assert.deepEqual(
    options.map((option) => option.textContent.trim()),
    ['blog', 'New collection…'],
  );
  assert.equal(options[0].querySelector('.dd-icon svg').outerHTML, cms, 'a collection shows the CMS icon');
  assert.notEqual(options[1].querySelector('.dd-icon svg').outerHTML, cms, 'the new row does not');
  assert.ok(options[1].querySelector('.dd-icon svg'), 'and keeps its plus');
});

test('the first collection fills the form, and leaves a choice or typed route alone', () => {
  const opened = form.withFirstCollection(form.EMPTY_TEMPLATE_FORM, ['stats', 'blog']);
  assert.equal(opened.collection, 'stats');
  assert.equal(opened.route, '/stats/[slug]');
  assert.equal(form.templateDraft(opened, undefined).ok, true);
  assert.equal(form.withFirstCollection(form.EMPTY_TEMPLATE_FORM, []), form.EMPTY_TEMPLATE_FORM);
  const chosen = { ...form.EMPTY_TEMPLATE_FORM, collection: form.NEW_COLLECTION };
  assert.equal(form.withFirstCollection(chosen, ['stats']), chosen);
  const typed = { ...form.EMPTY_TEMPLATE_FORM, route: '/mine/[slug]', routeSource: 'typed' };
  assert.equal(form.withFirstCollection(typed, ['stats']).route, '/mine/[slug]');
});

async function openJSON(root, props = panelProps()) {
  await act(async () => root.render(React.createElement(form.PagesPanel, props)));
  await click(document.querySelector('button[title="New page"]'));
  await click(byText('.more-menu [role="menuitem"]', 'Create page template'));
  await settled();
  await click([...document.querySelectorAll('.modal button')].find((button) => button.textContent.includes('Content collection')));
  await click(byText('.dd-option', 'Data from a link'));
}
const urlInput = () => document.querySelector('.modal input[placeholder^="https://api"]');
const debounced = () => act(async () => new Promise((resolve) => setTimeout(resolve, 700)));
const httpRequests = (calls) => calls.sample.filter((call) => call.request.kind === 'http-json');

test('a JSON address fetches by itself, once, after typing stops', async (context) => {
  const { dom, root, calls } = fixture(context);
  await openJSON(root);
  assert.equal(document.querySelectorAll('.page-template-refresh').length, 0, 'no refresh before an address');
  assert.equal(byText('.modal button', 'Fetch sample'), undefined);
  assert.equal(document.querySelectorAll('.page-template-problem').length, 0, 'no red before typing');
  await typeInto(dom, urlInput(), 'not an address');
  await debounced();
  assert.equal(httpRequests(calls).length, 0, 'an invalid address is not fetched');
  await typeInto(dom, urlInput(), 'https://api.example.com/pro');
  await typeInto(dom, urlInput(), 'https://api.example.com/products');
  assert.match(document.querySelector('.page-template-address').textContent, /yoursite\.com\/products\//, 'the address follows the link');
  assert.equal(httpRequests(calls).length, 0, 'it waits for typing to stop');
  await debounced();
  assert.equal(httpRequests(calls).length, 1, 'one fetch for the burst');
  await settled();
  assert.equal(httpRequests(calls)[0].request.url, 'https://api.example.com/products');
  const source = calls.plan.at(-1).draft.source;
  assert.equal(source.listPath, 'items');
  assert.equal(source.slugPath, 'id', 'an id is the default address');
  assert.ok(byText('.page-template-trigger', '2 fields · 2 items'));
  assert.match(document.querySelector('.page-template-preview').textContent, /2 pages, like: One/);
  assert.match(document.querySelector('.page-template-address').textContent, /yoursite\.com\/products\/7/);
  assert.equal(document.querySelectorAll('.page-template-problem').length, 0, 'the happy path has no red');
  assert.equal(byText('.modal-footer button', 'Create template').disabled, false, 'pasting a link is enough');
  await click(document.querySelector('.page-template-refresh'));
  await settled();
  assert.equal(httpRequests(calls).length, 2, 'Refresh fetches again');
});

test('leaving the field or pasting fetches at once, and an overtaken answer is dropped', async (context) => {
  const answers = [];
  const sampleOf = (name) => ({
    ok: true,
    value: { kind: 'lists', lists: [{ path: '', count: 1, fields: [{ path: name, kind: 'string', example: 'x', address: { kind: 'exact' } }] }] },
  });
  const { dom, root, calls } = fixture(context, {
    sampleDataSource: (input) => {
      if (input.request.kind !== 'http-json') {
        return Promise.resolve({ ok: true, value: { kind: 'lists', lists: [] } });
      }
      calls.sample.push(input);
      return new Promise((resolve) => answers.push(resolve));
    },
  });
  await openJSON(root);
  await typeInto(dom, urlInput(), 'https://api.example.com/first');
  await act(async () => urlInput().dispatchEvent(new dom.window.FocusEvent('focusout', { bubbles: true })));
  assert.equal(document.querySelector('.page-template-refresh').getAttribute('aria-busy'), 'true', 'a small loading state shows');
  await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  assert.equal(httpRequests(calls).length, 1, 'blur fetches without waiting');
  await act(async () => urlInput().dispatchEvent(new dom.window.Event('paste', { bubbles: true })));
  await typeInto(dom, urlInput(), 'https://api.example.com/second');
  await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
  assert.equal(httpRequests(calls).length, 1, 'one request in flight');
  await act(async () => answers[0](sampleOf('stale')));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
  assert.equal(httpRequests(calls).length, 2, 'the newest follows');
  await act(async () => answers[1](sampleOf('fresh')));
  await settled();
  assert.equal(calls.plan.at(-1).draft.source.slugPath, 'fresh', 'the older answer never lands');
});

test('headers live in a popover, start empty, and a secret goes to .env and leaves the form', async (context) => {
  const { dom, root, calls } = fixture(context);
  await openJSON(root);
  await typeInto(dom, urlInput(), 'https://api.example.com/products');
  await debounced();
  assert.equal(document.querySelectorAll('.page-template-header').length, 0, 'no header row on the form');
  await click(byText('.page-template-trigger', 'Headers (0)'));
  assert.equal(document.querySelectorAll('.page-template-header').length, 0, 'none by default');
  assert.match(document.querySelector('.page-template-popover').textContent, /Only needed if your link requires a key\./);
  await click(byText('.page-template-popover button', 'Add header'));
  await settled();
  assert.equal(document.querySelectorAll('.modal-body .page-template-problem').length, 0, 'an empty row blocks nothing');
  assert.equal(document.querySelectorAll('.page-template-header-send').length, 0, 'an empty row asks nothing more');
  assert.equal(byText('.modal-footer button', 'Create template').disabled, false);
  await typeInto(dom, document.querySelector('input[placeholder="Authorization"]'), 'Authorization');
  await typeInto(dom, document.querySelector('input[placeholder="API_TOKEN"]'), 'API_TOKEN');
  assert.equal(document.querySelectorAll('.page-template-header-send').length, 1, 'a row with content can say how it is sent');
  await typeInto(dom, document.querySelector('input[type="password"]'), 'sk-secret');
  await click(byText('button', 'Save to .env'));
  await settled();
  assert.deepEqual(
    calls.setEnv.map(({ name, value }) => [name, value]),
    [['API_TOKEN', 'sk-secret']],
  );
  assert.equal(document.querySelector('input[type="password"]').value, '', 'the form forgets it');
  await debounced();
  assert.deepEqual(httpRequests(calls).at(-1).request.headers, [{ name: 'Authorization', env: 'API_TOKEN', scheme: 'plain' }], 'editing headers fetches again');
  assert.ok(!JSON.stringify(calls.plan).includes('sk-secret'), 'a plan request never carries the secret');
});

test('a unique number is an address as it stands, and id leads the default', () => {
  const { fieldsOf } = require('#dist/electron/content/dataSample.js');
  const { parseDataSample } = require('#dist/shared/properties/pageTemplate.js');
  const items = Array.from({ length: 100 }, (_item, index) => ({ userId: Math.floor(index / 10), id: index + 1, title: `title ${index}` }));
  const { lists } = parseDataSample({ kind: 'lists', lists: [{ path: '', count: 100, fields: fieldsOf(items) }] });
  const { fields } = lists[0];
  assert.deepEqual(fields.find((field) => field.path === 'id').address, { kind: 'exact' });
  assert.deepEqual(
    form
      .addressOptions(fields, '/posts/[slug]')
      .slice(0, 2)
      .map((option) => option.value),
    ['id', 'title'],
    'the crossing keeps every field offered',
  );
  assert.equal(form.withSampleLists(form.EMPTY_TEMPLATE_FORM, lists).slugPath, 'id');
  assert.equal(form.suggestedSlugPath(fields), 'id');
  assert.match(fields.find((field) => field.path === 'userId').address.reason, /share the address/);
  assert.equal(form.suggestedSlugPath(fieldsOf([{ slug: 'a', id: 1 }])), 'slug', 'a slug beats an id');
});

test('empty header rows are ignored, and a half-typed one says what is missing', () => {
  const blank = { name: ' ', env: '', scheme: 'plain' };
  assert.deepEqual(form.headersOf([blank]), { ok: true, value: [] });
  assert.equal(form.templateDraft({ ...httpForm, headers: [blank] }, undefined).ok, true);
  assert.match(problem({ ...httpForm, headers: [{ ...blank, env: 'API_TOKEN' }] }), /header name/);
  assert.match(problem({ ...httpForm, headers: [{ ...blank, name: 'X-A' }] }), /capital letters/);
});

test('the preview says what will be made, in plain words', () => {
  const list = {
    path: '',
    count: 100,
    fields: [
      { path: 'id', kind: 'number', example: '1', address: { kind: 'exact' } },
      { path: 'title', kind: 'string', example: 'sunt aut facere', address: { kind: 'slugified', example: 'sunt-aut-facere' } },
    ],
  };
  const base = { ...httpForm, route: '/posts/[slug]', slugPath: 'id' };
  assert.deepEqual(form.pagePreview(base, list), { pages: 100, title: 'sunt aut facere', address: 'yoursite.com/posts/1' });
  assert.equal(form.pagePreview({ ...base, slugPath: 'title' }, list).address, 'yoursite.com/posts/sunt-aut-facere');
  assert.equal(form.pagePreview({ ...contentForm, route: '/posts/[slug]' }, list).address, 'yoursite.com/posts/…', 'an entry’s id is known only to Astro');
});

const treeList = {
  path: '',
  count: 3,
  fields: [
    { path: 'title', kind: 'string', example: 'One', examples: ['One', 'Two', 'Three'], address: { kind: 'exact' } },
    { path: 'author', kind: 'object', example: 'object', examples: ['object', 'object', 'object'] },
    { path: 'author.name', kind: 'string', example: 'Ada', examples: ['Ada', 'Bo', 'Cy'], address: { kind: 'exact' } },
    {
      path: 'author.age',
      kind: 'number',
      example: '30',
      examples: ['30', '30', '30'],
      address: { kind: 'unusable', reason: 'Two entries would share the address 30' },
    },
  ],
};

test('a sample shows its structure, and a search shows matches by their whole path', () => {
  const paths = (rows) => rows.map((row) => [row.label, row.depth]);
  assert.deepEqual(paths(form.sampleTreeRows(treeList, new Set(), '')), [
    ['title', 0],
    ['author', 0],
  ]);
  assert.deepEqual(paths(form.sampleTreeRows(treeList, new Set(['author']), '')), [
    ['title', 0],
    ['author', 0],
    ['name', 1],
    ['age', 1],
  ]);
  assert.equal(form.sampleTreeRows(treeList, new Set(), '')[1].expandable, true);
  assert.deepEqual(paths(form.sampleTreeRows(treeList, new Set(), 'NAME')), [['author.name', 0]]);
  assert.deepEqual(paths(form.sampleTreeRows(treeList, new Set(), 'bo')), [['author.name', 0]], 'a later item’s value matches too');
  assert.equal(form.steppedItem(0, 3, -1), 2);
  assert.equal(form.steppedItem(2, 3, 1), 0);
  assert.equal(form.sampleItemCount(treeList), 3);
  assert.equal(form.sampleItemCount({ ...treeList, fields: [] }), 0, 'a sample with no fields has nothing to step through');
  assert.equal(form.sampleRowPreview(treeList, 'author', 0), '2 fields', 'an object reads as the picker’s object rows do');
  assert.equal(form.sampleRowPreview(treeList, 'author.name', 2), 'Cy');
  assert.equal(form.sampleRowPreview({ ...treeList, fields: [{ path: 'meta', kind: 'object', example: 'object' }] }, 'meta', 0), '{}');
  assert.equal(form.sampleRowPreview(treeList, 'missing', 0), '');
  assert.throws(() => form.sampleRowPreview(treeList, 'title', -1), /an item is not negative/);
});

test('a field is kept by itself or inside its object, and unticking part keeps the rest', () => {
  const whole = form.templateFields(treeList);
  assert.deepEqual(whole, [
    { path: 'title', kind: 'string' },
    { path: 'author', kind: 'object' },
  ]);
  assert.equal(form.isFieldChosen(whole, 'author.name'), true);
  assert.equal(form.allFieldsChosen(whole, treeList), true);
  const part = form.toggledFields(whole, treeList, 'author.age');
  assert.deepEqual(part, [
    { path: 'title', kind: 'string' },
    { path: 'author.name', kind: 'string' },
  ]);
  assert.equal(form.allFieldsChosen(part, treeList), false);
  assert.deepEqual(
    form.toggledFields(part, treeList, 'author'),
    [
      { path: 'title', kind: 'string' },
      { path: 'author', kind: 'object' },
    ],
    'ticking an object takes in its fields',
  );
  assert.deepEqual(form.toggledFields(part, treeList, 'title'), [{ path: 'author.name', kind: 'string' }]);
  assert.deepEqual(form.fieldsAfterDeselect(treeList, 'author.name'), [{ path: 'author.name', kind: 'string' }], 'the address field stays');
});

test('the fields popover searches, steps through items on the item row, and selects all or all but the address', async (context) => {
  const { dom, root, calls } = fixture(context, {
    sampleDataSource: async (input) => ({ ok: true, value: { kind: 'lists', lists: input.request.kind === 'http-json' ? [treeList] : [] } }),
  });
  await openJSON(root);
  await typeInto(dom, urlInput(), 'https://api.example.com/books');
  await debounced();
  await settled();
  await click(byText('.page-template-trigger', '2 fields · 3 items'));
  assert.ok(document.querySelector('.page-template-popover .data-picker .dp-search input[placeholder="Search data…"]'), 'the data picker’s search');
  assert.equal(row('item').querySelector('.dp-item-count').textContent, '1/3', 'the stepper sits on the item’s row');
  assert.equal(shownValue('title'), 'One');
  await click(row('item').querySelector('button[title="Next item"]'));
  assert.equal(shownValue('title'), 'Two', 'the arrows show the next item’s values');
  assert.equal(row('item').querySelector('.dp-item-count').textContent, '2/3');
  await click(row('author').querySelector('.dp-twist[title="Open"]'));
  assert.equal(shownValue('name'), 'Bo', 'nested fields open under their object');
  await click(byText('.page-template-popover button', 'Deselect all'));
  await settled();
  assert.deepEqual(calls.plan.at(-1).draft.source.fields, [{ path: 'title', kind: 'string' }], 'the address field stays');
  await click(byText('.page-template-popover button', 'Select all'));
  await settled();
  assert.equal(calls.plan.at(-1).draft.source.fields.length, 2);
  await typeInto(dom, document.querySelector('.page-template-popover input[aria-label="Search the data"]'), 'NAME');
  assert.deepEqual(
    [...document.querySelectorAll('.page-template-popover .dp-row .dp-key')].map((key) => key.textContent),
    ['author.name'],
    'a search lists matches by their whole path, as the data picker’s does',
  );
  await typeInto(dom, document.querySelector('.page-template-popover input[aria-label="Search the data"]'), 'zzz');
  assert.match(document.querySelector('.page-template-popover .dp-list').textContent, /Nothing matches/);
});

test('a nested object shows indented and collapsible, and choosing its fields is what the dialog sends', async (context) => {
  const { dom, root, calls } = fixture(context, {
    sampleDataSource: async (input) => ({ ok: true, value: { kind: 'lists', lists: input.request.kind === 'http-json' ? [treeList] : [] } }),
  });
  await openJSON(root);
  await typeInto(dom, urlInput(), 'https://api.example.com/books');
  await debounced();
  await settled();
  await click(byText('.page-template-trigger', '2 fields · 3 items'));
  const indent = (label) => Number.parseFloat(row(label).style.paddingLeft);
  assert.equal(shownValue('author'), '2 fields', 'an object says how many fields it holds');
  assert.equal(row('name'), undefined, 'an object starts closed');
  await click(row('author').querySelector('.dp-twist'));
  assert.ok(row('author').querySelector('.dp-twist').classList.contains('open'));
  assert.ok(indent('name') > indent('author'), 'a nested field steps in under its object');
  assert.equal(indent('title'), indent('author'), 'siblings line up');
  assert.ok(indent('author') > indent('item'), 'the item’s fields sit under the item’s row');
  assert.ok(row('name').classList.contains('selected'), 'a field inside a kept object is kept');
  assert.ok(row('name').querySelector('.dp-check-slot').nextElementSibling === null, 'the check ends the row');
  assert.equal(row('title').querySelector('.dp-check-slot svg') !== null, true);
  await click(row('age'));
  await settled();
  assert.deepEqual(
    calls.plan.at(-1).draft.source.fields,
    [
      { path: 'title', kind: 'string' },
      { path: 'author.name', kind: 'string' },
    ],
    'clearing one field of a kept object keeps the rest',
  );
  assert.equal(row('author').classList.contains('selected'), false);
  await click(row('author'));
  await settled();
  assert.deepEqual(calls.plan.at(-1).draft.source.fields, [
    { path: 'title', kind: 'string' },
    { path: 'author', kind: 'object' },
  ]);
  assert.ok(row('age').classList.contains('selected'), 'choosing an object chooses its fields');
  await click(row('author'));
  await settled();
  assert.deepEqual(calls.plan.at(-1).draft.source.fields, [{ path: 'title', kind: 'string' }], 'clearing an object clears its fields');
  assert.equal(row('name').classList.contains('selected'), false);
  await click(row('author').querySelector('.dp-twist'));
  assert.equal(row('name'), undefined, 'the object closes again');
  await click(row('item').querySelector('.dp-twist'));
  assert.equal(row('title'), undefined, 'the item’s row closes its fields');
});

test('a nested field can address the pages', async (context) => {
  const list = {
    ...treeList,
    fields: treeList.fields.map((field) =>
      field.path === 'title' ? { ...field, address: { kind: 'unusable', reason: 'Too long for a page address' } } : field,
    ),
  };
  const { dom, root, calls } = fixture(context, {
    sampleDataSource: async (input) => ({ ok: true, value: { kind: 'lists', lists: input.request.kind === 'http-json' ? [list] : [] } }),
  });
  await openJSON(root);
  await typeInto(dom, urlInput(), 'https://api.example.com/books');
  await debounced();
  await settled();
  assert.equal(calls.plan.at(-1).draft.source.slugPath, 'author.name', 'the default reaches inside objects');
  await click(byText('.page-template-trigger', 'author.name'));
  await click(row('author').querySelector('.dp-twist[title="Open"]'));
  assert.ok(row('name').classList.contains('selected'));
  assert.ok(row('name').lastElementChild.matches('.dp-check'));
});

test('what the form sends passes the real boundary, with a hidden layout and nested fields', () => {
  const { parseIpcPayload } = require('#dist/shared/ipc/ipcPayloads.js');
  const values = {
    ...httpForm,
    url: 'https://jsonplaceholder.typicode.com/posts',
    route: '/posts/[slug]',
    fields: [
      { path: 'title', kind: 'string' },
      { path: 'author.name', kind: 'string' },
    ],
  };
  const draft = form.templateDraft(values, undefined);
  assert.equal(draft.ok, true);
  // IPC carries a structured clone, so what crosses is plain data.
  const sent = JSON.parse(JSON.stringify({ projectPath: '/site', draft: draft.value }));
  assert.equal('layout' in sent.draft, false, 'a hidden layout is simply absent');
  const parsed = parseIpcPayload('pageTemplate:plan', sent);
  assert.deepEqual(parsed.draft.source.fields, values.fields);
  assert.equal(parsed.draft.layout, undefined);
  assert.throws(
    () =>
      parseIpcPayload('pageTemplate:plan', {
        ...sent,
        draft: { ...sent.draft, source: { ...sent.draft.source, fields: [{ name: 'title', kind: 'string' }] } },
      }),
    /Expected string/,
    'the old field shape is what a stale main process refuses',
  );
});

test('a failure no form value caused reads as a sentence, and the detail goes to the console', async (context) => {
  const { root } = fixture(context, {
    planPageTemplate: async () => {
      throw new Error("Error invoking remote method 'pageTemplate:plan': Error: Expected string");
    },
  });
  const logged = [];
  context.mock.method(console, 'error', (...items) => logged.push(items.join(' ')));
  await act(async () => root.render(React.createElement(form.PagesPanel, panelProps())));
  await click(document.querySelector('button[title="New page"]'));
  await click(byText('.more-menu [role="menuitem"]', 'Create page template'));
  await settled();
  await settled();
  const shown = document.querySelector('.modal-body').textContent;
  assert.ok(shown.includes(form.UNEXPECTED_FAILURE));
  assert.ok(!shown.includes('remote method'));
  assert.ok(logged.some((line) => line.includes('remote method')));
});

test('a sample keeps what was chosen while the data still has it', () => {
  const field = (path) => ({ path, kind: 'string', example: '', address: { kind: 'exact' } });
  const lists = [
    { path: 'a', count: 1, fields: [field('id'), field('code')] },
    { path: 'b', count: 1, fields: [field('slug')] },
  ];
  const first = form.withSampleLists(form.EMPTY_TEMPLATE_FORM, lists);
  assert.equal(first.listPath, 'a');
  assert.equal(first.slugPath, 'id');
  const chosen = { ...first, listPath: 'b', slugPath: 'slug', fields: [] };
  assert.equal(form.withSampleLists(chosen, lists).fields.length, 0, 'a refresh keeps the picks');
  assert.equal(form.withSampleLists({ ...first, slugPath: 'gone' }, lists).slugPath, 'id', 'a pick the data lost is replaced');
  assert.equal(form.fieldsSummary(4, 100), '4 fields · 100 items');
  assert.equal(form.fieldsSummary(1, 1), '1 field · 1 item');
  assert.equal(form.unfinishedQuietly({ ...httpForm, slugPath: '' }), true);
  assert.equal(form.unfinishedQuietly({ ...httpForm, url: 'nope', slugPath: '' }), false);
});

test('getStaticPaths’ locals stay out of a page’s scope, however its body is written', () => {
  const { parseDeclarations } = require('../../helpers/rendererModule')('src/editor/dataSource.ts');
  const frontmatter = `const before = 1;
export async function getStaticPaths({ paginate }) {
  // Don't count this brace: {
  const entries = await getCollection("blog");
  const label = "}";
  return entries.map((entry) => ({ params: { slug: entry.id } }));
}
const after = 2;`;
  assert.deepEqual([...parseDeclarations(frontmatter).keys()], ['before', 'after']);
  assert.deepEqual([...parseDeclarations('const a = 1;\nfunction helper() {\n  const b = 2;\n}\n').keys()], ['a', 'b'], 'other functions read as they did');
});
