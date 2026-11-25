import { useEffect, useRef } from 'react';
import type { SharedDocument } from './useDocument';
import type { usePreview } from '../preview/usePreview';
import type { Session } from '../auth/useSession';
import { parseCursorState, type CursorPacket } from './cursorPresence';

export function useCursorPresence(shared: SharedDocument | undefined, page: string, preview: ReturnType<typeof usePreview>, session: Session | undefined) {
  const { subscribeLoad } = preview;
  const current = useRef({ shared, preview, session });
  const chat = useRef({ text: '', typing: false });
  current.current = { shared, preview, session };
  useEffect(() => {
    if (!shared || !preview.url) {
      return;
    }
    const origin = new URL(preview.url, location.href).origin;
    const send = (packet: CursorPacket) => {
      const own =
        packet.id === shared.selfId || (session?.kind === 'github' && shared.peers.some((peer) => peer.id === packet.id && peer.githubId === session.id));
      if (!own) {
        current.current.preview.send({
          type: 'studio:cursor-peer',
          ...packet,
          cursor: packet.page === page ? packet.cursor : null,
        });
      }
    };
    let unsubscribe = () => {};
    const exit = cursorExit(() => current.current.preview.send({ type: 'studio:cursor-leave' }));
    const loaded = () => {
      current.current.preview.send({
        type: 'studio:cursor-config',
        enabled: true,
        ...chat.current,
      });
      unsubscribe();
      unsubscribe = shared.cursors.subscribe(send);
    };
    const receive = (event: MessageEvent) => {
      if (event.source !== preview.frame.current?.contentWindow || event.origin !== origin) {
        return;
      }
      const data: unknown = event.data;
      if (!data || typeof data !== 'object' || !('type' in data) || data.type !== 'studio:cursor') {
        return;
      }
      try {
        const state = parseCursorState({ ...data, page });
        chat.current = { text: state.text, typing: state.typing };
        exit.active = state.cursor !== null;
        shared.cursors.publish(state);
      } catch {
        /* Ignore malformed preview presence. */
      }
    };
    const stopLoading = subscribeLoad(loaded);
    window.addEventListener('message', receive);
    return () => {
      unsubscribe();
      exit.dispose();
      shared.cursors.publish({ page, cursor: null, text: '', typing: false });
      current.current.preview.send({ type: 'studio:cursor-config', enabled: false });
      stopLoading();
      window.removeEventListener('message', receive);
    };
  }, [shared, page, preview.url, preview.frame, subscribeLoad, session]);
}

// A chat opened from the toolbar can have a cursor even without entering the iframe.
function cursorExit(leave: () => void) {
  const state = { active: false, dispose: () => window.removeEventListener('pointermove', moved) };
  function moved() {
    if (state.active) {
      state.active = false;
      leave();
    }
  }
  window.addEventListener('pointermove', moved, { passive: true });
  return state;
}
