// Marks the editor's controls the demo cannot honour, from the outside, because the
// client ships unmodified. A rule names a control the way a person finds it; the
// browser test fails if a rule stops matching, so a redesigned control cannot quietly
// come back to life and fail on click.
import { PUBLISH_NOTE } from './publish';

const REFRESH_FRAME_MAX = 1;

export const REASONS = {
  ai: 'AI chat runs in the full Stacki app.',
  defaults: 'Component defaults change every page, so they are in the full Stacki app.',
  paste: 'Paste is in the full Stacki app.',
  wrap: 'Wrapping uses a component, which needs Astro to render it.',
} as const;

interface ControlRule {
  readonly selector: string;
  /** Exact visible text, for controls that have no better name. */
  readonly text?: string;
  /** Absent means hidden outright: there is nothing to explain about Publish or Git. */
  readonly reason?: string;
}

export const CONTROL_RULES: readonly ControlRule[] = [
  { selector: '.rail-btn[aria-label="Git"]' },
  { selector: '.rail-btn.ai-icon' },
  { selector: '.collaborators' },
  // The visitor's own badge on their page row: one person, so it tells them nothing.
  { selector: '.page-presence' },
  { selector: '[role=menuitem]', text: 'Set component defaults', reason: REASONS.defaults },
  { selector: '[role=menuitem]', text: 'Wrap in', reason: REASONS.wrap },
  { selector: '[role=menuitem]', text: 'Paste', reason: REASONS.paste },
];

// The rail's own keyboard shortcuts, for the panels the rules above disable.
const BLOCKED_KEYS: readonly { readonly code: string; readonly alt: boolean; readonly shift: boolean; readonly reason: string }[] = [];

function visibleText(element: Element): string {
  return (element.textContent ?? '').trim().split('\n')[0]?.trim() ?? '';
}

function matches(rule: ControlRule, element: Element): boolean {
  return rule.text === undefined || visibleText(element).startsWith(rule.text);
}

function applyRule(rule: ControlRule): void {
  const elements = document.querySelectorAll<HTMLElement>(rule.selector);
  for (let index = 0; index < elements.length; index++) {
    const element = elements[index];
    if (element !== undefined && matches(rule, element)) {
      if (rule.reason === undefined) {
        element.dataset['demoHidden'] = 'true';
      } else {
        element.dataset['demoDisabled'] = rule.reason;
        element.setAttribute('aria-disabled', 'true');
        element.title = rule.reason;
      }
    }
  }
}

function isTyping(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('input, textarea, select, [contenteditable=true], .cm-editor, [role=dialog]') !== null;
}

/** Studio's publish panel runs for real, against a script; it says so while it shows. */
function notePublish(): void {
  // The publish popup Studio shares with Desktop.
  const panel = document.querySelector<HTMLElement>('.publish-status-body');
  if (panel !== null) {
    panel.dataset['demoNote'] = PUBLISH_NOTE;
  }
}

export interface DemoControls {
  /** The settings panel's lock, or undefined when the selection can be edited. */
  readonly lockSettings: (reason: string | undefined) => void;
}

function applyLock(reason: string | undefined): void {
  const panel = document.querySelector<HTMLElement>('.studio-right .panel-section');
  if (panel === null) {
    return;
  }
  const settings = document.querySelector('.studio-right .right-tabs button.on')?.textContent?.trim() === 'Settings';
  const body = panel.querySelector<HTMLElement>('.panel-body');
  if (reason !== undefined && settings) {
    panel.dataset['demoLock'] = reason;
    body?.setAttribute('inert', '');
  } else {
    delete panel.dataset['demoLock'];
    body?.removeAttribute('inert');
  }
}

export function installControls(note: (reason: string) => void): DemoControls {
  let lock: string | undefined;
  let scheduled = 0;
  const refresh = () => {
    scheduled = 0;
    for (const rule of CONTROL_RULES) {
      applyRule(rule);
    }
    applyLock(lock);
    notePublish();
  };
  const schedule = () => {
    if (scheduled < REFRESH_FRAME_MAX) {
      scheduled++;
      requestAnimationFrame(refresh);
    }
  };
  new MutationObserver(schedule).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
  for (const type of ['pointerdown', 'mousedown', 'click']) {
    window.addEventListener(
      type,
      (event) => {
        const control = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-demo-disabled]') : null;
        if (control !== null) {
          event.preventDefault();
          event.stopImmediatePropagation();
          if (type === 'click') {
            note(control.dataset['demoDisabled'] ?? '');
          }
        }
      },
      true,
    );
  }
  window.addEventListener(
    'keydown',
    (event) => {
      if (isTyping(event.target) || event.metaKey || event.ctrlKey) {
        return;
      }
      const blocked = BLOCKED_KEYS.find((key) => key.code === event.code && key.alt === event.altKey && key.shift === event.shiftKey);
      if (blocked !== undefined) {
        event.stopImmediatePropagation();
        note(blocked.reason);
      }
    },
    true,
  );
  schedule();
  return {
    lockSettings: (reason) => {
      lock = reason;
      schedule();
    },
  };
}
