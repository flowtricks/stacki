// Goal: full-page rendering does not compete with every streamed text keystroke.
// Method: advance a monotonic clock and timers to check quiet periods, the hard
// deadline and immediate structural work; parse actual source to classify changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { RenderPush } from '../src/features/preview/renderPush';
import { sourceRenderMode } from '../src/features/preview/sourceRenderMode';

test('only literal source changes use the typing render window', () => {
  const before = '<Heading size="large">Hello <strong>world</strong></Heading>';
  assert.equal(sourceRenderMode('src/pages/index.astro', before, before.replace('Hello', 'Hi')), 'typing');
  for (const after of [
    before.replace('large', 'small'),
    before.replace('strong', 'em'),
    before.replace('Hello', '{message}'),
    '<Button>B</Button><Button>A</Button>',
  ]) {
    assert.equal(sourceRenderMode('src/pages/index.astro', before, after), 'immediate');
  }
  assert.equal(sourceRenderMode('src/data/page.json', '"Hello"', '"Hi"'), 'immediate');
});

test('typing coalesces renders, has a deadline, and never delays structural edits', async (context) => {
  let now = 0;
  let renders = 0;
  context.mock.method(performance, 'now', () => now);
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const push = new RenderPush(async () => {
    renders++;
    return '<h1>Current</h1>';
  });
  const advance = async (elapsed: number) => {
    now += elapsed;
    context.mock.timers.tick(elapsed);
    await setImmediate();
  };
  try {
    push.subscribe('/', { send: () => {} });
    await advance(0);
    assert.equal(renders, 1);
    for (let index = 0; index < 5; index++) {
      push.sourceWritten('typing');
      push.invalidate();
      await advance(100);
    }
    assert.equal(renders, 1, 'A burst must not render each intermediate character');
    await advance(300);
    assert.equal(renders, 2, 'The latest source renders after a quiet period');
    for (let index = 0; index < 20; index++) {
      push.sourceWritten('typing');
      push.invalidate();
      await advance(100);
    }
    assert.equal(renders, 3, 'Continuous typing cannot starve authoritative renders');
    push.sourceWritten('typing');
    push.invalidate();
    push.sourceWritten('immediate');
    push.invalidate();
    await advance(0);
    assert.equal(renders, 4, 'Structural work cancels the typing delay');
  } finally {
    push.close();
  }
});
