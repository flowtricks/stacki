import { useEffect } from 'react';

export function useComponentBack(enabled: boolean, back: () => void) {
  useEffect(() => {
    if (!enabled) {
      return;
    }
    const key = (event: KeyboardEvent) => {
      if (
        event.key !== 'Escape' ||
        event.defaultPrevented ||
        event.isComposing ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey ||
        (event.target instanceof Element && event.target.closest('.page-menu, [role="dialog"], [role="menu"], [role="listbox"], select')) ||
        document.querySelector('[role="dialog"], dialog[open], [role="listbox"], [role="menu"], .account-menu[open]')
      ) {
        return;
      }
      event.preventDefault();
      back();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [enabled, back]);
}
