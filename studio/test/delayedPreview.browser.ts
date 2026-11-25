// Goal: exercise stale preview delivery without delaying collaboration messages.
// Method: hold each real pushed render for 250ms in one editor, bound the queue,
// and cancel pending deliveries when the browser closes.
import assert from 'node:assert/strict';
import { setTimeout as wait } from 'node:timers/promises';
import type { Page } from 'playwright';

export async function delayPreviewRenders(page: Page) {
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let enabled = false;
  let delivered = 0;
  await page.routeWebSocket('**/*', (socket) => {
    const server = socket.connectToServer();
    server.onMessage((message) => {
      if (enabled && String(message).includes('"event":"studio:render"')) {
        assert.ok(timers.size < 30, 'Delayed preview queue stays bounded');
        const timer = setTimeout(() => {
          timers.delete(timer);
          socket.send(message);
          delivered++;
        }, 250);
        timers.add(timer);
      } else {
        socket.send(message);
      }
    });
  });
  page.on('close', () => {
    for (const timer of timers) {
      clearTimeout(timer);
    }
    timers.clear();
  });
  return {
    enable() {
      enabled = true;
    },
    async drain() {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (timers.size === 0) {
          return;
        }
        await wait(50);
      }
      assert.fail('Delayed renders did not drain within five seconds');
    },
    assertDelivered() {
      assert.ok(delivered > 0, 'The test must actually deliver delayed server renders');
    },
  };
}
