import { useEffect, useId, useState, type RefObject } from 'react';
import Popup from '../../ui/Popup';

const HOVER_DELAY_MS = 600;
interface Tip {
  readonly anchor: HTMLElement;
  readonly text: string;
}

export function ToolbarTooltip({ container }: { readonly container: RefObject<HTMLDivElement> }) {
  const [tip, setTip] = useState<Tip>();
  const id = useId();
  useEffect(() => {
    const root = container.current;
    if (!root) {
      return;
    }
    return listenForTooltip(root, setTip);
  }, [container]);
  useEffect(() => {
    if (!tip) {
      return;
    }
    const previous = tip.anchor.getAttribute('aria-describedby');
    tip.anchor.setAttribute('aria-describedby', [previous, id].filter(Boolean).join(' '));
    return () => {
      if (previous === null) {
        tip.anchor.removeAttribute('aria-describedby');
      } else {
        tip.anchor.setAttribute('aria-describedby', previous);
      }
    };
  }, [tip, id]);
  if (!tip) {
    return undefined;
  }
  const bounds = tip.anchor.getBoundingClientRect();
  return (
    <Popup
      mode="popover"
      role="tooltip"
      id={id}
      dismissible={false}
      onClose={() => setTip(undefined)}
      className="popup-tooltip"
      style={{
        position: 'fixed',
        left: Math.max(8, Math.min(bounds.left, window.innerWidth - 368)),
        top: Math.min(bounds.bottom + 8, window.innerHeight - 100),
        pointerEvents: 'none',
      }}
    >
      {tip.text}
    </Popup>
  );
}

function listenForTooltip(root: HTMLElement, show: (tip: Tip | undefined) => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let anchor: HTMLElement | undefined;
  const close = () => {
    clearTimeout(timer);
    timer = undefined;
    anchor = undefined;
    show(undefined);
  };
  const enter = (event: Event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-tooltip]') : undefined;
    if (!(target instanceof HTMLElement) || !root.contains(target) || target === anchor) {
      return;
    }
    close();
    const text = target.dataset['tooltip'];
    if (!text || text.length > 500) {
      return;
    }
    anchor = target;
    timer = setTimeout(() => show({ anchor: target, text }), HOVER_DELAY_MS);
  };
  const leave = (event: MouseEvent | FocusEvent) => {
    if (event.relatedTarget instanceof Node && anchor?.contains(event.relatedTarget)) {
      return;
    }
    close();
  };
  const key = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      close();
    }
  };
  root.addEventListener('mouseover', enter);
  root.addEventListener('mouseout', leave);
  root.addEventListener('focusin', enter);
  root.addEventListener('focusout', leave);
  root.addEventListener('pointerdown', close);
  root.addEventListener('keydown', key);
  window.addEventListener('resize', close);
  window.addEventListener('scroll', close, true);
  return () => {
    clearTimeout(timer);
    root.removeEventListener('mouseover', enter);
    root.removeEventListener('mouseout', leave);
    root.removeEventListener('focusin', enter);
    root.removeEventListener('focusout', leave);
    root.removeEventListener('pointerdown', close);
    root.removeEventListener('keydown', key);
    window.removeEventListener('resize', close);
    window.removeEventListener('scroll', close, true);
  };
}
