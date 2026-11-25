// Design mode's requests to the canvas frame (shared/designMode/designModeContract.ts): a copy of the page, a
// component rendered with props, a component's palette preview. The frame shares the dev server's origin and
// relays the two fetches; the renderer only ever reads what comes back. Every request is answered once, by
// nonce, or times out; a reply that does not parse is ignored as not ours.
import {
  designModeRequestMessage,
  parseDesignModeReply,
  type DesignModeReply,
  type DesignModeRequest,
  type DesignRenderBody,
  type DesignSnapshot,
} from '../../../../shared/designMode/designModeContract';
import { hasCanvas, tellCanvas } from '../../../editor/canvasQuery';

const TIMEOUT_MS = { snapshot: 30_000, render: 20_000, preview: 30_000 } as const;
const PENDING_MAX = 64;

export type BridgeResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: 'no-canvas' | 'timeout' | 'busy' | 'failed'; readonly detail: string };

const pending = new Map<string, (reply: DesignModeReply | undefined) => void>();
let listening = false;

function listen(): void {
  if (listening) {
    return;
  }
  listening = true;
  window.addEventListener('message', (event: MessageEvent) => {
    const reply = parseDesignModeReply(event.data);
    if (reply === undefined) {
      return;
    }
    const resolve = pending.get(reply.nonce);
    if (resolve !== undefined) {
      pending.delete(reply.nonce);
      resolve(reply);
    }
  });
}

function nonce(): string {
  return crypto.randomUUID();
}

async function ask(request: DesignModeRequest, timeoutMs: number): Promise<BridgeResult<DesignModeReply & { readonly ok: true }>> {
  if (!hasCanvas()) {
    return { ok: false, reason: 'no-canvas', detail: '' };
  }
  if (pending.size >= PENDING_MAX) {
    return { ok: false, reason: 'busy', detail: '' };
  }
  listen();
  const reply = await new Promise<DesignModeReply | undefined>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(request.nonce);
      resolve(undefined);
    }, timeoutMs);
    pending.set(request.nonce, (answer) => {
      clearTimeout(timer);
      resolve(answer);
    });
    if (!tellCanvas(designModeRequestMessage(request))) {
      clearTimeout(timer);
      pending.delete(request.nonce);
      resolve(undefined);
    }
  });
  if (reply === undefined) {
    return { ok: false, reason: 'timeout', detail: '' };
  }
  if (!reply.ok) {
    return { ok: false, reason: 'failed', detail: reply.detail };
  }
  return { ok: true, value: reply };
}

/** A copy of the page the canvas shows now. */
export async function requestSnapshot(): Promise<BridgeResult<DesignSnapshot>> {
  const answer = await ask({ op: 'snapshot', nonce: nonce() }, TIMEOUT_MS.snapshot);
  if (!answer.ok) {
    return answer;
  }
  return answer.value.kind === 'snapshot' ? { ok: true, value: answer.value.snapshot } : { ok: false, reason: 'failed', detail: 'not a snapshot' };
}

/** One component rendered by the dev server with `body`'s props and slots; nothing is written. */
export async function requestRender(body: DesignRenderBody): Promise<BridgeResult<string>> {
  const answer = await ask({ op: 'render', nonce: nonce(), body }, TIMEOUT_MS.render);
  if (!answer.ok) {
    return answer;
  }
  return answer.value.kind === 'html' ? { ok: true, value: answer.value.html } : { ok: false, reason: 'failed', detail: 'not html' };
}

/** A component's palette preview page (its insertion recipe rendered), as HTML. */
export async function requestPreview(component: string): Promise<BridgeResult<string>> {
  const answer = await ask({ op: 'preview', nonce: nonce(), component }, TIMEOUT_MS.preview);
  if (!answer.ok) {
    return answer;
  }
  return answer.value.kind === 'html' ? { ok: true, value: answer.value.html } : { ok: false, reason: 'failed', detail: 'not html' };
}
