import { record } from '../src/shared/validation';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyVariant, instrumentVariant, variantScope } from '../src/features/preview/variantRuntime';
import { parseVariantRequest } from '../src/features/preview/variantProtocol';

test('variant renders isolate async request props and never change another instance', async () => {
  const render = (value: string | null) =>
    variantScope.run(
      {
        component: 'Heading.astro',
        target: '0.1',
        prop: 'variant',
        value,
      },
      async () => {
        await new Promise<void>((resolve) => setImmediate(resolve));
        const selected = { 'data-avb-p': '0.1', variant: 'original', content: 'Keep me' };
        const sibling = { 'data-avb-p': '0.2', variant: 'original' };
        applyVariant(selected, 'Heading.astro');
        applyVariant(sibling, 'Heading.astro');
        assert.equal(sibling.variant, 'original');
        assert.equal(selected.content, 'Keep me');
        return selected.variant;
      },
    );
  assert.deepEqual(await Promise.all([render('cards'), render('table'), render(null)]), ['cards', 'table', undefined]);
  const normal = { 'data-avb-p': '0.1', variant: 'original' };
  applyVariant(normal, 'Heading.astro');
  assert.equal(normal.variant, 'original');
});

test('variant instrumentation precedes props destructuring without touching authored bytes', () => {
  const source = '---\nconst {variant} = Astro.props;\n---\n{variant === "a" ? <section/> : <article/>}\n';
  const marked = instrumentVariant(source, 'Card.astro', '/studio/variantRuntime.mjs');
  assert.ok(marked.indexOf('__studioApplyVariant(Astro.props') < marked.indexOf('const {variant}'));
  assert.ok(marked.endsWith(source.slice(4)));
  assert.ok(instrumentVariant('<div/>', 'Card.astro', '/runtime.mjs').endsWith('---\n<div/>'));
});

test('variant request bounds and primitive values reject code and unsafe keys', () => {
  const request = {
    request: 'one',
    path: '/',
    file: 'src/pages/index.astro',
    node: 'n0.1',
    component: 'src/components/Card.astro',
    source: '<Card/>',
    prop: 'variant',
    values: ['a', null, 2],
  };
  assert.deepEqual(parseVariantRequest(request).values, request.values);
  for (const invalid of [
    { prop: '__proto__' },
    { prop: 'set:html' },
    { values: [{}] },
    { values: Array.from({ length: 33 }, () => 'a') },
    { component: '../private' },
  ]) {
    assert.throws(() => parseVariantRequest({ ...request, ...invalid }));
  }
});

test('cached render replies obey latest hover, cancel, commit and source invalidation', async () => {
  const { createVariantPreview } = await import('../src/features/preview/variantClient');
  const documentBefore = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const locationBefore = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const events = new EventTarget();
  Object.defineProperty(globalThis, 'document', { value: events, configurable: true });
  Object.defineProperty(globalThis, 'location', {
    value: { pathname: '/', search: '' },
    configurable: true,
  });
  const handlers = new Map<string, (data: unknown) => void>();
  const sent: { event: string; data: unknown }[] = [];
  const painted: unknown[] = [];
  events.addEventListener('studio:render-html', (event) => {
    if (event instanceof CustomEvent) {
      painted.push(event.detail as unknown);
    }
  });
  try {
    const preview = createVariantPreview({
      on: (event, handler) => handlers.set(event, handler),
      send: (event, data) => {
        sent.push({ event, data });
      },
    });
    preview.receive({ action: 'prepare', prop: 'variant' });
    const request = record(sent.find((item) => item.event === 'studio:variants-prepare')?.data)['request'];
    const render = async (value: string, html: string) => {
      handlers.get('studio:variant-render')?.({ request, value, html });
      await Promise.resolve();
    };
    handlers.get('studio:variant-render')?.({ request, html: 'baseline' });
    preview.receive({ action: 'hover', value: 'list' });
    preview.receive({ action: 'hover', value: 'table' });
    await render('list', 'list markup');
    assert.deepEqual(painted, []);
    await render('table', 'table markup');
    assert.deepEqual(painted, ['table markup']);
    preview.receive({ action: 'cancel' });
    assert.equal(painted.at(-1), 'baseline');
    preview.receive({ action: 'hover', value: 'list' });
    assert.equal(painted.at(-1), 'list markup');
    preview.receive({ action: 'commit' });
    preview.receive({ action: 'reset' });
    assert.equal(painted.at(-1), 'list markup', 'Keep committed preview until authoritative HTML arrives');
    preview.authoritative('new draft');
    await render('table', 'stale markup');
    assert.equal(painted.at(-1), 'new draft');
    assert.ok(sent.some((item) => item.event === 'studio:variants-prioritize'));
  } finally {
    if (documentBefore) {
      Object.defineProperty(globalThis, 'document', documentBefore);
    } else {
      Reflect.deleteProperty(globalThis, 'document');
    }
    if (locationBefore) {
      Object.defineProperty(globalThis, 'location', locationBefore);
    } else {
      Reflect.deleteProperty(globalThis, 'location');
    }
  }
});
