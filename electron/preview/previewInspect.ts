// Asks the dev server for one page and says whether it can be shown (shared/ipc/previewHealth.ts judges what arrived).
//
// Why not `fetch`: it hides the case that matters most. A dev server that answers 200, streams the start of the page
// and then crashes while a component renders either surfaces as an opaque "terminated" error or, with buffering,
// as a normal-looking short body. Reading the response with node's http client keeps three outcomes apart: the body
// ended (`complete`), the connection died after the headers (`dropped`), and the reader stopped at its byte limit
// (`capped`), so a cut-off page is not mistaken for a small one.
import * as http from 'node:http';
import { assert } from '../../shared/core/assert';
import {
  PREVIEW_HEALTH_LIMITS,
  classifyPreviewResponse,
  extractThrownError,
  type PreviewHealth,
  type PreviewResponseSample,
} from '../../shared/ipc/previewHealth';

export const PREVIEW_INSPECT_LIMITS = {
  /** How long one inspection waits, from the request to the end of the body. */
  timeoutMs: 8_000,
} as const satisfies Record<string, number>;

/**
 * Fetches `url` and judges the page. `logTail` is the end of the dev server's log, from which the thrown error is
 * taken when the response itself does not carry it. Never rejects: a dead server is the verdict `unreachable`.
 */
export async function inspectPreviewPage(url: string, logTail: string): Promise<PreviewHealth> {
  assert(PREVIEW_INSPECT_LIMITS.timeoutMs > 0, 'An inspection has a time limit');
  assert(logTail.length <= PREVIEW_HEALTH_LIMITS.logTailCharsMax, 'The log tail is bounded');
  const sample = await readSample(url);
  const judged = classifyPreviewResponse(sample);
  if (judged.kind === 'ok') {
    return judged;
  }
  // The log's error is the newest one; for a page the server could not finish it is the one that cut it off.
  return { ...judged, thrown: judged.thrown ?? extractThrownError(logTail), logTail };
}

function readSample(url: string): Promise<PreviewResponseSample> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (sample: PreviewResponseSample): void => {
      if (!settled) {
        settled = true;
        resolve(sample);
      }
    };
    const unreachable: PreviewResponseSample = { reached: false, status: 0, contentType: undefined, body: '', reading: 'complete' };
    let request: http.ClientRequest;
    try {
      request = http.get(url, { timeout: PREVIEW_INSPECT_LIMITS.timeoutMs, headers: { accept: 'text/html' } });
    } catch {
      finish(unreachable);
      return;
    }
    // The first byte may never come: the socket timeout covers an idle connection, this covers one that trickles.
    const deadline = setTimeout(() => request.destroy(), PREVIEW_INSPECT_LIMITS.timeoutMs);
    request.on('timeout', () => request.destroy());
    request.on('error', () => {
      clearTimeout(deadline);
      finish(unreachable);
    });
    request.on('response', (response) => {
      const chunks: Buffer[] = [];
      let received = 0;
      const sampleOf = (reading: PreviewResponseSample['reading']): PreviewResponseSample => ({
        reached: true,
        status: response.statusCode ?? 0,
        contentType: typeof response.headers['content-type'] === 'string' ? response.headers['content-type'] : undefined,
        body: Buffer.concat(chunks).toString('utf8'),
        reading,
      });
      const done = (reading: PreviewResponseSample['reading']): void => {
        clearTimeout(deadline);
        finish(sampleOf(reading));
      };
      response.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        received += chunk.length;
        if (received >= PREVIEW_HEALTH_LIMITS.bodyBytesMax) {
          done('capped');
          request.destroy();
        }
      });
      response.on('end', () => done('complete'));
      // Both a reset socket and a body that ended before its declared length arrive here.
      response.on('error', () => done('dropped'));
      response.on('aborted', () => done('dropped'));
      response.on('close', () => done(response.complete ? 'complete' : 'dropped'));
    });
  });
}
