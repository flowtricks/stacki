import type { PreloadBridge } from '../../../vendor/stacki/shared/ipc/preloadApi';
import { request } from '../project/projectClient';

export const historyTransport = {
  log: (payload: Parameters<PreloadBridge['gitLog']>[0]) =>
    request(
      payload.ref && /^[a-f0-9]{40}$/.test(payload.ref)
        ? `/studio/api/history/commit?hash=${encodeURIComponent(payload.ref)}`
        : `/studio/api/history/log?skip=${payload.skip ?? 0}&scope=${payload.ref === undefined ? 'all' : 'current'}`,
    ),
  diff: (payload: Parameters<PreloadBridge['gitCommitDiff']>[0]) =>
    request('/studio/api/history/diff', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
};
