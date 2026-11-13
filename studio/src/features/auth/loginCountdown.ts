import { assert } from '../../../vendor/stacki/shared/core/assert';

/** The countdown's sentences in the visitor's language, chosen by the Worker: `many` holds a literal `{seconds}` the script fills in each tick. */
export interface LoginCountdownText {
  readonly one: string;
  readonly many: string;
  readonly ready: string;
}

export function loginCountdown(seconds: number, text: LoginCountdownText, escape: (value: string) => string) {
  assert(Number.isSafeInteger(seconds), 'Sign-in wait must be a safe integer');
  assert(seconds >= 0, 'Sign-in wait cannot be negative');
  assert(Number.isSafeInteger(Date.now() + seconds * 1000), 'Sign-in deadline must be safe');
  if (seconds === 0) {
    return { markup: '', script: '', policy: '' } as const;
  }
  const nonce = crypto.randomUUID();
  return {
    markup: ` <span id="login-countdown">${escape(seconds === 1 ? text.one : text.many.replace('{seconds}', String(seconds)))}</span>`,
    // The text is JSON inside a script element: `<` is escaped so a message can never close the element.
    script: `<script nonce="${nonce}">` + `(${startLoginCountdown.toString()})(${seconds}, window, ${JSON.stringify(text).replace(/</g, '\\u003c')});</script>`,
    policy: `; script-src 'nonce-${nonce}'`,
  } as const;
}

// This function is serialized into the login page, so it must not close over server code.
function startLoginCountdown(seconds: number, browser: LoginCountdownBrowser, text: LoginCountdownText): void {
  const countdown = browser.document.getElementById('login-countdown');
  const message = browser.document.getElementById('login-message');
  if (!countdown) {
    throw new Error('Missing sign-in countdown');
  }
  if (!message) {
    throw new Error('Missing sign-in message');
  }
  const deadline = Date.now() + seconds * 1000;
  // Recalculate elapsed time so throttled background tabs catch up instead of drifting.
  const timer = browser.setInterval(() => {
    const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    if (remaining > 0) {
      countdown.textContent = remaining === 1 ? text.one : text.many.replace('{seconds}', String(remaining));
    } else {
      browser.clearInterval(timer);
      message.setAttribute('role', 'status');
      message.textContent = text.ready;
    }
  }, 1000);
}

// The Worker renders this script but has no DOM library; only these browser methods are needed.
interface LoginCountdownBrowser {
  readonly document: {
    getElementById(id: string): LoginCountdownElement | null;
  };
  setInterval(callback: () => void, intervalMs: number): number;
  clearInterval(timer: number): void;
}

interface LoginCountdownElement {
  textContent: string | null;
  setAttribute(name: string, value: string): void;
}
