import { useTranslate } from '../../lib/i18n/useTranslate';
import React, { useLayoutEffect, useRef, useState } from 'react';
import Popup from '../../ui/Popup';
import { ChevronRightIcon } from '../../ui/Icons';
import { currentDesktopPlatform, shortcutLabel } from '../../lib/shortcutLabel';

export type ContextAction = 'defaults' | 'open' | 'cut' | 'copy' | 'paste' | 'duplicate' | 'delete' | 'div' | 'a' | 'convert-div' | 'convert-span';
export interface ContextPosition {
  readonly left: number;
  readonly top: number;
  readonly nodeId: string;
}

interface MenuProps {
  readonly position: ContextPosition;
  readonly component: boolean;
  readonly canOpen: boolean;
  readonly canSetDefaults: boolean;
  readonly canWrapBox: boolean;
  readonly canWrapLink: boolean;
  /** Bare text: it has no tag to wrap, so it is offered one instead. */
  readonly plainText: boolean;
  readonly canConvertDiv: boolean;
  readonly canConvertSpan: boolean;
  readonly canPaste: boolean;
  readonly canCut: boolean;
  readonly canChange: boolean;
  readonly protectedNode: boolean;
  readonly onClose: () => void;
  readonly onAction: (action: ContextAction) => void;
}

export function ContextMenu(props: MenuProps) {
  const translate = useTranslate();
  const ref = useRef<HTMLDivElement>(null);
  useMenuPosition(ref, props.position);
  const shortcut = (key: string): string => shortcutLabel(key, 'primary', currentDesktopPlatform());
  return (
    <Popup
      mode="popover"
      // Opening this menu selects the node, and the navigator scrolls to its row.
      // The menu sits at the pointer, not on anything that scrolled, so it stays.
      keepOnScroll
      onClose={props.onClose}
      ref={ref}
      role="menu"
      tabIndex={-1}
      label={translate('structure.menu.label')}
      className="ctx-menu"
      style={{ left: props.position.left, top: props.position.top, width: 220 }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' || event.key === 'Tab') {
          props.onClose();
        }
        navigateMenu(event);
      }}
    >
      {props.component && <ComponentMenuHeader {...props} />}
      {props.plainText ? <ConvertMenu {...props} /> : <WrapMenu {...props} />}
      <div className="ctx-divider" role="separator" />
      <MenuItem label={translate('structure.menu.cut')} disabled={!props.canCut} onSelect={() => props.onAction('cut')} />
      <MenuItem label={translate('structure.menu.copy')} shortcut={shortcut('C')} disabled={!props.canChange} onSelect={() => props.onAction('copy')} />
      <MenuItem label={translate('structure.menu.paste')} shortcut={shortcut('V')} disabled={!props.canPaste} onSelect={() => props.onAction('paste')} />
      <MenuItem
        label={translate('structure.menu.duplicate')}
        shortcut={shortcut('D')}
        disabled={!props.canChange}
        onSelect={() => props.onAction('duplicate')}
      />
      <MenuItem
        label={translate('structure.menu.delete')}
        shortcut={currentDesktopPlatform() === 'darwin' ? '⌫' : 'Del'}
        disabled={!props.canChange}
        onSelect={() => props.onAction('delete')}
      />
      {props.component && (
        <>
          <div className="ctx-divider" role="separator" />
          <MenuItem label={translate('structure.menu.setDefaults')} disabled={!props.canSetDefaults} onSelect={() => props.onAction('defaults')} />
        </>
      )}
    </Popup>
  );
}

function ComponentMenuHeader(props: Pick<MenuProps, 'canOpen' | 'onAction'>) {
  const translate = useTranslate();
  return (
    <>
      <MenuItem label={translate('structure.menu.openComponent')} disabled={!props.canOpen} onSelect={() => props.onAction('open')} />
      <div className="ctx-divider" role="separator" />
    </>
  );
}

function MenuItem({
  label,
  shortcut,
  disabled = false,
  title,
  onSelect,
}: {
  readonly label: string;
  readonly shortcut?: string;
  readonly disabled?: boolean;
  readonly title?: string;
  readonly onSelect?: () => void;
}) {
  return (
    <button type="button" role="menuitem" className="ctx-menu-item" disabled={disabled} aria-disabled={disabled} title={title} onClick={onSelect}>
      <span>{label}</span>
      {shortcut && <span className="ctx-shortcut">{shortcut}</span>}
    </button>
  );
}

