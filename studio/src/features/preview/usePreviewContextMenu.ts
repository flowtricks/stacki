import { useCallback, useEffect, useState, type RefObject } from 'react';
import { parsePreviewMessage } from '../../../vendor/stacki/src/features/preview/previewMessages';
import { frameContextPoint, type ContextPoint } from '../../../vendor/stacki/src/features/preview/contextPosition';

export interface PreviewContextMenu extends ContextPoint {
  readonly generation: number;
  readonly path: string;
  readonly occurrence: number;
}

export function usePreviewContextMenu(
  frame: RefObject<HTMLIFrameElement>,
  origin: string | undefined,
  file: string,
  select: (id: string, occurrence: number) => void,
) {
  const [position, setPosition] = useState<PreviewContextMenu>();
  useEffect(() => setPosition(undefined), [file, origin]);
  useEffect(() => {
    const receive = (event: MessageEvent<unknown>): void => {
      const current = frame.current;
      if (!current || !origin || event.source !== current.contentWindow || event.origin !== origin) {
        return;
      }
      const message = parsePreviewMessage(event.data);
      if (message?.kind !== 'context-node' || !message.path || message.outside) {
        return;
      }
      if (!/^\d+(\.\d+)*$/.test(message.path)) {
        return;
      }
      const path = message.path;
      select(path, message.occurrence);
      setPosition((previous) => ({
        generation: previous ? 1 - previous.generation : 0,
        ...frameContextPoint(current, message),
        path,
        occurrence: message.occurrence,
      }));
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [frame, origin, select]);
  const close = useCallback(() => setPosition(undefined), []);
  return { position, close };
}
