import type { CursorPacket } from './cursorPresence';
import { cursorPoint } from './cursorCoordinates';
import { createRemoteCursor } from './cursorElements';
import { presenceColor } from './presenceColors';

type CursorView = ReturnType<typeof createRemoteCursor>;
export class RemoteCursors {
  private readonly views = new Map<string, { readonly view: CursorView; packet: CursorPacket; seen: number }>();
  inverse = 1;
  constructor(private readonly root: ShadowRoot) {}
  update(packet: CursorPacket) {
    const existing = this.views.get(packet.id);
    if (!packet.cursor) {
      existing?.view.element.remove();
      this.views.delete(packet.id);
      return;
    }
    if (!existing && this.views.size >= 30) {
      return;
    }
    const entry = existing ?? { view: createRemoteCursor(this.root), packet, seen: Date.now() };
    entry.packet = packet;
    entry.seen = Date.now();
    entry.view.element.dataset['peerId'] = packet.id;
    entry.view.element.dataset['peer'] = packet.name;
    entry.view.element.style.setProperty('--peer-color', presenceColor(packet));
    entry.view.name.textContent = packet.name;
    entry.view.text.textContent = packet.text || (packet.typing ? '…' : '');
    this.views.set(packet.id, entry);
    this.position(entry.view, packet, true);
  }
  draw() {
    for (const [id, entry] of this.views) {
      if (Date.now() - entry.seen > 15000) {
        entry.view.element.remove();
        this.views.delete(id);
      } else {
        this.position(entry.view, entry.packet, false);
      }
    }
  }
  clear() {
    for (const { view } of this.views.values()) {
      view.element.remove();
    }
    this.views.clear();
  }
  private position(view: CursorView, packet: CursorPacket, animate: boolean) {
    if (!packet.cursor) {
      return;
    }
    const { x, y } = cursorPoint(packet.cursor);
    view.element.hidden = x < 0 || y < 0 || x > innerWidth || y > innerHeight;
    view.element.style.transition = animate ? 'transform 70ms linear' : 'none';
    view.element.style.transform = `translate(${x}px, ${y}px)`;
    // Place the actual label beside the pointer; reserving its maximum width
    // leaves short names floating far away whenever the cursor nears an edge.
    const width = view.label.offsetWidth * this.inverse;
    const height = view.label.offsetHeight * this.inverse;
    const left = Math.max(4, Math.min(x + 18 * this.inverse, innerWidth - width - 4));
    const top = Math.max(4, Math.min(y + 22 * this.inverse, innerHeight - height - 4));
    view.label.style.left = (left - x) / this.inverse + 'px';
    view.label.style.top = (top - y) / this.inverse + 'px';
  }
}
