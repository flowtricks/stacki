// `dev:restart`: main restarting the project's dev server on purpose (the preview on the local network turned on or
// off, a changed .env, a new integration or content config). Without it a restart looks to the renderer like a server
// that died: it said "Preview is offline" about a server that was running.
//
// `begun` is sent before the old server stops, and `done` once the new one answers, with its address (the old one
// unless that port was taken meanwhile), or without one when it did not start.
import { record, text } from '../core/boundary';

export type DevRestartNotice = { readonly kind: 'begun' } | { readonly kind: 'done'; readonly url: string | undefined };

/** An address longer than this is not a dev server's. */
const DEV_URL_CHARS_MAX = 256;

export function parseDevRestartNotice(input: unknown): DevRestartNotice {
  const fields = record(input);
  const kind = fields['kind'];
  if (kind === 'begun') {
    return { kind };
  }
  if (kind !== 'done') {
    throw new Error('DevRestartNotice.kind: expected begun or done');
  }
  if (fields['url'] === undefined) {
    return { kind, url: undefined };
  }
  const url = text(fields['url']);
  if (url.length > DEV_URL_CHARS_MAX) {
    throw new Error('DevRestartNotice.url: exceeds limit');
  }
  if (!URL.canParse(url) || new URL(url).protocol !== 'http:') {
    throw new Error('DevRestartNotice.url: expected an http address');
  }
  return { kind, url };
}
