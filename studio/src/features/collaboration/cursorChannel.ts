import { parseCursorPacket, parseCursorState, type CursorPacket, type CursorState } from './cursorPresence';

export function participantId(): string {
  const saved = sessionStorage.getItem('studio-participant');
  if (saved && /^[a-f0-9-]{36}$/i.test(saved)) {
    return saved;
  }
  const id = crypto.randomUUID();
  sessionStorage.setItem('studio-participant', id);
  return id;
}

export class CursorChannel {
  private readonly positions = new Map<string, CursorPacket>();
  private readonly listeners = new Set<(packet: CursorPacket) => void>();
  constructor(private readonly send: (message: unknown) => void) {}
  receive(message: Record<string, unknown>): boolean {
    if (message['type'] !== 'cursor') {
      return false;
    }
    const packet = parseCursorPacket(message);
    if (packet.cursor && this.positions.size < 3000) {
      this.positions.set(packet.id, packet);
    } else {
      this.positions.delete(packet.id);
    }
    this.emit(packet);
    return true;
  }
  publish(state: CursorState) {
    this.send({ type: 'cursor', ...parseCursorState(state) });
  }
  subscribe(listener: (packet: CursorPacket) => void) {
    this.listeners.add(listener);
    for (const packet of this.positions.values()) {
      listener(packet);
    }
    return () => {
      this.listeners.delete(listener);
    };
  }
  reset() {
    for (const packet of this.positions.values()) {
      this.emit({ ...packet, cursor: null, text: '', typing: false });
    }
    this.positions.clear();
  }
  private emit(packet: CursorPacket) {
    for (const listener of this.listeners) {
      listener(packet);
    }
  }
}
