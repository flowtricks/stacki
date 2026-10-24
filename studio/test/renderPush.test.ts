// Verify subscription boundaries and bounded render coalescing with explicit client inputs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { RenderPush } from '../src/features/preview/renderPush';
import { renderPath } from '../src/features/preview/renderPushServer';

test('a resumed subscription catches up without waiting for another source edit', async () => {
  const delivered: unknown[] = [];
  let html = '<section>before sleep</section>';
  const push = new RenderPush(async () => html);
  const target = {
    send: (event: string, data: unknown) => {
      if (event === 'studio:render') {
        delivered.push(data);
      }
    },
  };
  try {
    push.subscribe('/', target);
    await setTimeout(10);
    push.unsubscribe(target);
    html = '<section class="theme-dark">after resume</section>';
    push.invalidate();
    await setTimeout(10);
    delivered.length = 0;
    push.subscribe('/', target);
    await setTimeout(10);
    assert.deepEqual(delivered, [{ path: '/', html }]);
  } finally {
    push.close();
  }
});

test('preview subscriptions reject external and internal URLs', () => {
  for (const path of [
    'https://example.com/',
    '//example.com',
    '/\\example.com',
    '/studio/api/file',
    '/@fs/secrets',
    '/a/../studio/api/file',
    '/__studio-entry',
    '/\r\nHost: bad',
  ]) {
    assert.equal(renderPath({ path }), undefined);
  }
  assert.equal(renderPath({ path: '/blog?tag=astro' }), '/blog?tag=astro');
  const canvas = '/__avb/preview?defaults=12345678-1234-1234-1234-123456789012';
  assert.equal(renderPath({ path: canvas }), canvas);
  assert.equal(renderPath({ path: canvas + '&extra=1' }), undefined);
  assert.equal(renderPath({ path: '/__avb/preview?defaults=../../etc' }), undefined);
});

test('push renders coalesce hovers and share one render across subscribers', async () => {
  const deliveries: unknown[] = [];
  const waiting: ((html: string) => void)[] = [];
  const push = new RenderPush(() => new Promise((resolve) => waiting.push(resolve)));
  const first = {
    send: (event: string, data: unknown) => {
      if (event === 'studio:render') {
        deliveries.push(data);
      }
    },
  };
  const second = { send: first.send };
  try {
    push.subscribe('/', first);
    push.subscribe('/', second);
    push.invalidate();
    push.invalidate();
    await setTimeout(10);
    assert.equal(waiting.length, 1);
    push.invalidate();
    push.invalidate();
    waiting[0]?.('<h1>stale</h1>');
    await setTimeout(10);
    assert.deepEqual(deliveries, [], 'Do not paint a superseded hover');
    assert.equal(waiting.length, 2, 'Only render the latest queued state');
    waiting[1]?.('<h1>latest</h1>');
    await setTimeout(10);
    assert.deepEqual(deliveries, [
      { path: '/', html: '<h1>latest</h1>' },
      { path: '/', html: '<h1>latest</h1>' },
    ]);
    push.unsubscribe(first);
    push.unsubscribe(second);
    push.invalidate();
    await setTimeout(10);
    assert.equal(waiting.length, 2, 'Closed previews must not consume render work');
  } finally {
    push.close();
  }
});

test('render failures tell the client to use the normal fetch fallback', async () => {
  const events: string[] = [];
  const push = new RenderPush(() => Promise.reject(new Error('Astro compilation failed')));
  try {
    push.subscribe('/404', { send: (event) => events.push(event) });
    push.invalidate();
    await setTimeout(10);
    assert.deepEqual(events, ['studio:render-ready', 'studio:render-failed']);
  } finally {
    push.close();
  }
});

test('push rendering bounds concurrency and does not deliver an old page after switching', async () => {
  const waiting: { path: string; resolve: (html: string) => void }[] = [];
  const delivered: unknown[] = [];
  const push = new RenderPush((path) => new Promise((resolve) => waiting.push({ path, resolve })));
  const target = {
    send: (event: string, data: unknown) => {
      if (event === 'studio:render') {
        delivered.push(data);
      }
    },
  };
  try {
    push.subscribe('/first', target);
    push.subscribe('/second', { send: () => {} });
    push.subscribe('/third', { send: () => {} });
    push.invalidate();
    await setTimeout(10);
    assert.equal(waiting.length, 2);
    push.subscribe('/fourth', target);
    waiting[0]?.resolve('old page');
    await setTimeout(10);
    assert.deepEqual(delivered, [], 'Switching URLs removes the old subscriber');
    assert.equal(waiting.length, 3);
    assert.equal(waiting[2]?.path, '/third');
    waiting[1]?.resolve('second page');
    waiting[2]?.resolve('third page');
  } finally {
    push.close();
  }
});
