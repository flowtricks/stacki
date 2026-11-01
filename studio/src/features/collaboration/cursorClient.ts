import { record, string } from '../../shared/validation';
import { CURSOR_INTERVAL, CURSOR_MESSAGE_LIMIT, parseCursorPacket, type CursorPosition } from './cursorPresence';
import { cursorAt } from './cursorCoordinates';
import { createCursorEditor, createCursorLayer, createRemoteCursor } from './cursorElements';
import { RemoteCursors } from './remoteCursors';

export function installCursorPresence(post: (message: unknown) => void) {
  window.dispatchEvent(new Event('studio:cursor-dispose'));
  return window.parent === window ? { receive: (_input: unknown) => {} } : new CursorClient(post);
}
class CursorClient {
  private readonly layer = createCursorLayer();
  private readonly editor = createCursorEditor(this.layer.root);
  private readonly local = createRemoteCursor(this.layer.root);
  private readonly remote = new RemoteCursors(this.layer.root);
  private readonly events = new AbortController();
  private readonly heartbeat: ReturnType<typeof setInterval>;
  private enabled = false;
  private interactive = false;
  private cursor: CursorPosition | null = null;
  private lastPoint = { x: 0, y: 0 };
  private hasPoint = false;
  private text = '';
  private typing = false;
  private deleting = false;
  private pending: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly post: (message: unknown) => void) {
    this.local.element.hidden = true;
    this.local.name.textContent = 'You';
    this.local.element.classList.add('local-cursor');
    const signal = this.events.signal;
    document.addEventListener('pointermove', (event) => this.move(event), {
      signal,
      passive: true,
    });
    document.documentElement.addEventListener('pointerleave', () => this.leave(), { signal });
    document.addEventListener('keydown', (event) => this.shortcut(event), { signal });
    document.addEventListener(
      'keyup',
      (event) => {
        if (event.key === 'Backspace') {
          this.deleting = false;
        }
      },
      { signal },
    );
    window.addEventListener(
      'blur',
      () => {
        if (!this.typing) {
          this.leave();
        }
      },
      { signal },
    );
    window.addEventListener('pagehide', () => this.leave(), { signal });
    document.addEventListener(
      'visibilitychange',
      () => {
        if (document.hidden) {
          this.leave();
        }
      },
      { signal },
    );
    window.addEventListener('scroll', () => this.scrolled(), {
      signal,
      capture: true,
      passive: true,
    });
    window.addEventListener('resize', () => this.draw(), { signal });
    document.addEventListener('avb:morphed', () => this.draw(), { signal });
    window.addEventListener('studio:cursor-dispose', () => this.destroy(), { signal });
    this.editor.input.addEventListener('input', (event) => this.inputChanged(event), { signal });
    this.editor.input.addEventListener('keydown', (event) => this.inputKey(event), { signal });
    this.heartbeat = setInterval(() => {
      if (this.cursor && this.enabled && !this.interactive) {
        this.send();
      }
      this.remote.draw();
    }, 5000);
  }
  receive(input: unknown) {
    try {
      const data = record(input);
      switch (data['type']) {
        case 'studio:cursor-config':
          this.enabled = data['enabled'] === true;
          if (this.enabled && 'text' in data) {
            this.text = string(data['text'], CURSOR_MESSAGE_LIMIT);
            this.typing = data['typing'] === true;
            this.editor.input.value = this.text;
          }
          if (!this.enabled) {
            this.leave();
            this.remote.clear();
          }
          this.layer.host.hidden = !this.enabled || this.interactive;
          this.draw();
          break;
        case 'studio:cursor-peer':
          if (this.enabled) {
            this.remote.update(parseCursorPacket(data));
          }
          break;
        case 'studio:cursor-chat':
          this.open();
          break;
        case 'studio:cursor-leave':
          this.leave();
          break;
        case 'studio:interactive':
          this.interactive = data['enabled'] === true;
          if (this.interactive) {
            this.leave();
          }
          this.layer.host.hidden = !this.enabled || this.interactive;
          break;
        case 'studio:cursor-scale':
          this.setScale(data['scale']);
          break;
      }
    } catch {
      /* Ignore invalid preview messages. */
    }
  }
  private move(event: PointerEvent) {
    if (!this.enabled || this.interactive || !(event.target instanceof Element)) {
      return;
    }
    this.lastPoint = { x: event.clientX, y: event.clientY };
    this.hasPoint = true;
    this.cursor = cursorAt(event.clientX, event.clientY, event.target);
    this.drawLocal();
    if (this.typing && this.layer.root.activeElement !== this.editor.input) {
      this.editor.input.focus({ preventScroll: true });
    }
    this.publish();
  }
  private shortcut(event: KeyboardEvent) {
    if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || !this.enabled || this.interactive) {
      return;
    }
    if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable=true], #studio-live-cursors')) {
      return;
    }
    if (event.key === 'Backspace' && (this.text || this.deleting)) {
      event.preventDefault();
      this.deleting = true;
      this.text = Array.from(this.text).slice(0, -1).join('');
      this.editor.input.value = this.text;
      if (this.text) {
        this.open();
      } else {
        this.finish();
      }
      return;
    }
    if (event.key !== '/') {
      return;
    }
    event.preventDefault();
    this.open();
  }
  private open() {
    if (!this.enabled || this.interactive) {
      return;
    }
    if (!this.cursor) {
      if (!this.hasPoint) {
        this.lastPoint = { x: innerWidth / 2, y: innerHeight / 2 };
      }
      this.cursor = cursorAt(this.lastPoint.x, this.lastPoint.y, document.elementFromPoint(this.lastPoint.x, this.lastPoint.y));
    }
    this.typing = true;
    this.editor.input.value = this.text;
    this.editor.element.hidden = false;
    this.draw();
    this.editor.input.focus({ preventScroll: true });
    this.editor.input.setSelectionRange(this.text.length, this.text.length);
    this.publish();
  }
  private inputChanged(event: Event) {
    this.text = this.editor.input.value;
    if (!this.text && event instanceof InputEvent && event.inputType.startsWith('delete') && !event.isComposing) {
      this.finish();
    } else {
      this.draw();
      this.publish();
    }
  }
  private inputKey(event: KeyboardEvent) {
    event.stopPropagation();
    if (event.key === 'Backspace' && !event.isComposing) {
      this.deleting = true;
    }
    if (event.isComposing || (event.key === 'Enter' && event.shiftKey) || !['Escape', 'Enter'].includes(event.key)) {
      return;
    }
    event.preventDefault();
    this.finish();
  }
  private finish() {
    this.typing = false;
    this.editor.element.hidden = true;
    this.editor.input.blur();
    this.draw();
    this.publish();
  }
  private publish() {
    if (!this.pending) {
      this.pending = setTimeout(() => this.send(), CURSOR_INTERVAL);
    }
  }
  private send() {
    clearTimeout(this.pending);
    this.pending = undefined;
    this.post({ type: 'studio:cursor', cursor: this.cursor, text: this.text, typing: this.typing });
  }
  private leave() {
    this.cursor = null;
    this.editor.element.hidden = true;
    this.local.element.hidden = true;
    this.send();
  }
  private scrolled() {
    if (this.cursor) {
      this.cursor = cursorAt(this.lastPoint.x, this.lastPoint.y, document.elementFromPoint(this.lastPoint.x, this.lastPoint.y));
      this.publish();
    }
    this.draw();
  }
  private setScale(value: unknown) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0.05 || value > 10) {
      return;
    }
    this.remote.inverse = 1 / value;
    this.layer.host.style.setProperty('--cursor-inverse', String(1 / value));
    this.draw();
  }
  private draw() {
    this.remote.draw();
    this.drawLocal();
  }
  private drawLocal() {
    if (!this.cursor) {
      return;
    }
    // Local chat follows the physical pointer; element anchors are for remote viewers.
    const { x, y } = this.lastPoint;
    const color = '#333333';
    this.editor.element.style.setProperty('--peer-color', color);
    this.editor.element.hidden = !this.typing;
    this.editor.measure.textContent = (this.text || this.editor.input.placeholder) + '\u200b';
    this.local.element.hidden = this.typing || !this.text;
    this.local.element.style.setProperty('--peer-color', color);
    this.local.text.textContent = this.text;
    this.positionBubble(this.typing ? this.editor : this.local, x, y);
  }
  private positionBubble(bubble: { element: HTMLElement; label: HTMLElement }, x: number, y: number) {
    const inverse = this.remote.inverse;
    const left = Math.max(4, Math.min(x + 18 * inverse, innerWidth - bubble.label.offsetWidth * inverse - 4));
    const top = Math.max(4, Math.min(y + 22 * inverse, innerHeight - bubble.label.offsetHeight * inverse - 4));
    bubble.element.style.transform = `translate(${x}px, ${y}px)`;
    bubble.label.style.left = (left - x) / inverse + 'px';
    bubble.label.style.top = (top - y) / inverse + 'px';
  }
  private destroy() {
    this.leave();
    this.events.abort();
    clearInterval(this.heartbeat);
    this.layer.host.remove();
  }
}
