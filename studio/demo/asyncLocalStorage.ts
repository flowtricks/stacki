// `node:async_hooks` for the CSS variable engine in the demo page. The engine is
// synchronous, so "the store for this call" is simply the store for the current
// `run`, restored when it returns.
export class AsyncLocalStorage<T> {
  private current: T | undefined;

  run<R>(store: T, callback: () => R): R {
    const previous = this.current;
    this.current = store;
    try {
      return callback();
    } finally {
      this.current = previous;
    }
  }

  getStore(): T | undefined {
    return this.current;
  }
}
