// Stands in for the `/studio/api/astro-events` stream. Nothing changes a static site
// behind the page's back, so the stream opens once and stays silent. `onopen` still
// fires because the client reconciles its project on it.
export function eventSourceStandIn(native: typeof EventSource): typeof EventSource {
  class DemoEventSource extends EventTarget {
    onopen: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    readyState = 1;
    constructor(readonly url: string) {
      super();
      setTimeout(() => this.onopen?.(new Event('open')), 0);
    }
    close(): void {
      this.readyState = 2;
    }
  }
  return new Proxy(native, {
    construct(target, args: [string | URL, EventSourceInit?]) {
      const url = new URL(String(args[0]), location.href);
      if (url.pathname === '/studio/api/astro-events') {
        return new DemoEventSource(url.href);
      }
      return new target(...args);
    },
  });
}
