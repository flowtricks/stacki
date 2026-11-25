import { studioTranslate } from '../../shared/studioTranslate';
// Coalesce durable snapshots without delaying collaboration or preview updates.
// Every caller resolves only after a snapshot containing its edit is durable.
export class BatchedWriter<T = Uint8Array> {
  private latest: T | undefined;
  private waiting: { resolve: () => void; reject: (error: unknown) => void }[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  constructor(
    private readonly write: (bytes: T) => Promise<void>,
    private readonly delay = 2000,
  ) {}
  save(bytes: T, immediately = false): Promise<void> {
    if (this.waiting.length >= 200) {
      return Promise.reject(new Error(studioTranslate('studio.draft.queueFull')));
    }
    this.latest = bytes;
    const result = new Promise<void>((resolve, reject) => {
      this.waiting.push({ resolve, reject });
    });
    if (immediately) {
      void this.flush();
    } else {
      this.schedule();
    }
    return result;
  }
  private schedule() {
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.flush();
      }, this.delay);
    }
  }
  async flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.running) {
      await this.running;
      if (this.latest !== undefined) {
        await this.flush();
      }
      return;
    }
    const bytes = this.latest;
    if (bytes === undefined) {
      return;
    }
    const waiting = this.waiting;
    this.latest = undefined;
    this.waiting = [];
    this.running = this.write(bytes).then(
      () => {
        for (const item of waiting) {
          item.resolve();
        }
      },
      (error: unknown) => {
        for (const item of waiting) {
          item.reject(error);
        }
      },
    );
    await this.running;
    this.running = undefined;
    if (this.latest !== undefined) {
      this.schedule();
    }
  }
}
