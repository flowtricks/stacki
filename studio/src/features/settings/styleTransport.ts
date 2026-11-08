import { request } from '../project/projectClient';
import { record, string } from '../../shared/validation';
import { readStyleResource } from './styleReads';

const baselines = new Map<string, string>();
const queues = new Map<string, Promise<unknown>>();

// How long style writes must rest before the rest of Studio hears that a source
// changed. A drag writes many times a second; every listener (canvas text, CMS
// panels, component counts, publish status) re-reading per tick only adds lag,
// and none of them reads stylesheets. The canvas follows each write on its own.
const SOURCE_UPDATED_QUIET_MS = 250;
let sourceUpdatedTimer: ReturnType<typeof setTimeout> | undefined;
function announceSourceUpdated() {
  // The window that saw the write hears about it, even if the page has moved on.
  const target = window;
  clearTimeout(sourceUpdatedTimer);
  sourceUpdatedTimer = setTimeout(() => {
    sourceUpdatedTimer = undefined;
    target.dispatchEvent(new Event('studio:source-updated'));
  }, SOURCE_UPDATED_QUIET_MS);
}
export const styleTransport = {
  listStyleFiles: (_project: unknown) => readStyleResource('/studio/api/styles'),
  listAstroStyleFiles: (_project: unknown) => readStyleResource('/studio/api/styles?astro=1'),
  async readStyleFile(input: unknown) {
    const file = string(input, 500);
    const data = record(await readStyleResource('/studio/api/file?file=' + encodeURIComponent(file)));
    const source = string(data['source']);
    if (baselines.size >= 1000 && !baselines.has(file)) {
      baselines.clear();
    }
    baselines.set(file, source);
    return { css: source };
  },
  writeStyleFile(input: unknown) {
    const data = record(input);
    const file = string(data['filePath'], 500);
    const source = string(data['css']);
    // Bind the write to the document that produced it. A background variable or
    // font scan can read a newer version while an older style edit is pending.
    const expected = data['base'] === undefined ? undefined : string(data['base']);
    const prior = queues.get(file) ?? Promise.resolve();
    const write = prior.then(async () => {
      const base = expected ?? baselines.get(file);
      if (base === undefined) {
        throw new Error('Read the stylesheet before editing it');
      }
      const result = await request('/studio/api/source', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file, source, base }),
      });
      baselines.set(file, source);
      announceSourceUpdated();
      return result;
    });
    queues.set(file, write);
    void write
      .finally(() => {
        if (queues.get(file) === write) {
          queues.delete(file);
        }
      })
      .catch(() => {});
    return write;
  },
};
