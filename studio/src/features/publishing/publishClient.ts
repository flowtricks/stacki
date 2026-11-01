import type { PublishTarget } from '../../../vendor/stacki/shared/properties/publishConfig';
import type { PublishState } from './publish';
import { request } from '../project/projectClient';
import { StudioRequestError } from '../project/responseError';
import { beginOperation } from '../session/activity';
import { record, string } from '../../shared/validation';
import { parseReviewReceipt } from '../../../vendor/stacki/shared/properties/publishReview';

export function parsePublishState(value: unknown): PublishState {
  const data = record(value);
  const kind = data['kind'];
  if (kind === 'idle') {
    return { kind };
  }
  const id = string(data['id'] ?? '', 64);
  if (kind === 'review-open') {
    return { kind, id, ...parseReviewReceipt(data) };
  }
  const deployment = data['deployment'];
  if (deployment !== undefined && deployment !== 'pending' && deployment !== 'live') {
    throw new Error('Invalid deployment status');
  }
  if (kind === 'building' && id) {
    const stage = data['stage'];
    if (stage === undefined) {
      return { kind, id };
    }
    if (stage === 'preparing' || stage === 'building' || stage === 'committing' || stage === 'cleanup' || stage === 'deploying') {
      return {
        kind,
        id,
        stage,
        ...(data['deployment'] === 'pending' ? { deployment: 'pending' } : {}),
      };
    }
    throw new Error('Invalid publish stage');
  }
  if (kind === 'failed') {
    return { kind, id, message: string(data['message'], 20_000) };
  }
  if (kind === 'committed') {
    if (data['github'] !== undefined && data['github'] !== 'skipped') {
      throw new Error('Invalid GitHub publish status');
    }
    return {
      kind,
      id,
      sha: string(data['sha'], 64),
      url: string(data['url'], 1000),
      ...(deployment ? { deployment } : {}),
      ...(data['github'] === 'skipped' ? { github: 'skipped' as const } : {}),
      ...(data['cleanupWarning'] ? { cleanupWarning: string(data['cleanupWarning'], 2000) } : {}),
    };
  }
  throw new Error('Invalid publish status');
}
export async function publishProject(signal: AbortSignal, target: PublishTarget = 'all', progress?: (state: PublishState) => void): Promise<PublishState> {
  const finish = beginOperation();
  try {
    // Never automatically retry a POST: it may already have started a commit.
    const state = parsePublishState(
      await request(`/studio/api/publish?target=${target}`, {
        method: 'POST',
        signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
      }),
    );
    progress?.(state);
    return state.kind === 'building' ? await watchPublish(state.id, signal, progress) : state;
  } catch (error) {
    if (error instanceof StudioRequestError && error.transient) {
      throw new Error('The publish connection was interrupted. Check GitHub before publishing again. Your sign-in has not been cleared.');
    }
    throw error;
  } finally {
    finish();
  }
}
export async function watchPublish(id: string, signal: AbortSignal, progress?: (state: PublishState) => void): Promise<PublishState> {
  const deadline = Date.now() + 1_800_000;
  let unavailable = 0;
  // A background tab may resume after the deadline: read the final result before timing out.
  for (let attempt = 0; attempt < 1200; attempt++) {
    await delay(1500, signal);
    try {
      const status = record(
        await request('/studio/api/status', {
          signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        }),
      );
      const state = parsePublishState(status['publishing']);
      unavailable = 0;
      if (state.kind === 'idle' || state.id !== id) {
        throw new Error('Studio restarted or the publish job changed. Check GitHub before publishing again.');
      }
      progress?.(state);
      if (state.kind !== 'building') {
        return state;
      }
      if (Date.now() >= deadline) {
        break;
      }
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      if (!(error instanceof StudioRequestError) || !error.transient || ++unavailable > 12) {
        throw error;
      }
      await delay(error.status === 429 ? 30_000 : 3000, signal);
    }
  }
  throw new Error('Publishing is taking longer than expected. Check GitHub before publishing again.');
}
function delay(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException('Cancelled', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
  });
}
