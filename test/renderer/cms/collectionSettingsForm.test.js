// Goal: a field added in a collection's settings reaches the content config, and nothing a person
// types in that form is lost on the way (GitHub issue #75: the field vanished on Save with "A field
// name starts with a letter…", because the form staged any name, the IPC boundary refused it, and
// the refusal showed the config as it stood). A name with spaces becomes a key, an unfinished form
// is not sent, a name that cannot be saved is said next to the field and stays, and a refusal from
// the config keeps every change that did not reach it.
// The field-type picker's tiles are all one shape (an icon and a name); the kinds that need a word (List, Group)
// explain themselves in the app's delayed tooltip, which waits for a resting pointer or for focus, and is gone
// on leaving, clicking, blurring and Escape.
// A group is configured like a collection: its fields are added, named, given a type (with the type's icon), help text
// and checks, and written to the config as z.object({ … }); a list of groups does the same for each item.
// Method: the real settings view is mounted over a project held in memory. Requests pass the real
// renderer boundary, and the host runs the real schema editor on a config text, so each test can
// read what Save wrote. The test drives the form by clicking and typing, as a person does.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { editCollectionSchema, readCollectionSchema } = require('#dist/electron/content/astroSchemaEdit.js');
const { repoPath } = require('../../helpers/sources.js');

