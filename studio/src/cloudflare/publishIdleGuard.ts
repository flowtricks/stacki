import { boundedText } from '../features/updates/catalog';
import { record, string } from '../shared/primitiveValidation';

interface IdleActions {
  readonly read: () => Promise<Response>;
  readonly renew: () => void;
  readonly stop: () => Promise<void>;
}

// The browser may close or freeze while publishing. Check the job inside the container
// before sleeping; ten failed checks give an unreachable process about thirty minutes
// to recover, without leaving broken compute running and charging indefinitely.
export class PublishIdleGuard {
  private failures = 0;

  async expire(actions: IdleActions): Promise<void> {
    const status = await readActivity(actions.read);
    if (status === 'unknown') {
      this.failures = Math.min(this.failures + 1, 10);
      if (this.failures < 10) {
        actions.renew();
        return;
      }
    } else {
      this.failures = 0;
      if (status === 'publishing') {
        actions.renew();
        return;
      }
    }
    await actions.stop();
  }
}

async function readActivity(read: IdleActions['read']): Promise<'publishing' | 'idle' | 'unknown'> {
  try {
    const response = await read();
    if (!response.headers.get('content-type')?.includes('application/json')) {
      return 'unknown';
    }
    const input: unknown = JSON.parse(await boundedText(response, 32_768));
    const state = record(input);
    if (state['gitBusy'] === true) {
      return 'publishing';
    }
    if (state['kind'] === 'building') {
      return string(state['id'], 64) ? 'publishing' : 'unknown';
    }
    return ['idle', 'committed', 'failed', 'review-open'].includes(string(state['kind'], 32)) ? 'idle' : 'unknown';
  } catch {
    return 'unknown';
  }
}
