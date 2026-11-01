import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { propertyFixture, component, consumer, source, instance } from './propertyFixture';
import { record, string } from '../src/shared/validation';
import { scanProject } from '../src/features/project/projectServer';
import { editPropertyDefinition, readComponentProperties } from '../vendor/stacki/electron/properties/propertyDefinitions';

const added = {
  name: 'count',
  type: 'number',
  required: false,
  readonly: true,
  defaultValue: '2',
  description: 'Item count',
};
test('Stacki property definitions add, edit, reorder and remove while preserving template and styles', () => {
  const result = editPropertyDefinition(source, {
    kind: 'save',
    originalName: '',
    property: added,
  });
  assert.ok(result.ok);
  assert.ok(result.value.endsWith(source.slice(source.lastIndexOf('---') + 3)));
  const model = readComponentProperties(result.value);
  assert.equal(model.properties.find((property) => property.name === 'count')?.defaultValue, '2');
  const order = editPropertyDefinition(result.value, {
    kind: 'order',
    names: ['count', 'tone', 'title'],
  });
  assert.ok(order.ok);
  assert.deepEqual(
    readComponentProperties(order.value).properties.map((property) => property.name),
    ['count', 'tone', 'title'],
  );
  const remove = editPropertyDefinition(order.value, { kind: 'remove', name: 'count' });
  assert.ok(remove.ok);
  assert.ok(!readComponentProperties(remove.value).properties.some((property) => property.name === 'count'));
});

test('property API renames definition and aliased instances, persists drafts and supports undo/redo', async () => {
  const fixture = await propertyFixture();
  try {
    const data = await fixture.get();
    const title = data.properties.find((property) => property.name === 'title');
    assert.ok(title);
    const saved = await fixture.post({
      file: component,
      source: data.source,
      change: { kind: 'save', originalName: 'title', property: { ...title, name: 'heading' } },
    });
    assert.equal(saved['ok'], true, JSON.stringify(saved));
    const changed = await fixture.rooms.read(component);
    assert.match(changed, /heading: title = 'Hello'/);
    assert.match(changed, /\{title\}/);
    assert.equal(await fixture.rooms.read(consumer), instance.replace('title=', 'heading='));
    assert.equal(await readFile(path.join(fixture.root, component), 'utf8'), changed);
    const undo = await fixture.post({ undo: string(record(saved['value'])['undo']) });
    assert.equal(undo['ok'], true);
    assert.equal(await fixture.rooms.read(component), source);
    assert.equal(await fixture.rooms.read(consumer), instance);
    const redo = await fixture.post({ undo: string(record(undo['value'])['undo']) });
    assert.equal(redo['ok'], true);
    assert.equal(await fixture.rooms.read(component), changed);
  } finally {
    await fixture.close();
  }
});

test('property API renames option values and rejects deletion of an in-use prop', async () => {
  const fixture = await propertyFixture();
  try {
    const data = await fixture.get();
    const tone = data.properties.find((property) => property.name === 'tone');
    assert.ok(tone);
    const saved = await fixture.post({
      file: component,
      source,
      change: {
        kind: 'save',
        originalName: 'tone',
        property: { ...tone, type: "'bright' | 'dark'", defaultValue: "'bright'" },
        optionRenames: [{ from: "'light'", to: "'bright'" }],
      },
    });
    assert.equal(saved['ok'], true, JSON.stringify(saved));
    assert.match(await fixture.rooms.read(consumer), /tone="bright"/);
    const current = await fixture.rooms.read(component);
    const removed = await fixture.post({
      file: component,
      source: current,
      change: { kind: 'remove', name: 'title' },
    });
    assert.equal(removed['ok'], false);
    assert.equal(await fixture.rooms.read(component), current);
  } finally {
    await fixture.close();
  }
});

test('stale saves and undo preserve collaborator edits; paths cannot escape the project', async () => {
  const fixture = await propertyFixture();
  try {
    const saved = await fixture.post({
      file: component,
      source,
      change: { kind: 'save', originalName: '', property: added },
    });
    assert.equal(saved['ok'], true);
    const current = await fixture.rooms.read(component);
    const remote = current + '<!-- collaborator -->';
    await fixture.rooms.coordinator.run(async () => (await fixture.rooms.get(component)).setSource(remote));
    const refused = await fixture.post({ undo: record(saved['value'])['undo'] });
    assert.ok(refused['error']);
    const stale = await fixture.post({
      file: component,
      source,
      change: { kind: 'save', originalName: '', property: added },
    });
    assert.equal(stale['ok'], false);
    assert.equal(record(stale['error'])['code'], 'conflict');
    assert.equal(await fixture.rooms.read(component), remote);
    assert.equal(await fixture.rooms.read(consumer), instance);
    const outside = await fixture.post({
      file: 'src/../../secret.astro',
      source,
      change: { kind: 'remove', name: 'title' },
    });
    assert.ok(outside['error']);
  } finally {
    await fixture.close();
  }
});

test('a stale consumer refuses the whole undo batch without consuming its token', async () => {
  const fixture = await propertyFixture();
  try {
    const data = await fixture.get();
    const title = data.properties.find((property) => property.name === 'title');
    assert.ok(title);
    const saved = await fixture.post({
      file: component,
      source,
      change: { kind: 'save', originalName: 'title', property: { ...title, name: 'heading' } },
    });
    assert.equal(saved['ok'], true);
    const token = string(record(saved['value'])['undo']);
    const changedComponent = await fixture.rooms.read(component);
    const changedConsumer = await fixture.rooms.read(consumer);
    const room = await fixture.rooms.get(consumer);
    await fixture.rooms.coordinator.run(() => room.setSource(changedConsumer + '<!-- remote -->'));
    assert.ok((await fixture.post({ undo: token }))['error']);
    assert.equal(await fixture.rooms.read(component), changedComponent);
    assert.equal(await fixture.rooms.read(consumer), changedConsumer + '<!-- remote -->');
    await fixture.rooms.coordinator.run(() => room.setSource(changedConsumer));
    assert.equal((await fixture.post({ undo: token }))['ok'], true);
    assert.equal(await fixture.rooms.read(component), source);
    assert.equal(await fixture.rooms.read(consumer), instance);
  } finally {
    await fixture.close();
  }
});

test('component scans retain Stacki slot detection for Lumos rendered slots', async () => {
  const fixture = await propertyFixture();
  try {
    const room = await fixture.rooms.get(component);
    await fixture.rooms.coordinator.run(() =>
      room.setSource(`---
import { slotContent } from '@/utils/slots';
const content = await slotContent(Astro.slots);
const extra = await slotContent(Astro.slots, 'aside');
---
<Fragment set:html={content} /><Fragment set:html={extra} />`),
    );
    const project = await scanProject(fixture.root);
    assert.deepEqual(project.components.find((item) => item.file === component)?.slots, ['default', 'aside']);
  } finally {
    await fixture.close();
  }
});