const output = repoPath('node_modules/.stacki-test/collection-settings-form.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
buildSync({
  entryPoints: [repoPath('src/features/cms/RemoteCollectionSettings.tsx')],
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  loader: { '.css': 'empty' },
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  logLevel: 'silent',
});
const dom = new JSDOM('<!doctype html>', { pretendToBeVisual: true, url: 'http://localhost/' });
global.window = dom.window;
for (const name of ['document', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'Element', 'Node', 'localStorage']) {
  global[name] = dom.window[name];
}
global.IS_REACT_ACT_ENVIRONMENT = true;
global.ResizeObserver = class {
  observe() {}
  disconnect() {}
};
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const { RemoteCollectionSettings } = require(output);

const ASTRO_CONTENT = { kind: 'astro', id: '00000000-0000-4000-8000-00000a57c0de', label: 'Content' };
const CONFIG = [
  "import { defineCollection, reference, z } from 'astro:content';",
  "import { glob } from 'astro/loaders';",
  '',
  'const blog = defineCollection({',
  "  loader: glob({ base: './src/content/blog', pattern: '**/*.md' }),",
  '  schema: ({ image }) => z.object({',
  '    title: z.string(),',
  '  }),',
  '});',
  '',
  'export const collections = { blog };',
  '',
].join('\n');

// Every kind the picker offers, by the label on its tile.
const KIND_TILES = [
  'Plain text',
  'Rich text',
  'Image',
  'Multi-image',
  'Video link',
  'Link',
  'Email',
  'Phone',
  'Number',
  'Date/Time',
  'Switch',
  'Color',
  'Option',
  'File',
  'Reference',
  'Multi-reference',
  'List',
  'Group',
  'Key–value',
  'Constant',
  'Any value',
];

// A project in memory: `refuse` answers an edit with a failure, as a config the editor cannot change.
async function mount(options = {}) {
  const project = { config: CONFIG, sent: [], refuse: options.refuse ?? (() => undefined) };
  const settings = () => {
    const read = readCollectionSchema(project.config, 'blog');
    assert.equal(read.ok, true, 'the config stays readable');
    return { name: 'blog', source: read.value.source, fields: read.value.fields };
  };
  window.avb = {
    contentRemoteRead: async ({ request }) =>
      request.operation === 'collections'
        ? {
            ok: true,
            value: [
              { name: 'blog', count: 0 },
              { name: 'authors', count: 0 },
            ],
          }
        : { ok: true, value: settings() },
    contentRemoteEdit: async ({ request }) => {
      project.sent.push(request.change);
      const refused = project.refuse(request.change);
      if (refused !== undefined) {
        return { ok: false, message: refused };
      }
      const edit = editCollectionSchema(project.config, 'blog', request.change);
      if (!edit.ok) {
        return { ok: false, message: edit.error };
      }
      project.config = edit.value.text;
      return { ok: true, value: settings() };
    },
  };
  const selected = [];
  const container = document.body.appendChild(document.createElement('div'));
  const root = createRoot(container);
  await act(async () =>
    root.render(
      React.createElement(RemoteCollectionSettings, {
        projectPath: '/project',
        selection: { connection: ASTRO_CONTENT, collection: 'blog', item: undefined, mode: 'settings' },
        onSelect: (selection) => selected.push(selection),
        onSaved: () => undefined,
      }),
    ),
  );
  const button = (label) => {
    const found = [...container.querySelectorAll('button')].find((each) => each.textContent.trim() === label);
    assert.notEqual(found, undefined, `the ${label} button shows`);
    return found;
  };
  const click = (element) => act(async () => element.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
  const nameInput = () => container.querySelector('.field-settings input') ?? undefined;
  const typeName = (name) =>
    act(async () => {
      const input = nameInput();
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, name);
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  const openForm = async (tile) => {
    await click(button('Add field'));
    await click(button(tile));
  };
  const addField = async (tile, name) => {
    await openForm(tile);
    await typeName(name);
    await click(button('Add field'));
  };
  const openRow = () => click(container.querySelector('.remote-cms-settings-field'));
  const rows = () => [...container.querySelectorAll('.remote-cms-settings-field .remote-cms-settings-name')].map((row) => row.textContent);
  const problem = () => container.querySelector('.field-settings .remote-cms-problem:not(.is-note)')?.textContent;
  const note = () => container.querySelector('.field-settings .remote-cms-problem.is-note')?.textContent;
  const close = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  return { container, project, selected, button, click, nameInput, typeName, openForm, addField, openRow, rows, problem, note, close };
}

test('the reported sequence: a name with a space survives Add and Save and reaches the config', async () => {
  const form = await mount();
  await form.addField('Plain text', 'My Field');
  assert.deepEqual(form.rows(), ['title', 'my-field'], 'the row shows the key it is saved as');
  await form.click(form.button('Save collection'));
  assert.equal(form.project.sent.length, 1, 'the field was sent');
  assert.equal(form.project.sent[0].name, 'my-field');
  assert.match(form.project.config, /"my-field": z\.string\(\)\.optional\(\),/, 'the config states the field');
  assert.equal(form.selected.at(-1)?.mode, undefined, 'a whole save returns to the items');
  await form.close();
});

test('a name that is already a key is saved as it is typed', async () => {
  const form = await mount();
  for (const name of ['heroImage', 'hero_image', 'hero-image']) {
    await form.addField('Plain text', name);
  }
  assert.deepEqual(form.rows(), ['title', 'heroImage', 'hero_image', 'hero-image']);
  await form.click(form.button('Save collection'));
  assert.match(form.project.config, /heroImage: z\.string\(\)\.optional\(\),/);
  assert.match(form.project.config, /hero_image: z\.string\(\)\.optional\(\),/);
  assert.match(form.project.config, /"hero-image": z\.string\(\)\.optional\(\),/);
  await form.close();
});

test('the key a typed label becomes is shown before it is added', async () => {
  const form = await mount();
  await form.openForm('Plain text');
  await form.typeName('My Field');
  assert.match(form.note(), /my-field/);
  assert.equal(form.problem(), undefined, 'a label is not a problem');
  await form.typeName('myField');
  assert.equal(form.note(), undefined, 'a key needs no note');
  await form.close();
});

test('Save collection saves a field still open in its form', async () => {
  const form = await mount();
  await form.openForm('Number');
  await form.typeName('Read Count');
  assert.equal(form.button('Save collection').disabled, false, 'a named field is a change to save');
  await form.click(form.button('Save collection'));
  assert.equal(form.project.sent.length, 1);
  assert.match(form.project.config, /"read-count": z\.number\(\)\.optional\(\),/);
  await form.close();
});

test('Save collection also saves an open form beside changes already made', async () => {
  const form = await mount();
  await form.addField('Plain text', 'subtitle');
  await form.openForm('Switch');
  await form.typeName('featured');
  await form.click(form.button('Save collection'));
  assert.deepEqual(
    form.project.sent.map((change) => change.name),
    ['subtitle', 'featured'],
  );
  await form.close();
});

test('an unfinished form is neither an error nor sent', async () => {
  const form = await mount();
  await form.openForm('Plain text');
  assert.equal(form.problem(), undefined, 'an untouched name is no problem');
  assert.equal(form.button('Save collection').disabled, true, 'nothing to save yet');
  await form.typeName('   ');
  assert.equal(form.problem(), undefined, 'spaces are not a name, and not a mistake either');
  assert.equal(form.button('Save collection').disabled, true);
  assert.equal(form.nameInput().value, '   ', 'the form stays as it is');
  await form.close();
});

test('an unfinished form leaves the changes beside it to save', async () => {
  const form = await mount();
  await form.addField('Plain text', 'subtitle');
  await form.openForm('Plain text');
  await form.click(form.button('Save collection'));
  assert.deepEqual(
    form.project.sent.map((change) => change.name),
    ['subtitle'],
    'the empty row was not sent',
  );
  assert.equal(form.problem(), undefined);
  await form.close();
});

test('a name that cannot become a key says so at the field and keeps the row and the text', async () => {
  for (const typed of ['9 lives', '!!!', '日本語', 'x'.repeat(65)]) {
    const form = await mount();
    await form.openForm('Plain text');
    await form.typeName(typed);
    assert.match(form.problem(), /field name/i, `${typed} is refused at the field`);
    assert.equal(form.button('Add field').disabled, true, 'it cannot be added');
    assert.equal(form.button('Save collection').disabled, true, 'it cannot be saved past');
    assert.equal(form.nameInput().value, typed, 'what was typed stays');
    assert.equal(form.project.sent.length, 0, 'nothing was sent');
    await form.typeName('fixed');
    assert.equal(form.problem(), undefined, 'the message goes with the problem');
    await form.close();
  }
});

test('a name already taken is said at the field, by the key it would be saved as', async () => {
  const form = await mount();
  await form.addField('Plain text', 'My Field');
  await form.openForm('Number');
  await form.typeName('my field');
  assert.match(form.problem(), /my-field already exists/);
  assert.equal(form.nameInput().value, 'my field');
  await form.typeName('Title');
  assert.equal(form.problem(), undefined, 'a key differs from another by case');
  await form.close();
});

test('every kind of field is added and written, one after another in a single save', async () => {
  const form = await mount();
  const keys = [];
  for (const [index, tile] of KIND_TILES.entries()) {
    const label = `Field ${String(index + 1)}`;
    await form.addField(tile, label);
    keys.push(`field-${String(index + 1)}`);
  }
  assert.deepEqual(form.rows(), ['title', ...keys]);
  await form.click(form.button('Save collection'));
  assert.equal(form.project.sent.length, KIND_TILES.length, 'every field was sent');
  const read = readCollectionSchema(form.project.config, 'blog');
  assert.deepEqual(
    read.value.fields.map((field) => field.name),
    ['title', ...keys],
    'the config states every field, in order',
  );
  await form.close();
});

test('a reference waits for its collection and names it', async () => {
  const form = await mount();
  await form.addField('Reference', 'Written By');
  await form.click(form.button('Save collection'));
  assert.equal(form.project.sent[0].target, 'blog', 'the first collection is the starting choice');
  assert.match(form.project.config, /"written-by": reference\("blog"\)\.optional\(\),/);
  await form.close();
});

test('renaming a field in its form keeps its settings and takes a label', async () => {
  const form = await mount();
  await form.openRow();
  await form.typeName('Post Title');
  assert.match(form.note(), /post-title/);
  await form.click(form.button('Save field'));
  assert.deepEqual(form.rows(), ['post-title']);
  await form.click(form.button('Save collection'));
  assert.deepEqual(form.project.sent[0], { kind: 'renameField', from: 'title', to: 'post-title' });
  assert.match(form.project.config, /"post-title": z\.string\(\)/);
  await form.close();
});

test('an open field that cannot be renamed keeps its form, and an emptied name is said there', async () => {
  const form = await mount();
  await form.openRow();
  await form.typeName('');
  assert.match(form.problem(), /Name the field/);
  await form.typeName('9 lives');
  assert.match(form.problem(), /field name/i);
  assert.equal(form.button('Save field').disabled, true);
  assert.equal(form.nameInput().value, '9 lives');
  await form.close();
});

test('a refusal from the config keeps the refused field and every change after it', async () => {
  const form = await mount({ refuse: (change) => (change.name === 'second' ? 'The config changed on disk.' : undefined) });
  await form.addField('Plain text', 'first');
  await form.addField('Plain text', 'second');
  await form.addField('Plain text', 'third');
  await form.click(form.button('Save collection'));
  assert.deepEqual(form.rows(), ['title', 'first', 'second', 'third'], 'no row left the list');
  assert.match(form.project.config, /first:/, 'the field before the refusal was written');
  assert.doesNotMatch(form.project.config, /second:|third:/);
  assert.equal(form.selected.length, 0, 'the settings stay open');
  assert.equal(form.button('Save collection').disabled, false, 'what is left can be saved again');
  form.project.refuse = () => undefined;
  await form.click(form.button('Save collection'));
  assert.deepEqual(
    form.project.sent.map((change) => change.name),
    ['first', 'second', 'second', 'third'],
    'the retry sends only what did not land',
  );
  assert.match(form.project.config, /second:/);
  assert.match(form.project.config, /third:/);
  await form.close();
});

test('an open form flushed into a refused save stays in the list and is not sent twice', async () => {
  const form = await mount({ refuse: () => 'The config changed on disk.' });
  await form.openForm('Plain text');
  await form.typeName('subtitle');
  await form.click(form.button('Save collection'));
  assert.deepEqual(form.rows(), ['title', 'subtitle'], 'the field is a staged row now');
  assert.equal(form.nameInput(), undefined, 'its form closed, so it cannot be staged twice');
  form.project.refuse = () => undefined;
  await form.click(form.button('Save collection'));
  assert.equal(form.project.sent.filter((change) => change.name === 'subtitle').length, 2, 'one refused, one written');
  assert.match(form.project.config, /subtitle: z\.string\(\)\.optional\(\),/);
  await form.close();
});

test('a new list says what its items are, and Group of fields makes a repeater with its own fields', async () => {
  const form = await mount();
  await form.openForm('List');
  const section = () => form.container.querySelector('.list-items') ?? undefined;
  assert.notEqual(section(), undefined, 'the form has a List items section');
  assert.match(section().textContent, /List items/);
  assert.match(section().textContent, /Plain text/, 'items default to plain text');
  assert.equal(section().querySelector('.list-items-row') ?? undefined, undefined, 'plain text items have no fields of their own');
  await form.typeName('Tags');
  await form.click(form.button('Add field'));
  await form.click(form.button('Save collection'));
  assert.match(form.project.config, /Tags: z\.array\(z\.string\(\)\)\.optional\(\),/, 'the list is written as a list of text');
  await form.close();
});

test('every field-type tile is an icon and a name; List and Group explain themselves in a delayed tooltip', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const form = await mount();
  await form.click(form.button('Add field'));
  const tiles = [...form.container.querySelectorAll('.remote-cms-settings-kind-tile')];
  assert.ok(tiles.length > 10, 'the grid shows every kind');
  for (const tile of tiles) {
    assert.equal(tile.children.length, 2, `${tile.textContent}: an icon and one label, no description`);
    assert.ok(tile.children[0].matches('svg'), 'the icon comes first');
    assert.equal(tile.hasAttribute('title'), false, 'no native title attribute');
  }
  assert.equal(form.container.querySelector('.remote-cms-settings-kind-hint') === null, true, 'no description text on any tile');
  const tip = () => document.querySelector('[role="tooltip"]') ?? undefined;
  const gone = (message) => assert.equal(tip() === undefined, true, message);
  // React hears a pointer entering and leaving as mouseover and mouseout, and focus as focusin and focusout.
  const event = (name, target, type = window.MouseEvent) => act(async () => target.dispatchEvent(new type(name, { bubbles: true })));
  // The tooltip delay runs on the mocked clock, so moving it forward is deterministic: no real time passes.
  const advanceClock = (ms) => act(async () => context.mock.timers.tick(ms));
  const list = form.button('List');
  await event('mouseover', list);
  await advanceClock(499);
  gone('nothing before the delay');
  await advanceClock(2);
  assert.equal(tip()?.textContent, 'A list of items: plain values, or groups of fields like team members');
  await event('mouseout', list);
  gone('leaving dismisses it');
  const group = form.button('Group');
  await event('mouseover', group);
  await advanceClock(600);
  assert.equal(tip()?.textContent, 'Fields kept together as one object');
  await act(async () => group.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  gone('Escape dismisses it');
  await act(async () => list.dispatchEvent(new window.FocusEvent('focusin', { bubbles: true })));
  gone('focus waits for the same delay');
  await advanceClock(600);
  assert.equal(tip() === undefined, false, 'focus shows it after the delay');
  await act(async () => list.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true })));
  gone('blur dismisses it');
  await event('mouseover', list);
  await advanceClock(600);
  await form.click(list);
  gone('clicking dismisses it');
  await event('mouseover', form.button('Plain text'));
  await advanceClock(1000);
  gone('a tile with nothing to add has no tooltip');
  await form.close();
});

