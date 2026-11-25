// Prop hover previews in the demo. The Studio client asks its dev server to render
// the page once per option of a prop (variantServer.ts); the demo has no server, so
// the frame's stand-in (staticHot.ts) asks this window instead, and each option is
// rendered from the bake's templates the way an edit is (componentRender.ts) — with
// the option written into a copy of the file's text that is rendered and dropped.
// Nothing here reaches the rooms, the edit store or the undo history.
//
// The baseline goes first, so a cancel can always put the page back; then the
// option the pointer rests on, then the rest. Each render yields to the event loop,
// so a cancel or a new hover lands between two renders, not after all of them.
import { BAKE_MESSAGES } from '../src/features/bake/bakeProtocol';
import { parseVariantRequest, type VariantRequest } from '../src/features/preview/variantProtocol';
import { setAttributes } from '../src/features/settings/settingsEdits';
import { assert } from '../vendor/stacki/shared/core/assert';
import type { Attr } from '../vendor/stacki/shared/page/pageNodeTypes';
import { record } from '../src/shared/validation';

type VariantValue = VariantRequest['values'][number];
type RenderVariant = (path: string, change: { readonly file: string; readonly text: string } | undefined) => Promise<string | undefined>;

/** An option as the attribute an instance would carry: a number in braces, a word in quotes, null for unset. */
export function variantAttr(value: VariantValue): Attr | undefined {
  if (value === null) {
    return undefined;
  }
  return typeof value === 'number' ? { type: 'expr', value: String(value) } : { type: 'string', value };
}

/** The file's text with one instance's prop set to `value`; the text a preview renders, never saved. */
export function variantText(request: Pick<VariantRequest, 'source' | 'node' | 'prop'>, value: VariantValue): string {
  const text = setAttributes(request.source, request.node, { [request.prop]: variantAttr(value) });
  assert(typeof text === 'string', 'A variant is the file’s text');
  return text;
}

interface Job {
  readonly request: VariantRequest;
  priority: VariantValue | undefined;
}

export class DemoVariants {
  private job: Job | undefined;

  constructor(
    // The demo's own origin: renders go back only to a frame of this page's site.
    private readonly origin: string,
    private readonly render: RenderVariant,
  ) {}

  /** Handles a frame's variant message; false when the message is not one. */
  receive(source: MessageEventSource, data: unknown): boolean {
    if (typeof data !== 'object' || data === null || !('type' in data)) {
      return false;
    }
    if (data.type === BAKE_MESSAGES.variantCancel) {
      this.job = undefined;
      return true;
    }
    if (data.type === BAKE_MESSAGES.variantPriority) {
      const message = record(data);
      if (this.job !== undefined && message['request'] === this.job.request.request) {
        const value = message['value'];
        if (value === null || typeof value === 'string' || typeof value === 'number') {
          this.job.priority = value;
        }
      }
      return true;
    }
    if (data.type !== BAKE_MESSAGES.variantRequest) {
      return false;
    }
    let request: VariantRequest;
    try {
      request = parseVariantRequest(record(data)['data']);
    } catch {
      return true; // Not a request the protocol allows: nothing is rendered.
    }
    const job: Job = { request, priority: undefined };
    this.job = job;
    const post = (message: unknown) => source.postMessage(message, { targetOrigin: this.origin });
    void this.run(job, post).catch(() => {
      if (this.job === job) {
        post({ type: BAKE_MESSAGES.variantFailed, request: request.request });
      }
    });
    return true;
  }

  private async run(job: Job, post: (message: unknown) => void): Promise<void> {
    const { request } = job;
    const baseline = await this.render(request.path, undefined);
    if (baseline === undefined) {
      throw new Error('The page is not part of the demo');
    }
    if (this.job !== job) {
      return;
    }
    post({ type: BAKE_MESSAGES.variantRender, render: { request: request.request, html: baseline } });
    const pending: VariantValue[] = [...request.values];
    // Bounded by the protocol's option count: each pass renders one option or ends.
    for (let pass = 0; pass < request.values.length && pending.length > 0; pass++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (this.job !== job) {
        return;
      }
      const preferred = job.priority === undefined ? -1 : pending.indexOf(job.priority);
      const [value] = pending.splice(Math.max(0, preferred), 1);
      assert(value !== undefined, 'A pending option is rendered');
      const html = await this.render(request.path, { file: request.file, text: variantText(request, value) });
      if (html !== undefined && this.job === job) {
        post({ type: BAKE_MESSAGES.variantRender, render: { request: request.request, value, html } });
      }
    }
  }
}
