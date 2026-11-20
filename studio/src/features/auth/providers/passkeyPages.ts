// Goal: the two pages of the passkey ceremonies, rendered by the Worker in the visitor's language: sign in, and create a
// passkey from an invite. Each page is static HTML plus one fixed inline script (the same bytes for everyone), allowed by
// its SHA-256 in the Content-Security-Policy, so no injected text can ever run: all text and values reach the script through
// data attributes, never through the script source.
import { stackiFavicon, stackiMarkPath } from '../../../shared/stackiBrand';
import { translatorForLanguages } from '../../../shared/requestTranslate';
import { encodeBase64url, sha256, utf8Bytes } from './base64url';

// The browser half of the ceremonies. It only moves bytes between the page, the authenticator and Studio's routes; every
// decision (challenge, origin, signature, counter) is made by the Worker.
const SCRIPT = `
(function () {
  var root = document.getElementById('passkey');
  var data = root.dataset;
  var statusLine = document.getElementById('passkey-status');
  var button = document.getElementById('passkey-button');
  function fromB64(text) { var s = text.replace(/-/g, '+').replace(/_/g, '/'); var b = atob(s); var out = new Uint8Array(b.length); for (var i = 0; i < b.length; i++) out[i] = b.charCodeAt(i); return out; }
  function toB64(buffer) { var bytes = new Uint8Array(buffer); var s = ''; for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, ''); }
  function say(text) { statusLine.textContent = text; }
  function post(path, body) {
    return fetch('/studio/auth/provider/passkey/' + path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (response) { if (!response.ok) throw new Error('status'); return response.json(); });
  }
  if (!window.PublicKeyCredential) { say(data.unsupported); if (button) button.disabled = true; return; }
  var pending = null;
  function signIn(mediation) {
    if (pending) pending.abort();
    var controller = new AbortController(); pending = controller;
    return post('options', {}).then(function (options) {
      var request = { publicKey: { challenge: fromB64(options.challenge), rpId: options.rpId, userVerification: 'preferred', timeout: options.timeout }, signal: controller.signal };
      if (mediation) request.mediation = mediation;
      return navigator.credentials.get(request);
    }).then(function (credential) {
      if (!credential) throw new Error('none');
      var r = credential.response;
      var assertion = { id: credential.id, clientDataJSON: toB64(r.clientDataJSON), authenticatorData: toB64(r.authenticatorData), signature: toB64(r.signature), userHandle: r.userHandle ? toB64(r.userHandle) : undefined };
      var encoded = toB64(new TextEncoder().encode(JSON.stringify(assertion)));
      location.assign(data.callback + '?state=' + encodeURIComponent(data.state) + '&assertion=' + encoded);
    });
  }
  function enrol() {
    var label = (document.getElementById('passkey-label') || {}).value || '';
    return post('register-options', { invite: data.invite, label: label }).then(function (options) {
      return navigator.credentials.create({ publicKey: {
        challenge: fromB64(options.challenge), rp: options.rp, user: { id: fromB64(options.user.id), name: options.user.name, displayName: options.user.displayName },
        pubKeyCredParams: options.pubKeyCredParams, timeout: options.timeout, attestation: 'none',
        authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'preferred' },
        excludeCredentials: options.excludeCredentials.map(function (id) { return { type: 'public-key', id: fromB64(id) }; })
      } });
    }).then(function (credential) {
      var r = credential.response;
      return post('register', { invite: data.invite, id: credential.id, clientDataJSON: toB64(r.clientDataJSON), attestationObject: toB64(r.attestationObject), label: label });
    }).then(function () { say(data.done); button.hidden = true; document.getElementById('passkey-continue').hidden = false; });
  }
  function fail() { say(data.mode === 'enrol' ? data.enrolFailed : data.failed); button.disabled = false; }
  button.addEventListener('click', function () {
    button.disabled = true; say('');
    (data.mode === 'enrol' ? enrol() : signIn()).catch(fail);
  });
  if (data.mode === 'signin' && PublicKeyCredential.isConditionalMediationAvailable) {
    PublicKeyCredential.isConditionalMediationAvailable().then(function (available) {
      if (available) { signIn('conditional').catch(function () {}); }
    });
  }
})();
`;

