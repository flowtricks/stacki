// Goal: a sign-in wait is the button's state. The button reads "Try again in 4:55", is disabled, counts down without
// reloading or retrying OAuth, re-enables itself at zero, and the page keeps a single message.
// Method: execute the rendered inline script with a controlled clock and minimal browser globals; count timers and
// navigations so a wait can never start a sign-in on its own.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { loginPage } from '../src/features/auth/githubLogin';
import { formatLoginWait } from '../src/features/auth/loginCountdown';

interface FakeElement {
  textContent: string;
  readonly attributes: Map<string, string>;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

function element(): FakeElement {
  const attributes = new Map<string, string>();
  return {
    textContent: '',
    attributes,
    setAttribute: (name, value) => {
      attributes.set(name, value);
    },
    removeAttribute: (name) => {
      attributes.delete(name);
    },
  };
}

test('the wait is a disabled button that counts down, catches up after suspension, and re-enables at zero', async () => {
  const response = loginPage('rate-limit', 429, '', 295);
  const html = await response.text();
  const script = /<script nonce="([^"]+)">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(script?.[1]);
  assert.ok(script[2]);
  assert.ok(response.headers.get('Content-Security-Policy')?.endsWith(`'nonce-${script[1]}'`));
  assert.match(html, /<a id="login-button" href="\/studio\/auth\/login" aria-disabled="true" tabindex="-1">/);
  assert.match(html, /<span id="login-button-label">Try again in 4:55<\/span>/);
  // One message only: no seconds sentence, no second paragraph about the wait.
  const visible = html.replace(/<script[\s\S]*<\/script>/, '');
  assert.doesNotMatch(visible, /Wait at least|seconds|295/);
  assert.equal(visible.match(/<p\b/g)?.length, 1);
  let now = 1_000_000;
  let tick: (() => void) | undefined;
  let timers = 0;
  let stopped = false;
  const button = element();
  button.setAttribute('aria-disabled', 'true');
  button.setAttribute('tabindex', '-1');
  const label = element();
  const message = element();
  const elements: Record<string, FakeElement> = { 'login-button': button, 'login-button-label': label, 'login-message': message };
  runInNewContext(script[2], {
    Date: { now: () => now },
    window: {
      document: { getElementById: (id: string) => elements[id] ?? null },
      setInterval: (callback: () => void, interval: number) => {
        assert.equal(interval, 1000);
        timers++;
        tick = callback;
        return 1;
      },
      clearInterval: (timer: number) => {
        assert.equal(timer, 1);
        stopped = true;
      },
    },
  });
  assert.equal(timers, 1, 'one countdown per page');
  assert.ok(tick);
  now += 1000;
  tick();
  assert.equal(label.textContent, 'Try again in 4:54');
  assert.equal(button.attributes.get('aria-disabled'), 'true');
  // A background tab that slept for four minutes catches up instead of drifting.
  now += 240_000;
  tick();
  assert.equal(label.textContent, 'Try again in 0:54');
  now += 53_000;
  tick();
  assert.equal(label.textContent, 'Try again in 0:01');
  assert.equal(stopped, false);
  now += 2000;
  tick();
  assert.equal(stopped, true);
  assert.equal(label.textContent, 'Sign in with GitHub');
  assert.equal(button.attributes.has('aria-disabled'), false);
  assert.equal(button.attributes.has('tabindex'), false);
  assert.equal(message.attributes.get('role'), 'status');
  assert.equal(message.textContent, 'You can try signing in again below.');
});

test('the countdown speaks the visitor language and a custom provider keeps its own button label', async () => {
  const german = await loginPage('rate-limit', 429, '', 61, 'de').text();
  assert.match(german, /Erneut versuchen in 1:01/);
  assert.match(german, /"button":"Mit GitHub anmelden"/);
  const custom = await loginPage('rate-limit', 429, '', 5, 'en', 'Okta').text();
  assert.match(custom, /Try again in 0:05/);
  assert.match(custom, /"button":"Continue with Okta"/);
});

test('timer text reads like a clock', () => {
  assert.equal(formatLoginWait(1), '0:01');
  assert.equal(formatLoginWait(59), '0:59');
  assert.equal(formatLoginWait(60), '1:00');
  assert.equal(formatLoginWait(295), '4:55');
  assert.equal(formatLoginWait(3600), '60:00');
});

test('pages without a wait keep an enabled button and do not permit or emit scripts', async () => {
  for (const response of [loginPage(), loginPage('expired', 403), loginPage('rate-limit', 429)]) {
    const html = await response.text();
    assert.doesNotMatch(html, /<script/);
    assert.doesNotMatch(html, /<a [^>]*aria-disabled/);
    assert.match(html, /<span id="login-button-label">Sign in with GitHub<\/span>/);
    assert.doesNotMatch(response.headers.get('Content-Security-Policy') ?? '', /script-src/);
  }
});

test('invalid waits cannot be embedded into a login page', () => {
  for (const seconds of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => loginPage('rate-limit', 429, '', seconds), /Assertion failed/);
  }
});
