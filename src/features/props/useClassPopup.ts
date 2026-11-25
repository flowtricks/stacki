import { useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react';
import { popupBox } from '../../ui/Dropdown';

export function useClassPopup(anchor: RefObject<HTMLElement>, count: number, options: { readonly open: boolean; readonly matchWidth?: boolean }) {
  const { open, matchWidth = true } = options;
  const [position, setPosition] = useState<CSSProperties>();
  useLayoutEffect(() => {
    if (!open || !count) {
      setPosition(undefined);
      return;
    }
    const update = () => {
      const rect = anchor.current?.getBoundingClientRect();
      if (!rect) {
        setPosition(undefined);
        return;
      }
      const viewport = window.visualViewport;
      const height = viewport?.height ?? window.innerHeight;
      const width = viewport?.width ?? window.innerWidth;
      const offsetTop = viewport?.offsetTop ?? 0;
      const offsetLeft = viewport?.offsetLeft ?? 0;
      // Keep the menu compact while every matching class remains scrollable.
      const wanted = Math.min(count * 26 + 10, 322);
      const box = popupBox({ top: rect.top - offsetTop, bottom: rect.bottom - offsetTop }, wanted, height);
      const heightMax = Math.min(box.maxHeight ?? wanted, height - 16, matchWidth ? wanted : 300);
      const top = box.top ?? height - (box.bottom ?? 0) - heightMax;
      const popupWidth = Math.min(rect.width, width - 16);
      const left = Math.max(offsetLeft + 8, Math.min(rect.left, offsetLeft + width - popupWidth - 8));
      setPosition({
        left,
        top: offsetTop + Math.max(8, Math.min(top, height - heightMax - 8)),
        ...(matchWidth ? { width: popupWidth } : {}),
        maxWidth: offsetLeft + width - left - 8,
        maxHeight: Math.max(0, heightMax),
      });
    };
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    window.visualViewport?.addEventListener('resize', update);
    window.visualViewport?.addEventListener('scroll', update);
    const observer = new ResizeObserver(update);
    if (anchor.current) {
      observer.observe(anchor.current);
    }
    return () => {
      observer.disconnect();
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('scroll', update);
    };
  }, [anchor, count, open, matchWidth]);
  return position;
}
