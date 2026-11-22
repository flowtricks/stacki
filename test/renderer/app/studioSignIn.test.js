// Goal: Add Studio asks how people sign in before installing, with the same five choices and
// non-secret fields as `npm create stacki`, and an installed Studio can change it later.
// Method: mount the real Studio setup UI against a fake preload bridge. The dialog is driven like
// a person would: radios, typing, copy buttons. What reaches `installStudio` and `setStudioAuth`
// is inspected, because the contract is that a secret has no way into the payload.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');
const output = repoPath('node_modules/.stacki-test/studio-sign-in.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
buildSync({
  entryPoints: [repoPath('src/features/studioSetup/StudioSetup.tsx')],
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  loader: { '.css': 'empty' },
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  logLevel: 'silent',
});
const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
require('../../helpers/popupDom').installPopupDOM(dom.window);
global.window = dom.window;
for (const name of ['document', 'navigator', 'HTMLElement', 'Element', 'Node', 'HTMLInputElement', 'Event']) {
  global[name] = dom.window[name];
}
window.HTMLDialogElement.prototype.showModal = function () {
  this.open = true;
};
global.IS_REACT_ACT_ENVIRONMENT = true;
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const StudioSetup = require(output).default;

const click = (element) => act(async () => element.click());
const button = (label) => [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === label);
const radios = () => [...document.querySelectorAll('[role="radiogroup"] input[type="radio"]')];
const labelOf = (radio) => radio.closest('label').querySelector('strong').textContent;
const textField = (label) =>
  [...document.querySelectorAll('.studio-auth-field')].find((row) => row.querySelector('label span').textContent === label).querySelector('input');
const missing = { kind: 'missing', desktopVersion: '0.1.48' };
const AUD = 'a'.repeat(40);

function type(input, value) {
  return act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

async function fixture(status = missing) {
  const installs = [];
  const changes = [];
  const copied = [];
  Object.defineProperty(globalThis.navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => copied.push(text) } });
  window.avb = {
    studioStatus: async () => status,
    onStudioProgress: () => () => {},
    openExternal: async () => ({ ok: true }),
    installStudio: async (options) => {
      installs.push(options);
      return { kind: 'installed', version: '0.1.48' };
    },
    setStudioAuth: async (options) => {
      changes.push(options);
      return { kind: 'saved', signIn: options.auth.kind };
    },
  };
  const root = createRoot(document.getElementById('root'));
  await act(async () => {
    root.render(React.createElement(StudioSetup, { projectPath: '/project', previewURL: 'http://localhost:4327/' }));
  });
  return { installs, changes, copied, close: () => act(async () => root.unmount()) };
}

test('Add to project asks how people sign in first: five choices in order, GitHub preselected', async () => {
  const state = await fixture();
  try {
    await click(button('Add to project'));
    assert.equal(state.installs.length, 0, 'nothing is installed before the question is answered');
    assert.deepEqual(radios().map(labelOf), ['GitHub', 'Cloudflare Access', 'Google', 'SSO (OpenID Connect)', 'Passkeys']);
    assert.deepEqual(
      radios().map((radio) => radio.checked),
      [true, false, false, false, false],
    );
    assert.match(document.querySelector('dialog').textContent, /Put Studio behind Cloudflare Zero Trust Access/);
    assert.equal(document.querySelectorAll('.studio-auth-field').length, 0, 'GitHub needs no fields');
    assert.equal(document.querySelector('.studio-auth-warning') ?? undefined, undefined, 'the switch warning is for changes only');
    await click(button('Add Studio'));
    assert.equal(state.installs.length, 1);
    assert.deepEqual(state.installs[0].auth, { kind: 'github' });
  } finally {
    await state.close();
  }
});

