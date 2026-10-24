// Heartbeats prove transport activity, not that an edit reached durable storage.
// Track the oldest unacknowledged edit so typing cannot postpone recovery forever.
export class SaveWatch {
  private readonly deadlines: { readonly sequence: number; readonly deadline: number }[] = [];
  private sequence = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly expired: () => void) {}

  get pending(): number {
    return this.deadlines.length;
  }

  sent(): number | undefined {
    if (this.deadlines.length >= 200) {
      return undefined;
    }
    if (this.sequence === Number.MAX_SAFE_INTEGER) {
      throw new Error('Save sequence exhausted');
    }
    const sequence = ++this.sequence;
    // Storage allows 15 seconds plus a two-second batch; leave transport margin.
    this.deadlines.push({ sequence, deadline: Date.now() + 25_000 });
    this.schedule();
    return sequence;
  }

  saved(sequence: number | undefined): boolean {
    const index =
      sequence === undefined ? 0 : this.deadlines.findIndex((item) => item.sequence === sequence);
    if (!this.deadlines[index]) {
      return false;
    }
    this.deadlines.splice(index, 1);
    this.schedule();
    return true;
  }

  reset(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.deadlines.length = 0;
  }

  private schedule(): void {
    clearTimeout(this.timer);
    const deadline = this.deadlines[0]?.deadline;
    this.timer =
      deadline === undefined
        ? undefined
        : setTimeout(this.expired, Math.max(0, deadline - Date.now()));
  }
}