let scriptHash: Promise<string> | undefined;
function scriptSourceHash(): Promise<string> {
  scriptHash ??= sha256(utf8Bytes(SCRIPT)).then((digest) => `'sha256-${btoa(String.fromCharCode(...digest))}'`);
  return scriptHash;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export type PasskeyPage =
  | { readonly mode: 'signin'; readonly state: string; readonly callbackPath: string }
  | {
      readonly mode: 'enrol';
      readonly state: string;
      readonly callbackPath: string;
      readonly invite: string;
      readonly handle: string;
      readonly displayName: string | undefined;
    }
  | { readonly mode: 'invalid' };

export async function passkeyPage(page: PasskeyPage, languages: string | null): Promise<Response> {
  const { locale, translate } = translatorForLanguages(languages);
  const attributes = (values: Record<string, string>) =>
    Object.entries(values)
      .map(([name, value]) => `data-${name}="${escapeHtml(value)}"`)
      .join(' ');
  const common = {
    unsupported: translate('studio.passkey.signIn.unsupported'),
    failed: translate('studio.passkey.signIn.failed'),
    'enrol-failed': translate('studio.passkey.enrol.failed'),
    done: translate('studio.passkey.enrol.done'),
  };
  let heading: string;
  let message: string;
  let buttonText = '';
  let extra = '';
  let data: Record<string, string> = { ...common, mode: page.mode };
  if (page.mode === 'signin') {
    heading = translate('studio.login.welcomeHeading');
    message = translate('studio.passkey.signIn.prompt');
    buttonText = translate('studio.passkey.signIn.button');
    data = { ...data, state: page.state, callback: page.callbackPath };
    extra = '<input type="text" autocomplete="username webauthn" tabindex="-1" aria-hidden="true" style="position:absolute;opacity:0;width:1px;height:1px">';
  } else if (page.mode === 'enrol') {
    heading = translate('studio.passkey.enrol.heading');
    message = `${escapeHtml(page.displayName ?? page.handle)}: ${translate('studio.passkey.enrol.prompt')}`;
    buttonText = translate('studio.passkey.enrol.button');
    data = { ...data, invite: page.invite };
    extra = `<a id="passkey-continue" hidden href="/studio/auth/login">${escapeHtml(translate('studio.passkey.enrol.continue'))}</a>`;
  } else {
    heading = translate('studio.login.failedHeading');
    message = translate('studio.passkey.enrol.invalid');
  }
  const control =
    page.mode === 'invalid' ? '' : `<button id="passkey-button" type="button">${escapeHtml(buttonText)}</button>${extra}<script>${SCRIPT}</script>`;
  const body = `<!doctype html>
<html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(translate('studio.login.title'))}</title>
<link rel="icon" type="image/svg+xml" href="${stackiFavicon}">
<style>body{background:#111;color:#eee;font:14px system-ui;display:grid;place-items:center;min-height:100dvh;margin:0}main{text-align:center;max-width:32rem;padding:24px}.studio-logo{display:block;margin:0 auto 24px}p{color:#999;line-height:1.6}button,a{display:inline-flex;align-items:center;justify-content:center;background:#eee;color:#111;border:0;border-radius:8px;padding:12px 20px;margin:20px 0;font:inherit;cursor:pointer;text-decoration:none}button:disabled{opacity:.6;cursor:default}</style></head>
<body><main id="passkey" ${attributes(data)}>
<svg class="studio-logo" width="48" height="48" viewBox="0 0 458 458" role="img" aria-label="Stacki"><path d="${stackiMarkPath}" fill="currentColor"/></svg>
<h1>${escapeHtml(heading)}</h1><p>${page.mode === 'enrol' ? message : escapeHtml(message)}</p>
${page.mode === 'enrol' ? `<p><input id="passkey-label" maxlength="60" style="padding:8px;border-radius:6px;border:0" aria-label="${escapeHtml(translate('studio.passkey.enrol.button'))}"></p>` : ''}
${control}<p id="passkey-status" role="status"></p></main></body></html>`;
  return new Response(body, {
    status: page.mode === 'invalid' ? 400 : 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': `default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src ${await scriptSourceHash()}; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
    },
  });
}

export { encodeBase64url };
