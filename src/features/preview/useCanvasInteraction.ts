import { useEffect, useRef, useState, type RefObject } from 'react';
import { parseCanvasNavigation, type CanvasInteraction } from '../../../shared/properties/canvasInteraction';

interface Options {
  readonly projectKey: string | undefined;
  readonly url: string | undefined;
  readonly available: boolean;
  readonly frame: RefObject<HTMLIFrameElement>;
  readonly post: (message: unknown) => void;
  readonly subscribeLoad: (listener: () => void) => () => void;
  readonly editRoute: (route: string) => void;
}

export function useCanvasInteraction(options: Options) {
  const [choice, setChoice] = useState<{
    readonly projectKey: string | undefined;
    readonly mode: CanvasInteraction;
  }>();
  const mode = options.available && choice && choice.projectKey === options.projectKey ? choice.mode : 'select';
  const { subscribeLoad } = options;
  const current = useRef({ ...options, mode });
  current.current = { ...options, mode };
  useEffect(() => {
    const send = () => current.current.post({ type: 'avb:interaction', mode });
    send();
    return subscribeLoad(send);
  }, [mode, options.url, subscribeLoad]);
  useCanvasNavigation(current);
  return {
    active: mode === 'interact',
    available: options.available,
    toggle: () =>
      setChoice({
        projectKey: options.projectKey,
        mode: mode === 'select' ? 'interact' : 'select',
      }),
  };
}

function useCanvasNavigation(current: RefObject<Options & { readonly mode: CanvasInteraction }>) {
  useEffect(() => {
    let previous: string | undefined;
    const receive = (event: MessageEvent<unknown>) => {
      const options = current.current;
      if (!options || options.mode !== 'interact' || !options.url) {
        return;
      }
      if (event.source !== options.frame.current?.contentWindow) {
        return;
      }
      const initial = new URL(options.url);
      if (event.origin !== initial.origin) {
        return;
      }
      const route = parseCanvasNavigation(event.data);
      if (route === undefined) {
        return;
      }
      const destination = route.split(/[?#]/)[0]?.replace(/\/$/, '') || '/';
      const key = JSON.stringify([options.projectKey, options.url, destination]);
      if (key === previous) {
        return;
      }
      previous = key;
      if ((initial.pathname.replace(/\/$/, '') || '/') !== destination) {
        // Keep the editor model and the visible document on the same page immediately.
        options.editRoute(destination);
      }
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [current]);
}
