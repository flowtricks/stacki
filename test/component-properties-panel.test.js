// Goal: the Properties panel and shortcut exist only inside components and save
// through the validated bridge. Method: mount real controls with deterministic
// IPC replies and drive keyboard, reorder, add, validation and failure states.
// External events exercise fresh snapshots, races, save deferral, and cleanup.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const {
  readComponentProperties,
  editPropertyDefinition,
} = require('../dist/electron/propertyDefinitions');

test('component properties lifecycle and controls', async () => {
  const directory = path.join(__dirname, '../node_modules/.stacki-test/properties');
  fs.mkdirSync(directory, { recursive: true });
  const bundle = path.join(directory, 'panel.js');
  await esbuild.build({
    stdin: {
      contents: `export {default as Panel} from './panels/ComponentPropertiesPanel';
     export {default as Rail} from './ui/LeftRail';
     export {literalOptions} from './panels/PropertyEditor';
     export {movePropertyItem} from './panels/PropertyReorder';`,
      resolveDir: path.join(__dirname, '../src'),
      loader: 'tsx',
    },
    outfile: bundle,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
    loader: { '.css': 'empty' },
    logLevel: 'silent',
  });
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    pretendToBeVisual: true,
  });
  for (const key of [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'Element',
    'Node',
    'MutationObserver',
    'Window',
    'DOMRect',
  ]) {
    global[key] = key === 'window' ? dom.window : dom.window[key];
  }
  global.IS_REACT_ACT_ENVIRONMENT = true;
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.Range.prototype.getBoundingClientRect = () => new window.DOMRect();
  window.Range.prototype.getClientRects = () => [];
  const React = require('react');
  const { act } = React;
  const { createRoot } = require('react-dom/client');
  const { Panel, Rail, literalOptions, movePropertyItem } = require(bundle);
  const names = ['title', 'variant', 'visible'];
  assert.deepEqual(movePropertyItem(names, 0, 3), ['variant', 'visible', 'title']);
  assert.deepEqual(movePropertyItem(names, 2, 0), ['visible', 'title', 'variant']);
  assert.equal(movePropertyItem(names, 1, 2), names);
  assert.throws(() => movePropertyItem(names, -1, 0), /source index must be nonnegative/);
  assert.throws(() => movePropertyItem(names, 3, 0), /source index is out of bounds/);
  assert.throws(() => movePropertyItem(names, 0, 4), /drop gap is out of bounds/);
  assert.throws(() => movePropertyItem(names, 0, 0.5), /drop gap must be an integer/);
  const root = createRoot(document.getElementById('root'));
  const clicked = [];
  const renderRail = (componentOpen) =>
    act(async () => {
      root.render(
        React.createElement(Rail, {
          componentOpen,
          active: 'navigator',
          onSelect: (value) => clicked.push(value),
        })
      );
    });
  const key = async (name, options = {}, target = window) =>
    act(async () => {
      target.dispatchEvent(
        new window.KeyboardEvent('keydown', {
          key: name,
          bubbles: true,
          cancelable: true,
          ...options,
        })
      );
    });
  await renderRail(false);
  assert.equal(document.querySelector('[aria-label="Properties (K)"]'), null);
  await key('k');
  assert.deepEqual(clicked, []);
  await renderRail(true);
  assert(document.querySelector('[aria-label="Properties (K)"]'));
  await key('k');
  assert.deepEqual(clicked, ['properties']);
  for (const options of [
    { ctrlKey: true },
    { metaKey: true },
    { altKey: true },
    { shiftKey: true },
  ]) {
    await key('k', options);
  }
  const input = document.createElement('input');
  document.body.append(input);
  await key('k', {}, input);
  input.remove();
  assert.equal(clicked.length, 1);
  await renderRail(false);
  await key('k');
  assert.equal(clicked.length, 1);

  const property = {
    name: 'title',
    type: 'string',
    required: true,
    readonly: false,
    defaultValue: '"Hello"',
    description: 'Heading text',
  };
  let data = {
    source: 'source',
    frontmatter: 'interface Props {title: string}',
    advanced: false,
    properties: [property, { ...property, name: 'variant', type: '"Solid" | "Outline"' }],
  };
  const edits = [];
  const order = [];
  let notifyFiles;
  let subscriptions = 0;
  let reads = 0;
  let readProperties = async () => ({ ok: true, value: data });
  let finishSave = async () => {};
  let failure = { code: 'write', message: 'Write failed. Try again.' };
  let applyDefinition;
  window.avb = {
    onFsChanged: (callback) => {
      notifyFiles = callback;
      subscriptions++;
      return () => {
        subscriptions--;
      };
    },
    componentProperties: () => {
      reads++;
      return readProperties();
    },
    editComponentProperties: async (request) => {
      edits.push(request);
      order.push('write');
      if (request.change.kind === 'options') {
        data = {
          ...data,
          source: `${data.source}\noptions:${request.change.type}`,
          properties: data.properties.map((field) =>
            field.name === request.change.name ? { ...field, type: request.change.type } : field
          ),
        };
        return { ok: true, value: data };
      }
      if (applyDefinition) {
        data = applyDefinition(data.source, request.change);
        return { ok: true, value: data };
      }
      if (request.change.kind === 'order') {
        data = {
          ...data,
          properties: request.change.names.map((name) =>
            data.properties.find((field) => field.name === name)
          ),
        };
        return { ok: true, value: data };
      }
      return { ok: false, error: failure };
    },
  };
  await act(async () =>
    root.render(
      React.createElement(Panel, {
        projectPath: '/site',
        file: '/site/src/components/Card.astro',
        name: 'Card',
        flushSave: async () => {
          order.push('flush');
        },
        onSavePhase: (phase) => {
          order.push(phase);
        },
        onSaved: async () => {
          order.push('refresh');
          await finishSave();
        },
      })
    )
  );
  assert.match(document.body.textContent, /Properties/);
  assert.match(document.body.textContent, /Card/);
  assert.equal(subscriptions, 1);
  assert.doesNotMatch(document.body.textContent, /Edit TypeScript source|Reload/);
  const notify = async (files = ['/site/src/components/Card.astro']) =>
    act(async () => {
      notifyFiles({ files });
    });
  const drag = async (selector, rowSelector, from, gap) => {
    const rows = [...document.querySelectorAll(rowSelector)];
    rows.forEach((row, index) => {
      row.getBoundingClientRect = () => ({ top: index * 40, height: 40 });
    });
    const pointer = async (target, type, clientY) =>
      act(async () => {
        target.dispatchEvent(
          new window.MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            button: 0,
            clientY,
          })
        );
      });
    await pointer(document.querySelector(selector), 'pointerdown', from * 40 + 20);
    await pointer(window, 'pointermove', gap * 40);
    await pointer(window, 'pointerup', gap * 40);
  };
  const optionValues = () =>
    [...document.querySelectorAll('.property-options .list-field-text')].map((row) =>
      row.textContent.trim()
    );
  const dragOptions = async (from, gap) => {
    const rows = [...document.querySelectorAll('.property-options .list-field-row')];
    rows.forEach((row, index) => {
      row.getBoundingClientRect = () => ({
        top: index * 40,
        bottom: (index + 1) * 40,
        height: 40,
        width: 240,
        left: 0,
      });
    });
    const target = rows[Math.min(gap, rows.length - 1)];
    const fire = async (element, type, clientY) =>
      act(async () => {
        const event = new window.MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          clientY,
        });
        Object.defineProperty(event, 'dataTransfer', {
          value: { setData: () => {} },
        });
        element.dispatchEvent(event);
      });
    await fire(rows[from], 'dragstart', from * 40);
    await fire(target, 'dragover', gap * 40);
    await fire(target, 'drop', gap * 40);
  };
  await drag('[aria-label="Reorder title"]', '.property-row', 0, 2);
  assert.deepEqual(edits[0].change, {
    kind: 'order',
    names: ['variant', 'title'],
  });
  assert.deepEqual(order.slice(-5), ['saving', 'flush', 'write', 'refresh', 'idle']);
  await act(async () => document.querySelector('[aria-label="Add property"]').click());
  assert.match(document.body.textContent, /New property/);
  const save = [...document.querySelectorAll('button')].find(
    (button) => button.textContent === 'Save property'
  );
  await act(async () => save.click());
  assert.match(document.body.textContent, /Use a name/);
  assert.equal(edits.length, 1);
  await act(async () => document.querySelector('[aria-label="Close property settings"]').click());
  await act(async () =>
    [...document.querySelectorAll('.property-row-main')]
      .find((button) => button.textContent.includes('title'))
      .click()
  );
  assert.equal(document.querySelector('[aria-label="Default text"]').value, 'Hello');
  await act(async () =>
    [...document.querySelectorAll('button')]
      .find((button) => button.textContent === 'Save property')
      .click()
  );
  assert.match(document.body.textContent, /Write failed/);
  assert.match(document.body.textContent, /Property settings/);
  assert.deepEqual(literalOptions('"One | two" | "Three"'), ['"One | two"', '"Three"']);
  assert.equal(literalOptions('string | { tag: "a" | "b" }'), undefined);
  await act(async () => document.querySelector('[aria-label="Close property settings"]').click());
  await act(async () => document.querySelector('[aria-label="Delete title"]').click());
  assert.deepEqual(edits.at(-1).change, { kind: 'remove', name: 'title' });
  await act(async () => document.querySelector('.property-row-main').click());
  await dragOptions(0, 2);
  assert.equal(optionValues()[0], 'Outline');
  assert.equal(optionValues()[1], 'Solid');
  assert.deepEqual(edits.at(-1).change, {
    kind: 'options',
    name: 'variant',
    type: '"Outline" | "Solid"',
  });
  await dragOptions(1, 0);
  assert.equal(optionValues()[0], 'Solid');
  assert.deepEqual(edits.at(-1).change, {
    kind: 'options',
    name: 'variant',
    type: '"Solid" | "Outline"',
  });
  await act(async () => document.querySelector('.property-options .list-field-remove').click());
  assert.equal(optionValues()[0], 'Outline');
  assert.equal(document.querySelector('.property-options .list-field-remove').disabled, true);
  await act(async () =>
    [...document.querySelectorAll('button')]
      .find((button) => button.textContent === 'Save property')
      .click()
  );
  assert.equal(edits.at(-1).change.property.type, '"Outline"');
  const previousReads = reads;
  const flushCount = order.filter((item) => item === 'flush').length;
  await notify(['/site/src/components/Other.astro']);
  assert.equal(reads, previousReads);
  // An unchanged snapshot preserves the current options draft.
  await notify();
  assert.equal(optionValues()[0], 'Outline');
  data = {
    ...data,
    source: 'external 1',
    properties: [
      { ...property, name: 'heading', defaultValue: '"Updated"' },
      { ...property, name: 'enabled', type: 'boolean' },
    ],
  };
  await notify();
  assert.match(document.querySelector('.property-list').textContent, /heading/);
  assert.equal(document.querySelector('.property-editor'), null);
  assert.equal(order.filter((item) => item === 'flush').length, flushCount);
  // The newer response wins even when an older request finishes last.
  const responses = [];
  readProperties = () => new Promise((resolve) => responses.push(resolve));
  await notify();
  await notify();
  const latest = {
    ...data,
    source: 'external 2',
    properties: [
      { ...property, name: 'latest' },
      { ...property, name: 'second' },
    ],
  };
  await act(async () => responses[1]({ ok: true, value: latest }));
  await act(async () => responses[0]({ ok: true, value: data }));
  assert.match(document.querySelector('.property-list').textContent, /latest/);
  assert.doesNotMatch(document.querySelector('.property-list').textContent, /heading/);
  data = latest;
  readProperties = async () => ({ ok: true, value: data });
  // A self save uses its returned data without another disk read. External
  // notifications received during that save are coalesced and read afterward.
  let completeSave;
  finishSave = () =>
    new Promise((resolve) => {
      completeSave = resolve;
    });
  const readsBeforeSave = reads;
  await drag('[aria-label="Reorder latest"]', '.property-row', 0, 2);
  assert.equal(reads, readsBeforeSave);
  data = {
    ...data,
    source: 'external during save',
    properties: [{ ...property, name: 'afterSave' }],
  };
  await notify();
  await notify();
  assert.equal(reads, readsBeforeSave);
  await act(async () => completeSave());
  assert.equal(reads, readsBeforeSave + 1);
  assert.match(document.querySelector('.property-list').textContent, /afterSave/);
  // A deletion/read failure recovers when a later external edit restores it.
  readProperties = async () => ({
    ok: false,
    error: { code: 'missing', message: 'File missing' },
  });
  await notify();
  assert.match(document.body.textContent, /File missing/);
  readProperties = async () => ({ ok: true, value: data });
  await notify();
  assert.match(document.querySelector('.property-list').textContent, /afterSave/);
  // A conflict can arrive before its watcher event. Reconcile it automatically
  // so removing Reload cannot leave the panel stuck on an obsolete revision.
  await act(async () => document.querySelector('.property-row-main').click());
  data = {
    ...data,
    source: 'conflict revision',
    properties: [{ ...property, name: 'reconciled' }],
  };
  failure = { code: 'conflict', message: 'Changed on disk' };
  await act(async () =>
    [...document.querySelectorAll('button')]
      .find((button) => button.textContent === 'Save property')
      .click()
  );
  assert.match(document.querySelector('.property-list').textContent, /reconciled/);
  assert.equal(document.querySelector('.property-editor'), null);

  // Exercise the actual inherited-contract reader and writer through the controls.
  const {
    readComponentProperties,
    editPropertyDefinition,
  } = require('../dist/electron/propertyDefinitions');
  const inherited = `---
import type { HTMLAttributes } from 'astro/types';
type ContainerGap = 'small' | 'medium' | 'large';
interface Props extends HTMLAttributes<'section'> {
  /** Space between items. */
  gap?: ContainerGap;
  other?: ContainerGap;
}
const { gap = 'small', other = 'large', ...rest } = Astro.props;
---
<section {...rest}>{gap} {other}</section>`;
  data = readComponentProperties(inherited);
  finishSave = async () => {};
  applyDefinition = (source, change) => {
    const result = editPropertyDefinition(source, change);
    assert.equal(result.ok, true, JSON.stringify(result));
    return readComponentProperties(result.value);
  };
  await notify();
  await act(async () => document.querySelector('.property-row-main').click());
  assert.equal(document.querySelector('[aria-label="Component TypeScript source"]'), null);
  assert.equal(optionValues()[0], 'small');
  const setValue = async (element, value) =>
    act(async () => {
      const prototype =
        element.tagName === 'TEXTAREA'
          ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
      element.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  const pressDown = async (element) =>
    act(async () => element.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true })));
  assert.equal(document.querySelector('.property-options input'), null);
  await act(async () => document.querySelector('.property-options .list-field-text').click());
  const firstOption = document.querySelector('.list-item-field input');
  assert.equal(document.activeElement, firstOption);
  assert.equal(firstOption.selectionStart, 0);
  assert.equal(firstOption.selectionEnd, 'small'.length);
  await pressDown(firstOption);
  assert.ok(document.querySelector('.property-editor'));
  await setValue(firstOption, 'compact');
  await act(async () => document.querySelector('.list-item-editor [title="Close"]').click());
  const defaultLabel = () => document.querySelector('.property-default .dd-label').textContent;
  assert.equal(document.querySelector('.property-default select'), null);
  assert.equal(defaultLabel(), 'compact');
  await act(async () => document.querySelector('.property-default .dd-trigger').click());
  await setValue(document.querySelector('.dd-search'), 'medium');
  assert.equal(document.querySelectorAll('.dd-option').length, 1);
  await pressDown(document.querySelector('.dd-option'));
  assert.ok(document.querySelector('.property-editor'));
  await act(async () =>
    document
      .querySelector('.dd-option')
      .dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }))
  );
  assert.equal(defaultLabel(), 'compact');
  await act(async () => document.querySelector('.dd-option').click());
  assert.equal(defaultLabel(), 'medium');
  await act(async () => document.querySelector('.property-default .dd-trigger').click());
  await setValue(document.querySelector('.dd-search'), 'compact');
  await act(async () => document.querySelector('.dd-option').click());
  assert.equal(defaultLabel(), 'compact');
  await dragOptions(2, 0);
  assert.equal(optionValues()[0], 'large');
  await setValue(document.querySelector('.property-editor label input'), 'spacing');
  const tooltip = [...document.querySelectorAll('.property-editor label')]
    .find((label) => label.textContent.trim().startsWith('Tooltip'))
    .querySelector('textarea');
  await setValue(tooltip, 'Choose space between items.');
  await act(async () => document.querySelector('.property-flags input').click());
  await act(async () =>
    [...document.querySelectorAll('button')]
      .find((button) => button.textContent === 'Save property')
      .click()
  );
  const editedGap = data.properties.find((field) => field.name === 'spacing');
  assert.equal(editedGap.required, true);
  assert.equal(editedGap.description, 'Choose space between items.');
  assert.equal(editedGap.type, `'large' | "compact" | 'medium'`);
  assert.equal(editedGap.defaultValue, '"compact"');
  assert.deepEqual(edits.at(-1).change.optionRenames, [{ from: "'small'", to: '"compact"' }]);
  assert.match(data.source, /other\?: ContainerGap/);
  assert.match(data.source, /Props extends HTMLAttributes<'section'>/);
  assert.match(data.source, /type ContainerGap = 'small' \| 'medium' \| 'large'/);
  // Type controls reuse the searchable dropdown and preserve expressions across
  // mode toggles. Browsing choices does not replace the current union.
  await act(async () => document.querySelector('.property-row-main').click());
  assert.match(document.querySelector('.property-type .dd-trigger').textContent, /Options/);
  const toggleType = async (label) =>
    act(async () => document.querySelector(`[aria-label="${label}"]`).click());
  await toggleType('Write a type expression');
  assert.equal(document.querySelector('input[aria-label="Type expression"]').value, editedGap.type);
  await toggleType('Use the type dropdown');
  assert.equal(optionValues()[0], 'large');
  await act(async () => document.querySelector('.property-type .dd-trigger').click());
  assert(document.querySelector('.dd-search'));
  await setValue(document.querySelector('.dd-search'), 'boolean');
  assert.equal(document.querySelectorAll('.dd-option').length, 1);
  await act(async () =>
    document
      .querySelector('.dd-option')
      .dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }))
  );
  assert.equal(optionValues()[0], 'large');
  await key('Escape', {}, document.querySelector('.dd-search'));
  assert.equal(optionValues()[0], 'large');
  await act(async () => document.querySelector('.property-type .dd-trigger').click());
  await setValue(document.querySelector('.dd-search'), 'boolean');
  await act(async () => document.querySelector('.dd-option').click());
  assert.equal(document.querySelector('.property-options .list-field'), null);
  await toggleType('Write a type expression');
  assert.equal(document.querySelector('input[aria-label="Type expression"]').value, 'boolean');
  await setValue(
    document.querySelector('input[aria-label="Type expression"]'),
    'typeof designTheme'
  );
  await toggleType('Use the type dropdown');
  assert.match(
    document.querySelector('.property-type .dd-trigger').textContent,
    /typeof designTheme/
  );
  await toggleType('Write a type expression');
  assert.equal(
    document.querySelector('input[aria-label="Type expression"]').value,
    'typeof designTheme'
  );
  // Existing unsupported types open directly as ordinary inputs.
  data = {
    ...data,
    source: 'custom type',
    properties: [{ ...property, name: 'theme', type: 'typeof designTheme' }],
  };
  await notify();
  await act(async () => document.querySelector('.property-row-main').click());
  assert.equal(
    document.querySelector('input[aria-label="Type expression"]').value,
    'typeof designTheme'
  );
  // A default that names another frontmatter value is shown as a binding. Its
  // chip opens the same scoped picker used by prop values and can be repointed.
  const boundDefault = `---
const fallback = 'h3';
interface Props {
  tag?: string;
  variant?: string;
}
const { tag = 'h2', variant = tag } = Astro.props;
---
<h1>{variant}</h1>`;
  data = readComponentProperties(boundDefault);
  await notify();
  await act(async () =>
    [...document.querySelectorAll('.property-row-main')]
      .find((button) => button.textContent.includes('variant'))
      .click()
  );
  const defaultChip = document.querySelector('.property-default .cm-chip');
  assert.equal(defaultChip.textContent, 'tag');
  assert.equal(document.querySelector('.property-default textarea'), null);
  await pressDown(defaultChip);
  assert.equal(document.querySelector('.bind-menu .dp-row.selected .dp-key').textContent, 'tag');
  await act(async () =>
    [...document.querySelectorAll('.bind-menu .dp-row')]
      .find((row) => row.title.startsWith('fallback'))
      .click()
  );
  assert.equal(document.querySelector('.property-default .cm-content').textContent, 'fallback');
  await act(async () =>
    [...document.querySelectorAll('button')]
      .find((button) => button.textContent === 'Save property')
      .click()
  );
  assert.equal(data.properties.find((field) => field.name === 'variant').defaultValue, 'fallback');
  assert.match(data.source, /variant = fallback/);
  // The shared editor handles add/edit/remove and drag while the adapter keeps
  // boolean/number literals distinct from strings with the same visible label.
  data = {
    ...data,
    source: 'mixed options',
    properties: [
      {
        ...property,
        name: 'choice',
        type: 'true | false | "true" | 1 | "1"',
        defaultValue: 'true',
      },
    ],
  };
  await notify();
  await act(async () => document.querySelector('.property-row-main').click());
  await dragOptions(4, 0);
  await toggleType('Write a type expression');
  assert.equal(
    document.querySelector('input[aria-label="Type expression"]').value,
    '"1" | true | false | "true" | 1'
  );
  await toggleType('Use the type dropdown');
  await act(async () => document.querySelectorAll('.property-options .list-field-text')[4].click());
  await setValue(document.querySelector('.list-item-field input'), '-');
  await setValue(document.querySelector('.list-item-field input'), '-2');
  await act(async () => document.querySelector('.list-item-editor [title="Close"]').click());
  await toggleType('Write a type expression');
  assert.equal(
    document.querySelector('input[aria-label="Type expression"]').value,
    '"1" | true | false | "true" | -2'
  );
  await toggleType('Use the type dropdown');
  await act(async () => document.querySelector('.property-options .list-field-add').click());
  assert.equal(document.querySelector('.list-item-field input').value, '');
  assert.equal(optionValues().length, 5);
  const added = 'A "quoted" | option';
  await setValue(document.querySelector('.list-item-field input'), added);
  await key('Enter', {}, document.querySelector('.list-item-field input'));
  assert.equal(optionValues().at(-1), added);
  assert.equal(document.querySelector('.list-item-editor'), null);
  await act(async () =>
    [...document.querySelectorAll('.property-options .list-field-remove')].at(-1).click()
  );
  assert.equal(optionValues().length, 5);
  await act(async () => document.querySelectorAll('.property-options .list-field-text')[1].click());
  await setValue(document.querySelector('.list-item-field input'), 'false');
  await key('Escape', {}, document.querySelector('.list-item-field input'));
  assert.equal(defaultLabel(), 'false');
  assert.equal(document.querySelector('.list-item-editor'), null);
  // Settings use the shared dismissal behavior for app chrome and canvas clicks.
  // Nested option popovers and dropdowns above remain inside the settings editor.
  const editsBeforeDismiss = edits.length;
  await pressDown(document.querySelector('.property-component'));
  assert.equal(document.querySelector('.property-editor') === null, true);
  assert.equal(edits.length, editsBeforeDismiss);
  await act(async () => document.querySelector('.property-row-main').click());
  await act(async () =>
    window.dispatchEvent(
      new window.MessageEvent('message', {
        data: { type: 'avb:click-node', path: '0' },
      })
    )
  );
  assert.equal(document.querySelector('.property-editor') === null, true);
  assert.equal(edits.length, editsBeforeDismiss);
  // Unsupported contracts still open property settings rather than raw source.
  data = {
    ...data,
    source: 'unsupported contract',
    advanced: true,
    properties: data.properties.map((field) => ({
      ...field,
      origin: {
        declarations: [{ label: `Tag.${field.name}`, expression: field.type, line: 3 }],
        defaultValue: {
          label: `Astro.props.${field.name}`,
          expression: field.defaultValue,
          line: 6,
        },
      },
    })),
  };
  await notify();
  await act(async () => document.querySelector('.property-row-main').click());
  assert.match(document.body.textContent, /Property settings/);
  assert.equal(document.querySelector('[aria-label="Component TypeScript source"]'), null);
  assert.equal(document.querySelector('.property-readonly-fields textarea').readOnly, true);
  assert.equal(document.querySelector('.property-source-tag'), null);
  assert.match(document.querySelector('.property-declaration-info').title, /Tag\./);
  assert.match(document.querySelector('.property-declaration-info').title, /line 3/);
  assert.equal(document.querySelector('[aria-label="Close property settings"]').disabled, false);
  await pressDown(document.querySelector('.property-declaration-info'));
  assert.ok(document.querySelector('.property-editor'));
  await act(async () => document.querySelector('[aria-label="Close property settings"]').click());
  assert.equal(document.querySelector('.property-editor'), null);
  await act(async () => document.querySelector('.property-row-main').click());
  await pressDown(document.querySelector('.property-component'));
  assert.equal(document.querySelector('.property-editor'), null);
  assert.equal(edits.length, editsBeforeDismiss);
  // Common fields in a combined contract use normal editing; only affected props are restricted.
  data = {
    ...data,
    source: 'combined contract',
    properties: [
      {
        ...property,
        name: 'eyebrow',
        editing: { kind: 'editable' },
        conditions: [],
      },
      {
        ...property,
        name: 'image',
        editing: {
          kind: 'restricted',
          reason: 'This prop has variant rules. Edit its declaration in source.',
        },
        conditions: ['variant = "default": not allowed', 'variant = "cover": optional'],
      },
    ],
  };
  await notify();
  assert.equal(document.querySelector('[aria-label="Delete eyebrow"]').disabled, false);
  assert.equal(document.querySelector('[aria-label="Delete image"]').disabled, true);
  await act(async () => document.querySelector('.property-row-main').click());
  assert.equal(document.querySelector('.property-editor fieldset').disabled, false);
  assert.equal(document.querySelector('.property-readonly-fields'), null);
  assert.equal(document.querySelector('.property-editor label input').value, 'eyebrow');
  assert.doesNotMatch(document.body.textContent, /This view is read-only/);
  await act(async () => document.querySelector('[aria-label="Close property settings"]').click());
  await act(async () => document.querySelectorAll('.property-row-main')[1].click());
  assert.match(document.querySelector('.property-conditions').textContent, /default.*not allowed/);
  assert.match(document.querySelector('.property-readonly-fields').textContent, /variant rules/);
  assert.equal(document.querySelector('.property-editor fieldset'), null);
  // Inherited Astro attributes can be overridden locally without exposing a
  // rename or delete that would leave the inherited contract in place.
  data = {
    ...data,
    source: 'inherited attribute',
    properties: [
      {
        ...property,
        name: 'class',
        type: 'unknown',
        editing: {
          kind: 'override',
          reason: 'This HTML attribute will be declared locally when you save it.',
        },
      },
    ],
  };
  await notify();
  assert.equal(document.querySelector('[aria-label="Delete class"]').disabled, true);
  await act(async () => document.querySelector('.property-row-main').click());
  assert.equal(document.querySelector('.property-editor fieldset').disabled, false);
  assert.equal(document.querySelector('.property-readonly-fields'), null);
  assert.equal(document.querySelector('.property-editor label input').disabled, true);
  assert.equal(
    document.querySelector('textarea[placeholder="Describe how to use this property…"]').readOnly,
    false
  );
  assert.match(document.querySelector('.property-editor').textContent, /declared locally/);
  assert.equal(document.querySelector('.property-actions .danger'), null);
  await act(async () => document.querySelector('[aria-label="Close property settings"]').click());
  let completeRead;
  readProperties = () =>
    new Promise((resolve) => {
      completeRead = resolve;
    });
  await notify();
  await act(async () => root.unmount());
  assert.equal(subscriptions, 0);
  await act(async () => completeRead({ ok: true, value: data }));
  dom.window.close();
});
