import { useEffect, useRef } from 'react';
import type { usePreview } from '../preview/usePreview';

export function useCursorChatShortcut({
  preview,
  disabled,
}: {
  readonly preview: ReturnType<typeof usePreview>;
  readonly disabled: boolean;
}) {
  const current = useRef(preview);
  current.current = preview;
  useEffect(() => {
    if (disabled) {
      return;
    }
    const key = (event: KeyboardEvent) => {
      if (
        event.key !== '/' ||
        event.defaultPrevented ||
        event.isComposing ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey
      ) {
        return;
      }
      if (
        event.target instanceof Element &&
        event.target.closest(
          'input, textarea, select, [contenteditable=true], .cm-editor, [role=dialog]',
        )
      ) {
        return;
      }
      if (document.querySelector('[role=dialog], [role=listbox]')) {
        return;
      }
      event.preventDefault();
      current.current.send({ type: 'studio:cursor-chat' });
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [disabled]);
}
export function useCursorScale(preview: ReturnType<typeof usePreview>, scale: number) {
  const { subscribeLoad } = preview;
  const current = useRef(preview);
  current.current = preview;
  useEffect(() => {
    const send = () => current.current.send({ type: 'studio:cursor-scale', scale });
    return subscribeLoad(send);
  }, [scale, preview.url, preview.frame, subscribeLoad]);
}
