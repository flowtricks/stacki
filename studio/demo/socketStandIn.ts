// Stands in for the socket to `/studio/sync`. The real client keeps its protocol;
// the other end is a DemoRoom in this page. Delivery is always asynchronous, as on
// a network, because the client assumes it can finish a call before a reply lands.
import type { DemoRooms, RoomPeer } from './room';

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

export function socketStandIn(rooms: DemoRooms, native: typeof WebSocket): typeof WebSocket {
  class DemoSocket extends EventTarget implements RoomPeer {
    static readonly CONNECTING = CONNECTING;
    static readonly OPEN = OPEN;
    static readonly CLOSING = 2;
    static readonly CLOSED = CLOSED;
    readonly CONNECTING = CONNECTING;
    readonly OPEN = OPEN;
    readonly CLOSING = 2;
    readonly CLOSED = CLOSED;
    readonly url: string;
    readonly bufferedAmount = 0;
    readyState = CONNECTING;
    private detach: (() => void) | undefined;
    private receive: ((message: string) => void) | undefined;

    constructor(url: string | URL) {
      super();
      this.url = String(url);
      const file = new URL(this.url).searchParams.get('file') ?? '';
      setTimeout(() => this.connect(file), 0);
    }

    private connect(file: string): void {
      const room = rooms.get(file);
      if (this.readyState === CLOSED) {
        return;
      }
      this.readyState = OPEN;
      this.dispatchEvent(new Event('open'));
      const attachment = room.attach(this);
      this.receive = attachment.receive;
      this.detach = attachment.detach;
    }

    deliver(message: string): void {
      setTimeout(() => {
        if (this.readyState === OPEN) {
          this.dispatchEvent(new MessageEvent('message', { data: message }));
        }
      }, 0);
    }

    send(message: string): void {
      this.receive?.(message);
    }

    close(): void {
      if (this.readyState === CLOSED) {
        return;
      }
      this.readyState = CLOSED;
      this.detach?.();
      this.dispatchEvent(new CloseEvent('close', { code: 1000 }));
    }
  }
  return new Proxy(native, {
    construct(target, args: [string | URL, (string | string[])?]) {
      const url = new URL(String(args[0]));
      if (url.pathname === '/studio/sync') {
        return new DemoSocket(url);
      }
      return new target(...args);
    },
  });
}
