import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { record } from '../src/shared/validation';

export async function checkStyleQueries(page: Page) {
  const frame = page.frameLocator('iframe[title="Site preview"]');
  const path = await frame.locator('#child').getAttribute('data-avb-p');
  assert.ok(path);
  const answer = await query(page, { path, props: ['color', 'font-size'] });
  assert.equal(answer['ready'], true);
  assert.equal(answer['found'], true);
  assert.equal(record(answer['computedProps'])['color'], 'rgb(20, 60, 100)');
  assert.equal(record(answer['computedProps'])['font-size'], '22px');
  assert.equal(record(record(answer['inheritedSources'])['color'])['label'], '.parent');
  const text = await query(page, {
    path: path + '.999',
    textParentPath: path,
    props: ['color'],
    selectors: ['span'],
  });
  assert.equal(text['found'], true);
  assert.equal(text['identity'], undefined);
  assert.equal(record(text['matched'])['span'], false);
  assert.equal(record(text['computedProps'])['color'], 'rgb(20, 60, 100)');
  const missing = await query(page, { path: '999.999', props: ['color'] });
  assert.equal(missing['found'], false);
  assert.deepEqual(missing['computedProps'], {});
  const colors = await query(page, { path, compute: ['var(--accent)', 'invalid-color'] });
  assert.equal(record(colors['computed'])['var(--accent)'], 'rgb(30, 140, 80)');
  assert.equal(record(colors['computed'])['invalid-color'], undefined);
}
async function query(page: Page, input: Record<string, unknown>) {
  const response: unknown = await page.evaluate(
    (input) =>
      new Promise((resolve, reject) => {
        const frame = document.querySelector('iframe');
        if (!frame?.contentWindow) {
          throw new Error('No preview');
        }
        const target = frame.contentWindow;
        const id = 1_000_000 + Math.floor(Math.random() * 100_000);
        const receive = (event: MessageEvent<unknown>) => {
          const data = event.data;
          if (
            event.source !== target ||
            !data ||
            typeof data !== 'object' ||
            !('type' in data) ||
            data.type !== 'avb:query-result' ||
            !('id' in data) ||
            data.id !== id
          ) {
            return;
          }
          clearTimeout(timeout);
          window.removeEventListener('message', receive);
          resolve(data);
        };
        const timeout = setTimeout(() => {
          window.removeEventListener('message', receive);
          reject(new Error('Preview did not answer'));
        }, 5000);
        window.addEventListener('message', receive);
        target.postMessage({ type: 'avb:query', id, selectors: [], props: [], compute: [], ...input }, new URL(frame.src).origin);
      }),
    input,
  );
  return record(response);
}
