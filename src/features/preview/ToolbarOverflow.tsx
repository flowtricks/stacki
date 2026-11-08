import { ToolbarTooltip } from './ToolbarTooltip';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { MoreIcon } from '../../ui/Icons';
import Popup from '../../ui/Popup';
import { toolbarOverflow } from './toolbarFit';
import './toolbarOverflow.css';

// An overflowed action renders its own toolbar control, unchanged, inside the "More" popover:
// moving into the menu must not change a control's look, grouping or active state.
// `afterPress` says whether pressing one of its buttons there closes the popover. Controls that
// open their own popup or take typed input stay, so the popover does not unmount them mid-use.
export interface ToolbarItem {
  readonly id: string;
  readonly priority: number;
  readonly content: ReactNode;
  readonly afterPress: 'close' | 'stay';
}

// `childrenWidthPxMin` is the room the leading content (the breadcrumb) keeps before any
// action stays in the toolbar: without it the actions fill the row and squeeze it to nothing.
export function ToolbarOverflow({
  items,
  childrenWidthPxMin,
  children,
}: {
  readonly items: readonly ToolbarItem[];
  readonly childrenWidthPxMin: number;
  readonly children: ReactNode;
}) {
  const toolbar = useRef<HTMLDivElement>(null);
  const more = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const hidden = useToolbarOverflow(toolbar, more, items, childrenWidthPxMin);
  useCloseEmptyOverflow(hidden.length, setOpen);
  return (
    <div className="preview-toolbar" ref={toolbar}>
      {children}
      <ToolbarTooltip container={toolbar} />
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
        data-tooltip="More preview actions"
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
                <div
                  key={item.id}
                  data-toolbar-item={item.id}
                  className="preview-toolbar-item"
                  onClick={(event) => {
                    // The control's own handler has already run; this only dismisses the menu.
                    if (item.afterPress === 'close' && pressedButton(event.target)) {
                      finish(() => setOpen(false));
                    }
                  }}
                >
                  {item.content}
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
  childrenWidthPxMin: number,
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
      const padding = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
      const available = Math.max(0, element.clientWidth - padding - (parseFloat(style.columnGap) || 0) - childrenWidthPxMin);
      const measurements = items.map((item, index) => ({
        id: item.id,
        priority: item.priority,
        width: controls[index]?.offsetWidth ?? 0,
      }));
      const next = toolbarOverflow(measurements, available, button.offsetWidth, parseFloat(style.columnGap) || 0);
      setHidden((previous) => (previous.join('|') === next.join('|') ? previous : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    observer.observe(button);
    controls.forEach((control) => observer.observe(control));
    return () => observer.disconnect();
  }, [toolbar, more, items, childrenWidthPxMin]);
  return hidden;
}

function pressedButton(target: EventTarget): boolean {
  if (target instanceof Element) {
    const button = target.closest('button');
    return button !== null && !button.disabled;
  }
  return false;
}

// The popover hugs its controls and right-aligns under the "More" button, inside the viewport.
function menuPosition(anchor: HTMLElement) {
  const rect = anchor.getBoundingClientRect();
  return {
    position: 'fixed' as const,
    top: rect.bottom + 6,
    right: Math.max(8, window.innerWidth - rect.right),
    maxWidth: Math.max(80, window.innerWidth - 16),
    maxHeight: Math.max(80, window.innerHeight - rect.bottom - 14),
  };
}

function useCloseEmptyOverflow(count: number, setOpen: (open: boolean) => void): void {
  useEffect(() => {
    if (count === 0) {
      setOpen(false);
    }
  }, [count, setOpen]);
}