// A dropdown's highlighted row has nothing to scroll in a window that draws no layout.
dom.window.HTMLElement.prototype.scrollIntoView = function () {};

const typeInto = (element, value) =>
  act(async () => {
    const prototype = element instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
    element.dispatchEvent(new window.Event('input', { bubbles: true }));
  });

test('a new group lists its fields, each with its type icon, and a field opens to the form a collection field has', async () => {
  const form = await mount();
  await form.openForm('Group');
  const fields = () => form.container.querySelector('.list-items-fields');
  assert.ok(fields(), 'a group field has a Fields section');
  assert.equal(fields().querySelectorAll('.list-items-row').length, 1, 'it starts with a title field');
  assert.ok(fields().querySelector('.list-items-row .remote-cms-settings-icon svg'), 'the row shows the type icon');
  await form.click(fields().querySelector('.remote-cms-settings-add'));
  const rows = () => [...fields().querySelectorAll('.list-items-row')];
  assert.equal(rows().length, 2);
  await typeInto(rows()[1].querySelector('input[type="text"], input:not([type])'), 'Street');
  // The new field's type is chosen from a dropdown whose rows carry icons.
  const trigger = rows()[1].querySelector('.dd-trigger');
  assert.ok(trigger, 'a new field has a type dropdown');
  await form.click(trigger);
  const listed = [...document.querySelectorAll('.dd-option')];
  assert.ok(listed.length >= MEMBER_KIND_COUNT, 'the dropdown lists the group-capable kinds');
  assert.ok(
    listed.every((option) => option.querySelector('.dd-icon svg')),
    'every option has its icon first',
  );
  assert.ok(
    listed.some((option) => option.textContent.includes('Number')),
    'Number is offered',
  );
  await form.click(listed.find((option) => option.textContent.includes('Number')));
  assert.ok(rows()[1].querySelector('.remote-cms-settings-icon svg'), 'the row shows the number icon');
  // Opening the field shows the same form a collection's field has.
  await form.click(rows()[1].querySelector('[aria-label="Field settings"]'));
  const opened = fields().querySelector('.list-items-member-settings');
  assert.ok(opened, 'the field opens');
  assert.ok(opened.querySelector('textarea'), 'it has help text');
  await typeInto(opened.querySelector('textarea'), 'Number of the street');
  await typeInto(form.container.querySelector('.field-settings input'), 'address');
  await form.click(
    [...form.container.querySelectorAll('button')].find((each) => each.textContent.trim() === 'Add field' && !each.matches('.remote-cms-settings-add')),
  );
  await form.click(form.button('Save collection'));
  assert.match(
    form.project.config,
    /address: z\.object\(\{ title: z\.string\(\)\.optional\(\), Street: z\.number\(\)\.describe\("Number of the street"\)\.optional\(\) \}\)\.optional\(\)/,
  );
  await form.close();
});