test('each choice shows its own fields and validates them before installing', async () => {
  const state = await fixture();
  try {
    await click(button('Add to project'));
    await click(radios()[2]);
    assert.equal(document.querySelectorAll('.studio-auth-field').length, 4);
    await click(button('Add Studio'));
    assert.equal(state.installs.length, 0, 'an invalid form installs nothing');
    assert.match(document.querySelector('.studio-auth-fields').textContent, /Required\./);
    assert.match(document.querySelector('.studio-auth-notes').textContent, /wrangler secret put GOOGLE_CLIENT_SECRET/);
    assert.ok(document.querySelector('.studio-auth-notes .code-token'), 'shell commands are highlighted');
    assert.match(document.querySelector('.studio-auth-notes').textContent, /\/studio\/auth\/google\/callback/);
    await type(textField('Client ID'), 'abc.apps.googleusercontent.com');
    await type(textField('Allowed email domains (optional)'), 'Example.com');
    await type(textField('First administrator email'), 'me@example.com');
    await click(button('Add Studio'));
    assert.deepEqual(state.installs[0].auth, {
      kind: 'google',
      clientId: 'abc.apps.googleusercontent.com',
      allowedDomains: ['example.com'],
      allowedEmails: [],
      admin: 'google:me@example.com',
    });
    assert.doesNotMatch(JSON.stringify(state.installs[0]), /secret/i, 'no secret has a place in the payload');
  } finally {
    await state.close();
  }
});

test('SSO validates the issuer; Passkeys ask only for a handle; Access needs a confirmed custom domain', async () => {
  const state = await fixture();
  try {
    await click(button('Add to project'));
    await click(radios()[3]);
    await type(textField('Issuer URL'), 'http://insecure.example.com');
    await type(textField('Client ID'), 'studio');
    await type(textField('First administrator email'), 'me@corp.com');
    await click(button('Add Studio'));
    assert.equal(state.installs.length, 0);
    assert.match(document.querySelector('.studio-auth-fields').textContent, /Not valid\./);
    await click(radios()[4]);
    assert.equal(document.querySelectorAll('.studio-auth-field').length, 1);
    assert.match(document.querySelector('.studio-auth-notes').textContent, /\/studio\/auth\/passkey\/bootstrap/);
    assert.match(document.querySelector('.studio-auth-notes').textContent, /wrangler secret put AUTH_SETUP_CODE/);
    assert.ok(button('Copy commands'), 'Passkeys have the setup code command to copy');
    await click(radios()[1]);
    await type(textField('Access team domain'), 'access.corp.com');
    await type(textField('Application AUD tag'), AUD);
    await type(textField('First administrator email'), 'boss@corp.com');
    await click(button('Add Studio'));
    assert.equal(state.installs.length, 0);
    assert.match(document.querySelector('.studio-auth-fields').textContent, /Not a cloudflareaccess\.com domain/);
    await click(document.querySelector('.studio-auth-confirm input'));
    await click(button('Add Studio'));
    assert.deepEqual(state.installs[0].auth, {
      kind: 'access',
      teamDomain: 'access.corp.com',
      aud: AUD,
      admin: 'access:boss@corp.com',
      teamDomainCustom: 'confirmed',
    });
  } finally {
    await state.close();
  }
});

test('the secret commands and redirect URI have Copy buttons', async () => {
  const state = await fixture();
  try {
    await click(button('Add to project'));
    await click(radios()[3]);
    await click(button('Copy commands'));
    await click(button('Copy URI'));
    assert.deepEqual(state.copied, [
      'cd studio\nnpx wrangler secret put OIDC_CLIENT_SECRET --config cloudflare/wrangler.jsonc',
      'https://<your-site>/studio/auth/oidc/callback',
    ]);
  } finally {
    await state.close();
  }
});

test('an installed Studio shows its sign-in type and Change edits only that, with a warning', async () => {
  const state = await fixture({ ...missing, kind: 'installed', version: '0.1.48', signIn: 'passkey' });
  try {
    const signInName = () => document.querySelector('.studio-auth-current-name').textContent;
    assert.equal(signInName(), 'Passkeys');
    await click(button('Change'));
    assert.match(document.querySelector('dialog').textContent, /new credentials or invites/);
    assert.equal(radios().find((radio) => radio.checked) && labelOf(radios().find((radio) => radio.checked)), 'Passkeys');
    await click(radios()[0]);
    await click(button('Save sign-in type'));
    assert.deepEqual(state.changes, [{ projectPath: '/project', auth: { kind: 'github' } }]);
    assert.equal(state.installs.length, 0);
    assert.equal(signInName(), 'GitHub');
    assert.match(document.body.textContent, /Deploy Studio to apply it/);
  } finally {
    await state.close();
  }
});

test.after(() => dom.window.close());
