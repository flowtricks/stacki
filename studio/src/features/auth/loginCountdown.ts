import { assert } from '../../../vendor/stacki/shared/core/assert';

export function loginCountdown(seconds: number) {
  assert(Number.isSafeInteger(seconds), 'Sign-in wait must be a safe integer');
  assert(seconds >= 0, 'Sign-in wait cannot be negative');
  assert(Number.isSafeInteger(Date.now() + seconds * 1000), 'Sign-in deadline must be safe');
  if (seconds === 0) {
    return { markup: '', script: '', policy: '' } as const;
  }
  const nonce = crypto.randomUUID();
  return {
    markup: ` <span id="login-countdown">Wait at least ${seconds} ` + `${seconds === 1 ? 'second' : 'seconds'}, then start a new sign-in below.</span>`,
    script: `<script nonce="${nonce}">` + `(${startLoginCountdown.toString()})(${seconds}, window);</script>`,
    policy: `; script-src 'nonce-${nonce}'`,
  } as const;
}

// This function is serialized into the login page, so it must not close over server code.
function startLoginCountdown(seconds: number, browser: LoginCountdownBrowser): void {
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
      countdown.textContent = `Wait at least ${remaining} ${remaining === 1 ? 'second' : 'seconds'}, ` + 'then start a new sign-in below.';
    } else {
      browser.clearInterval(timer);
      message.setAttribute('role', 'status');
      message.textContent = 'You can try signing in again below.';
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
