// The two `Buffer` calls sourcePlanner makes, for a page that has no `Buffer`. They
// are UTF-8 only, which is all the planner asks of them. esbuild injects this file.
class PlannerBytes extends Uint8Array {
  override toString(encoding?: string): string {
    if (encoding !== 'utf8') {
      throw new Error(`Only utf8 text is available here, not ${String(encoding)}`);
    }
    return new TextDecoder().decode(this);
  }
}

export const Buffer = {
  from(value: string | Uint8Array): PlannerBytes {
    return new PlannerBytes(typeof value === 'string' ? new TextEncoder().encode(value) : value);
  },
  byteLength(value: string): number {
    return new TextEncoder().encode(value).length;
  },
};