test('a new list of groups gives each item several fields, and the item dropdown shows icons', async () => {
  const form = await mount();
  await form.openForm('List');
  const items = () => form.container.querySelector('.list-items');
  await form.click(items().querySelector('.dd-trigger'));
  const listed = [...document.querySelectorAll('.dd-option')];
  assert.ok(listed.length >= 7, 'every item kind is listed');
  assert.ok(
    listed.every((option) => option.querySelector('.dd-icon svg')),
    'every item kind has its icon first',
  );
  await form.click(listed.find((option) => option.textContent.includes('Group of fields')));
  assert.ok(items().querySelector('.list-items-fields'), 'a list of groups has its item fields');
  await form.click(items().querySelector('.remote-cms-settings-add'));
  await form.click(items().querySelector('.remote-cms-settings-add'));
  const rows = [...items().querySelectorAll('.list-items-row')];
  assert.equal(rows.length, 3, 'a title and two more');
  await typeInto(rows[1].querySelector('input'), 'name');
  await typeInto(rows[2].querySelector('input'), 'role');
  await typeInto(form.container.querySelector('.field-settings input'), 'team');
  await form.click(
    [...form.container.querySelectorAll('button')].find((each) => each.textContent.trim() === 'Add field' && !each.matches('.remote-cms-settings-add')),
  );
  await form.click(form.button('Save collection'));
  assert.match(
    form.project.config,
    /team: z\.array\(z\.object\(\{ title: z\.string\(\)\.optional\(\), name: z\.string\(\)\.optional\(\), role: z\.string\(\)\.optional\(\) \}\)\)\.optional\(\)/,
  );
  await form.close();
});

// The kinds a group's field may be, as MEMBER_KINDS lists them, less the repeater (a list of groups is made from a list).
const MEMBER_KIND_COUNT = 18;
