// The recovery screen the main process can show when the app's own interface cannot: the window failed to load, its
// renderer process died, or it kept failing after every automatic reload (electron/app/windowHealth.ts).
//
// Why a page built here, and not the renderer's React screen: the failures this answers are the ones where the
// renderer bundle is the problem (missing, corrupt, crashing at start). The page is one string with its styles inline
// and no script, loaded as a data: URL, so it needs nothing the failed window needed. Its three buttons are links to
// `stacki-recovery:` addresses that main intercepts (windowRecovery.ts), so the page has no preload bridge to abuse.
// It follows the app's design language by hand (the panel colour, backgrounds instead of borders, a blue button that
// stays blue on hover) because it cannot load the app's stylesheet.
import { assert } from '../../shared/core/assert';
import { localeDirection } from '../../shared/core/i18n/locales';
import { parseLocale } from '../../shared/core/i18n/parseLocale';
import type { MainMessageKey } from '../lib/mainLocale';
import type { RecoveryCause, RecoveryReason } from './windowHealth';

export const RECOVERY_ACTIONS = ['reload', 'open-project', 'copy-details'] as const;
export type RecoveryAction = (typeof RECOVERY_ACTIONS)[number];

export const RECOVERY_SCHEME = 'stacki-recovery:';

export const RECOVERY_PAGE_LIMITS = {
  /** Characters of the details block shown on the page; the full log is what Copy details puts on the clipboard. */
  detailsCharsMax: 6_000,
} as const satisfies Record<string, number>;

type Translate = (key: MainMessageKey, params?: Readonly<Record<string, string | number>>) => string;

export interface RecoveryView {
  readonly lang: string;
  readonly reason: RecoveryReason;
  /** The crash log as text, newest first. */
  readonly details: string;
}

/** The action a recovery link names, or undefined for any other address. */
export function recoveryActionOf(url: string): RecoveryAction | undefined {
  if (!URL.canParse(url)) {
    return undefined;
  }
  const address = new URL(url);
  if (address.protocol !== RECOVERY_SCHEME) {
    return undefined;
  }
  // The action is the host of `stacki-recovery://reload`; anything after it (a path, a query) is not one of ours.
  if (address.pathname !== '' && address.pathname !== '/') {
    return undefined;
  }
  return RECOVERY_ACTIONS.find((action) => action === address.hostname);
}

/** The sentence that says what happened, specific to the cause. */
export function describeRecoveryReason(reason: RecoveryReason, translate: Translate): string {
  if (reason.kind === 'loop-guard') {
    return `${describeCause(reason.cause, translate)} ${translate('recovery.reason.loopGuard', { count: reason.reloads })}`;
  }
  return describeCause(reason, translate);
}

function describeCause(cause: RecoveryCause, translate: Translate): string {
  switch (cause.kind) {
    case 'load-failed':
      return translate('recovery.reason.loadFailed', { description: cause.description, code: cause.code });
    case 'renderer-gone':
      return translate('recovery.reason.rendererGone', { reason: cause.reason });
    default: {
      const exhaustive: never = cause;
      return exhaustive;
    }
  }
}

/** The page, as one HTML string. */
export function renderRecoveryPage(view: RecoveryView, translate: Translate): string {
  assert(view.lang.length > 0, 'The recovery page declares its language');
  assert(RECOVERY_PAGE_LIMITS.detailsCharsMax > 0, 'The recovery page has room for details');
  const details = view.details.slice(0, RECOVERY_PAGE_LIMITS.detailsCharsMax);
  const action = (name: RecoveryAction): string => `${RECOVERY_SCHEME}//${name}`;
  // Arabic and Hebrew read right to left; a tag that is not a shipped locale (it cannot be today) reads left to right.
  const parsed = parseLocale(view.lang);
  const direction = parsed.ok ? localeDirection(parsed.value) : 'ltr';
  return `<!doctype html>
<html lang="${escapeHtml(view.lang)}" dir="${direction}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${escapeHtml(translate('recovery.screen.title'))}</title>
<style>
  html, body { margin: 0; height: 100%; background: #111111; color: #f5f5f5; font: 14px/1.5 -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', system-ui, sans-serif; }
  body { display: flex; align-items: center; justify-content: center; padding: 24px; box-sizing: border-box; -webkit-app-region: drag; }
  main { max-width: 640px; width: 100%; -webkit-app-region: no-drag; }
  h1 { margin: 0 0 8px; font-size: 20px; font-weight: 600; }
  p { margin: 0 0 8px; color: #b8b8b8; }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 20px 0; }
  a.button { display: inline-block; padding: 8px 14px; border-radius: 8px; background: rgba(255, 255, 255, 0.06); color: #f5f5f5; text-decoration: none; font-weight: 500; }
  a.button:hover { background: rgba(255, 255, 255, 0.12); }
  a.button:active { background: rgba(255, 255, 255, 0.18); }
  a.primary { background: #0099ff; color: #ffffff; }
  a.primary:hover { background: #26a7ff; }
  a.primary:active { background: #0080d6; }
  pre { margin: 0; padding: 12px; max-height: 240px; overflow: auto; border-radius: 8px; background: rgba(255, 255, 255, 0.06); color: #b8b8b8; font: 12px/1.5 'SF Mono', 'Cascadia Code', Consolas, monospace; white-space: pre-wrap; word-break: break-word; direction: ltr; text-align: start; }
  h2 { margin: 20px 0 8px; font-size: 12px; font-weight: 600; color: #989898; }
</style>
</head>
<body>
<main role="alert">
  <h1>${escapeHtml(translate('recovery.screen.title'))}</h1>
  <p>${escapeHtml(describeRecoveryReason(view.reason, translate))}</p>
  <p>${escapeHtml(translate('recovery.screen.filesSafe'))}</p>
  <div class="actions">
    <a class="button primary" href="${action('reload')}">${escapeHtml(translate('recovery.screen.reload'))}</a>
    <a class="button" href="${action('open-project')}">${escapeHtml(translate('recovery.screen.openProject'))}</a>
    <a class="button" href="${action('copy-details')}">${escapeHtml(translate('recovery.screen.copyDetails'))}</a>
  </div>
${details === '' ? '' : `  <pre>${escapeHtml(details)}</pre>\n`}</main>
</body>
</html>
`;
}

/** The address that loads `html` as a page. */
export function recoveryPageUrl(html: string): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
