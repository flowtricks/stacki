// The editor's theme as apps hear it: `stacki.ui.theme()` answers it and
// `theme.change` carries each change (docs/apps.md, "Look and feel"). The theme
// is the editor root's `data-theme`, read through the kit's own parser, so it is
// always one the UI kit has tokens for (shared/properties/appUiKit.ts); with no
// attribute it is the default, dark, the one theme the editor draws today.
import { assert } from '../../../shared/core/assert';
import { appThemeView, parseAppUiTheme, type AppThemeView } from '../../../shared/properties/appUiKit';

/** What `ui.theme` answers now. */
export function currentAppTheme(): AppThemeView {
  const root = typeof document === 'undefined' ? undefined : document.documentElement;
  const view = appThemeView(parseAppUiTheme(root?.dataset['theme']));
  assert(view.theme.length > 0, 'A theme has a name');
  return view;
}

/**
 * Hears the theme change: `check` reads it and calls `listener` once per change,
 * never for a read that matches the last one. Pure of the DOM, so the decision is
 * testable without a document.
 */
export function createThemeFollower(read: () => AppThemeView, listener: (view: AppThemeView) => void): { readonly check: () => void } {
  let last = read().theme;
  assert(last.length > 0, 'The first theme has a name');
  return {
    check: () => {
      const view = read();
      assert(view.theme.length > 0, 'A theme has a name');
      if (view.theme === last) {
        return;
      }
      last = view.theme;
      listener(view);
    },
  };
}

/** Watches the editor root's `data-theme` and calls `listener` with each new theme; returns the stop. */
export function watchAppTheme(listener: (view: AppThemeView) => void): () => void {
  if (typeof document === 'undefined' || typeof MutationObserver !== 'function') {
    return () => undefined;
  }
  const follower = createThemeFollower(currentAppTheme, listener);
  const observer = new MutationObserver(() => follower.check());
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => observer.disconnect();
}
