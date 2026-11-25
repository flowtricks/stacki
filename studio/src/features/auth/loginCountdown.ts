import { assert } from '../../../vendor/stacki/shared/core/assert';

/**
 * The countdown's words in the visitor's language, chosen by the Worker. `waiting` holds a literal `{time}` the script
 * fills in each tick ("Try again in 4:55"); `button` is the label the button returns to; `ready` replaces the message.
 */
export interface LoginCountdownText {
  readonly waiting: string;
  readonly button: string;
  readonly ready: string;
}

/** The sign-in button while a wait runs: its label, the attributes that disable it, and the script that re-enables it. */
export interface LoginCountdown {
  readonly label: string;
  readonly attributes: string;
  readonly script: string;
  readonly policy: string;
}

// Why on the button and not in a sentence: the wait is the button's state. A disabled "Try again in 4:55" says what to
// do and when, re-enables itself at zero, and keeps the page to its one message. Clicking early cannot start a sign-in
// anyway: the Worker answers /studio/auth/login with this page until the signed wait cookie expires.
export function loginCountdown(seconds: number, text: LoginCountdownText, escape: (value: string) => string): LoginCountdown {
  assert(Number.isSafeInteger(seconds), 'Sign-in wait must be a safe integer');
  assert(seconds >= 0, 'Sign-in wait cannot be negative');
  assert(Number.isSafeInteger(Date.now() + seconds * 1000), 'Sign-in deadline must be safe');
  assert(text.waiting.includes('{time}'), 'The waiting label must place the time');
  if (seconds === 0) {
    return { label: escape(text.button), attributes: '', script: '', policy: '' };
  }
  const nonce = crypto.randomUUID();
  return {
    label: escape(text.waiting.replace('{time}', formatLoginWait(seconds))),
    attributes: ' aria-disabled="true" tabindex="-1"',
    // The text is JSON inside a script element: `<` is escaped so a message can never close the element.
    script:
      `<script nonce="${nonce}">` +
      `(${startLoginCountdown.toString()})(${seconds}, window, ${JSON.stringify(text).replace(/</g, '\\u003c')}, ${formatLoginWait.toString()});</script>`,
    policy: `; script-src 'nonce-${nonce}'`,
  };
}

/** Minutes and seconds, the way a timer reads: 295 → "4:55", 9 → "0:09". The wait is capped at an hour upstream. */
// This function is serialized into the login page, so it must not close over server code.
export function formatLoginWait(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  return `${minutes}:${rest < 10 ? '0' : ''}${rest}`;
}

// This function is serialized into the login page, so it must not close over server code.
function startLoginCountdown(seconds: number, browser: LoginCountdownBrowser, text: LoginCountdownText, format: (seconds: number) => string): void {
  const button = browser.document.getElementById('login-button');
  const label = browser.document.getElementById('login-button-label');
  const message = browser.document.getElementById('login-message');
  if (!button) {
    throw new Error('Missing sign-in button');
  }
  if (!label) {
    throw new Error('Missing sign-in button label');
  }
  if (!message) {
    throw new Error('Missing sign-in message');
  }
  const deadline = Date.now() + seconds * 1000;
  // Recalculate elapsed time so throttled background tabs catch up instead of drifting. One timer per page, and it
  // only changes text: it never navigates, so a wait can never start a sign-in by itself.
  const timer = browser.setInterval(() => {
    const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    if (remaining > 0) {
      label.textContent = text.waiting.replace('{time}', format(remaining));
    } else {
      browser.clearInterval(timer);
      button.removeAttribute('aria-disabled');
      button.removeAttribute('tabindex');
      label.textContent = text.button;
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
  removeAttribute(name: string): void;
}
