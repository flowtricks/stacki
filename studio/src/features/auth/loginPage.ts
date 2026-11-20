import { githubIconPath } from '../../../vendor/stacki/src/ui/iconPaths';
import { stackiFavicon, stackiMarkPath } from '../../shared/stackiBrand';
import { signInMessageKeys, signInNeutralMessageKeys, type SignInProblem } from './signInFailure';
import { translatorForLanguages } from '../../shared/requestTranslate';
import { loginCountdown } from './loginCountdown';

// `provider` is the display name of an installed custom provider: with it the page speaks neutrally (no GitHub name or
// mark) and the button reads "Continue with <provider>". Without it the page is the GitHub sign-in page, unchanged.
export function loginPage(problem?: SignInProblem, status = 200, reference = '', seconds = 0, languages?: string | null, provider?: string): Response {
  // The page is rendered here, before the editor exists, so it speaks the language of the visitor's browser (Accept-Language).
  const { locale, translate } = translatorForLanguages(languages);
  const messageKeys = provider === undefined ? signInMessageKeys : signInNeutralMessageKeys;
  const message = escapeHtml(translate(problem ? messageKeys[problem] : 'studio.login.prompt'));
  const countdown = loginCountdown(
    seconds,
    {
      one: translate('studio.login.waitOne'),
      many: translate('studio.login.waitMany', { seconds: '{seconds}' }),
      ready: translate('studio.login.ready'),
    },
    escapeHtml,
  );
  const detail = reference
    ? `<p>${escapeHtml(translate('studio.login.reference', { reference: reference.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80) }))}</p>`
    : '';
  const buttonLabel = provider === undefined ? translate('studio.login.button') : translate('studio.login.buttonProvider', { provider });
  const providerMark =
    provider === undefined
      ? `
  <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="${githubIconPath}" fill="currentColor" />
  </svg>`
      : '';
  return new Response(
    `<!doctype html>
<html lang="${locale}">
<head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(translate('studio.login.title'))}</title>
<link rel="icon" type="image/svg+xml" href="${stackiFavicon}">
<style>
body{background:#111;color:#eee;font:14px system-ui;display:grid;place-items:center;
  min-height:100dvh;margin:0}
main{text-align:center;max-width:32rem;padding:24px}
.studio-logo{display:block;margin:0 auto 24px}
a{display:inline-flex;align-items:center;justify-content:center;gap:10px;background:#eee;
  color:#111;border-radius:8px;padding:12px 20px;text-decoration:none;margin:20px 0}
a svg{flex-shrink:0}
p{color:#999;line-height:1.6}
</style>
</head>
<body><main>
<svg class="studio-logo" width="48" height="48" viewBox="0 0 458 458"
  role="img" aria-label="Stacki">
  <path d="${stackiMarkPath}" fill="currentColor" />
</svg>
<h1>${escapeHtml(translate(problem ? 'studio.login.failedHeading' : 'studio.login.welcomeHeading'))}</h1>
<p id="login-message">${message}${countdown.markup}</p>
<a href="/studio/auth/login">${providerMark}
  <span>${escapeHtml(buttonLabel)}</span>
</a>${detail}
</main>${countdown.script}</body></html>`,
    {
      status,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'; frame-ancestors 'none'" + countdown.policy,
      },
    },
  );
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
