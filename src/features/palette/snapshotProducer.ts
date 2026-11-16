import { parsePreviewSnapshotMessage, parsePreviewUnchangedMessage } from '../../../shared/properties/previewSnapshot';
import { parseComponentPreviewMessage } from './paletteModel';
import { RENDER_TIMEOUT_MS, type ProduceOutcome, type Producer, type TileSource } from './previewSnapshotStore';

// Renders a tile the one way there is: load the preview route in a frame nobody sees and wait for the page
// to hand back its snapshot. The frames live off screen in one container, are removed as soon as they answer,
// and number at most the store's concurrency, so producing pictures in the background costs the editor
// no more than one extra page load at a time.

/** After its page loads, how long a frame may stay silent before it is taken for an error page. */
export const SILENT_AFTER_LOAD_MS = 6000;

export interface FrameProducerOptions {
  /** The page the frames live in, read when a frame is made (a test swaps its page between runs). */
  readonly document: () => Document;
  /** Turns a route address into one the frame may load (Studio's draft sessions); the address itself when absent. */
  readonly resolve?: ((url: string) => Promise<string>) | undefined;
}

export function createFrameProducer({ document: hostDocument, resolve }: FrameProducerOptions): Producer {
  let container: HTMLElement | undefined;
  const hold = (): HTMLElement => {
    if (container === undefined || !container.isConnected) {
      container = hostDocument().createElement('div');
      container.setAttribute('aria-hidden', 'true');
      container.style.cssText = 'position:fixed;left:-10000px;top:0;width:1200px;height:800px;opacity:0;pointer-events:none;overflow:hidden';
      hostDocument().body.appendChild(container);
    }
    return container;
  };
  return async (source: TileSource, knownKey: string | undefined): Promise<ProduceOutcome> => {
    const withKnown = knownKey === undefined ? source.url : `${source.url}&known=${knownKey}`;
    let url: string;
    try {
      url = resolve === undefined ? withKnown : await resolve(withKnown);
    } catch {
      return { kind: 'unresolved' };
    }
    return await new Promise<ProduceOutcome>((resolve) => {
      const frame = hostDocument().createElement('iframe');
      frame.title = `${source.name} preview`;
      frame.tabIndex = -1;
      frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
      frame.style.cssText = 'width:1200px;height:800px;border:0';
      let silence: ReturnType<typeof setTimeout> | undefined;
      let sawReady = false;
      const finish = (outcome: ProduceOutcome): void => {
        clearTimeout(overall);
        clearTimeout(silence);
        window.removeEventListener('message', receive);
        frame.remove();
        resolve(outcome);
      };
      const receive = (event: MessageEvent<unknown>): void => {
        if (event.source !== frame.contentWindow) {
          return;
        }
        const snapshot = parsePreviewSnapshotMessage(event.data);
        if (snapshot !== undefined) {
          finish({ kind: 'snapshot', message: snapshot });
          return;
        }
        const unchanged = parsePreviewUnchangedMessage(event.data);
        if (unchanged !== undefined) {
          finish({ kind: 'unchanged', key: unchanged.key });
          return;
        }
        const status = parseComponentPreviewMessage(event.data);
        if (status?.status === 'empty') {
          finish({ kind: 'empty', reason: status.reason ?? 'The component rendered nothing.' });
        } else if (status?.status === 'ready') {
          sawReady = true;
        }
      };
      const overall = setTimeout(() => finish({ kind: 'timeout' }), RENDER_TIMEOUT_MS);
      window.addEventListener('message', receive);
      frame.addEventListener('load', () => {
        silence = setTimeout(() => {
          // A page that is ready but never sends its snapshot is as stuck as one that never answered.
          finish(
            sawReady
              ? { kind: 'timeout' }
              : { kind: 'empty', reason: 'Threw: The preview page loaded but did not render the component. Open it on a page to see the error.' },
          );
        }, SILENT_AFTER_LOAD_MS);
      });
      frame.src = url;
      hold().appendChild(frame);
    });
  };
}