function WrapMenu(props: MenuProps) {
  const translate = useTranslate();
  return (
    <Submenu label={translate('structure.menu.wrapIn')} disabled={!props.canWrapBox && !props.canWrapLink}>
      <MenuItem label="div" disabled={!props.canWrapBox} onSelect={() => props.onAction('div')} />
      <MenuItem label="<a>" disabled={!props.canWrapLink} onSelect={() => props.onAction('a')} />
    </Submenu>
  );
}

function ConvertMenu(props: MenuProps) {
  const translate = useTranslate();
  return (
    <Submenu label={translate('structure.menu.convertTo')} disabled={!props.canConvertDiv && !props.canConvertSpan}>
      <MenuItem label="div" disabled={!props.canConvertDiv} onSelect={() => props.onAction('convert-div')} />
      <MenuItem label="span" disabled={!props.canConvertSpan} onSelect={() => props.onAction('convert-span')} />
    </Submenu>
  );
}

function Submenu({ label, disabled, children }: { readonly label: string; readonly disabled: boolean; readonly children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const submenu = useRef<HTMLDivElement>(null);
  useSubmenuPosition(submenu, trigger, open ? 'open' : 'closed');
  return (
    <div className="ctx-wrap" onMouseEnter={() => setOpen(!disabled)} onMouseLeave={() => setOpen(false)}>
      <button
        ref={trigger}
        type="button"
        role="menuitem"
        className="ctx-menu-item"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight') {
            event.preventDefault();
            event.stopPropagation();
            setOpen(true);
            requestAnimationFrame(() => {
              submenu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
            });
          }
        }}
      >
        <span>{label}</span>
        <ChevronRightIcon size={12} />
      </button>
      {open && (
        <Popup
          mode="popover"
          portal={false}
          onClose={() => setOpen(false)}
          ref={submenu}
          role="menu"
          label={label}
          className="ctx-menu ctx-submenu"
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft' || event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              setOpen(false);
              trigger.current?.focus();
            }
          }}
        >
          {children}
        </Popup>
      )}
    </div>
  );
}

function useSubmenuPosition(submenu: React.RefObject<HTMLDivElement>, trigger: React.RefObject<HTMLButtonElement>, state: 'open' | 'closed'): void {
  useLayoutEffect(() => {
    if (state === 'closed' || !submenu.current || !trigger.current) {
      return;
    }
    const menu = submenu.current;
    const anchor = trigger.current.getBoundingClientRect();
    const bounds = menu.getBoundingClientRect();
    const right = anchor.right;
    const left = right + bounds.width <= window.innerWidth - 8 ? right : anchor.left - bounds.width;
    const top = Math.min(anchor.top, window.innerHeight - bounds.height - 8);
    menu.style.left = `${Math.max(8, left)}px`;
    menu.style.top = `${Math.max(8, top)}px`;
  }, [state, submenu, trigger]);
}

function navigateMenu(event: React.KeyboardEvent<HTMLDivElement>): void {
  event.stopPropagation();
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }
  const menu = target.closest('[role="menu"]');
  const items = Array.from(menu?.querySelectorAll<HTMLButtonElement>(':scope > button:not(:disabled), ' + ':scope > .ctx-wrap > button:not(:disabled)') ?? []);
  const index = items.findIndex((item) => item === target);
  let next: HTMLButtonElement | undefined;
  switch (event.key) {
    case 'ArrowDown':
      next = items[(index + 1) % items.length];
      break;
    case 'ArrowUp':
      next = items[index < 0 ? items.length - 1 : (index + items.length - 1) % items.length];
      break;
    case 'Home':
      next = items[0];
      break;
    case 'End':
      next = items[items.length - 1];
      break;
    default:
      return;
  }
  event.preventDefault();
  next?.focus();
}

function useMenuPosition(ref: React.RefObject<HTMLDivElement>, position: ContextPosition): void {
  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) {
      return;
    }
    const bounds = menu.getBoundingClientRect();
    const left = Math.min(position.left, window.innerWidth - bounds.width - 8);
    const top = Math.min(position.top, window.innerHeight - bounds.height - 8);
    menu.style.left = `${Math.max(8, left)}px`;
    menu.style.top = `${Math.max(8, top)}px`;
    // Pointer-opened menus receive keys without preselecting an action.
    menu.focus({ preventScroll: true });
  }, [ref, position]);
}
