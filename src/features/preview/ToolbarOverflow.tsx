import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { MoreIcon } from '../../ui/Icons';
import Popup from '../../ui/Popup';
import { toolbarOverflow } from './toolbarFit';
import './toolbarOverflow.css';

export interface ToolbarItem {
  readonly id: string;
  readonly priority: number;
  readonly content: ReactNode;
  readonly menu: (finish: (action: () => void) => void) => ReactNode;
}

export function ToolbarOverflow({
  items,
  children,
}: {
  readonly items: readonly ToolbarItem[];
  readonly children: ReactNode;
}) {
  const toolbar = useRef<HTMLDivElement>(null);
  const more = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const hidden = useToolbarOverflow(toolbar, more, items);
  useEffect(() => {
    if (hidden.length === 0) {
      setOpen(false);
    }
  }, [hidden.length]);
  return (
    <div className="preview-toolbar" ref={toolbar}>
      {children}
      {items.map((item) => (
        <div
          key={item.id}
          data-toolbar-item={item.id}
          className={`preview-toolbar-item ${hidden.includes(item.id) ? 'is-overflow' : ''}`}
          aria-hidden={hidden.includes(item.id) || undefined}
        >
          {item.content}
        </div>
      ))}
      <button
        ref={more}
        className={`preview-toolbar-more ${hidden.length ? '' : 'is-overflow'}`}
        aria-hidden={!hidden.length || undefined}
        aria-label="More preview actions"
        aria-haspopup="dialog"
        aria-expanded={open && hidden.length > 0}
        onClick={() => setOpen(!open)}
      >
        <MoreIcon size={18} />
      </button>
      {hidden.length > 0 && more.current && (
        <Popup
          mode="popover"
          open={open}
          anchor={more.current}
          onClose={() => setOpen(false)}
          className="preview-toolbar-menu"
          role="dialog"
          label="More preview actions"
          style={menuPosition(more.current)}
        >
          {({ finish }) =>
            items
              .filter((item) => hidden.includes(item.id))
              .map((item) => (
                <div key={item.id} className="preview-toolbar-menu-item">
                  {item.menu((action) =>
                    finish(() => {
                      setOpen(false);
                      action();
                    }),
                  )}
                </div>
              ))
          }
        </Popup>
      )}
    </div>
  );
}

function useToolbarOverflow(
  toolbar: RefObject<HTMLDivElement>,
  more: RefObject<HTMLButtonElement>,
  items: readonly ToolbarItem[],
): readonly string[] {
  const [hidden, setHidden] = useState<readonly string[]>([]);
  useLayoutEffect(() => {
    const element = toolbar.current;
    const button = more.current;
    if (!element || !button) {
      return undefined;
    }
    const controls = Array.from(element.querySelectorAll<HTMLElement>('[data-toolbar-item]'));
    const measure = () => {
      const style = window.getComputedStyle(element);
      const available =
        element.clientWidth -
        (parseFloat(style.paddingLeft) || 0) -
        (parseFloat(style.paddingRight) || 0) -
        (parseFloat(style.columnGap) || 0);
      const measurements = items.map((item, index) => ({
        id: item.id,
        priority: item.priority,
        width: controls[index]?.offsetWidth ?? 0,
      }));
      const next = toolbarOverflow(
        measurements,
        available,
        button.offsetWidth,
        parseFloat(style.columnGap) || 0,
      );
      setHidden((previous) => (previous.join('|') === next.join('|') ? previous : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    observer.observe(button);
    controls.forEach((control) => observer.observe(control));
    return () => observer.disconnect();
  }, [toolbar, more, items]);
  return hidden;
}

function menuPosition(anchor: HTMLElement) {
  const rect = anchor.getBoundingClientRect();
  const width = Math.min(280, window.innerWidth - 16);
  return {
    position: 'fixed' as const,
    top: rect.bottom + 6,
    left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)),
    width,
    maxHeight: Math.max(80, window.innerHeight - rect.bottom - 14),
  };
}
