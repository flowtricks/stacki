// One project writer sequences accepted mutations and snapshot capture. Network/build
// work should run outside this queue after the source revision has been captured.
export class SerialQueue {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  constructor(private readonly before?: () => Promise<void>) {}
  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.pending >= 200) {
      throw new Error('Project is busy. Please retry.');
    }
    this.pending++;
    const current = this.tail.then(async () => {
      await this.before?.();
      return operation();
    });
    this.tail = current.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await current;
    } finally {
      this.pending--;
    }
  }
}
