// SHA-256, synchronously, for the browser: Web Crypto's digest is asynchronous and
// the source planner is not. The demo's node:crypto stand-in (demo/nodeCrypto.ts)
// and the Settings panel's document host (features/source/documentHost.ts) both
// hash with it, so a digest matches the server's for the same bytes.
const ROUND_CONSTANTS = Uint32Array.from({ length: 64 }, (_value, index) => fractionBits(primes(64)[index] ?? 2, 3));
const INITIAL_STATE = Uint32Array.from({ length: 8 }, (_value, index) => fractionBits(primes(8)[index] ?? 2, 2));

function primes(count: number): readonly number[] {
  const found: number[] = [];
  for (let candidate = 2; found.length < count && candidate < 1_000; candidate++) {
    if (found.every((prime) => candidate % prime !== 0)) {
      found.push(candidate);
    }
  }
  return found;
}

function fractionBits(prime: number, root: 2 | 3): number {
  const value = root === 2 ? Math.sqrt(prime) : Math.cbrt(prime);
  return Math.floor((value - Math.floor(value)) * 2 ** 32) >>> 0;
}

function rotate(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

function padded(bytes: Uint8Array): Uint8Array {
  const length = Math.ceil((bytes.length + 9) / 64) * 64;
  const message = new Uint8Array(length);
  message.set(bytes);
  message[bytes.length] = 0x80;
  const view = new DataView(message.buffer);
  view.setUint32(length - 8, Math.floor(bytes.length / 2 ** 29));
  view.setUint32(length - 4, (bytes.length << 3) >>> 0);
  return message;
}

function compress(state: Uint32Array, view: DataView, offset: number, schedule: Uint32Array): void {
  for (let index = 0; index < 64; index++) {
    if (index < 16) {
      schedule[index] = view.getUint32(offset + index * 4);
    } else {
      const early = schedule[index - 15] ?? 0;
      const late = schedule[index - 2] ?? 0;
      const small0 = rotate(early, 7) ^ rotate(early, 18) ^ (early >>> 3);
      const small1 = rotate(late, 17) ^ rotate(late, 19) ^ (late >>> 10);
      schedule[index] = ((schedule[index - 16] ?? 0) + small0 + (schedule[index - 7] ?? 0) + small1) >>> 0;
    }
  }
  const [a0 = 0, b0 = 0, c0 = 0, d0 = 0, e0 = 0, f0 = 0, g0 = 0, h0 = 0] = state;
  let [a, b, c, d, e, f, g, h] = [a0, b0, c0, d0, e0, f0, g0, h0];
  for (let index = 0; index < 64; index++) {
    const sum1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
    const choice = (e & f) ^ (~e & g);
    const first = (h + sum1 + choice + (ROUND_CONSTANTS[index] ?? 0) + (schedule[index] ?? 0)) >>> 0;
    const sum0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
    const majority = (a & b) ^ (a & c) ^ (b & c);
    const second = (sum0 + majority) >>> 0;
    [h, g, f, e, d, c, b, a] = [g, f, e, (d + first) >>> 0, c, b, a, (first + second) >>> 0];
  }
  [a0 + a, b0 + b, c0 + c, d0 + d, e0 + e, f0 + f, g0 + g, h0 + h].forEach((value, index) => {
    state[index] = value >>> 0;
  });
}

/** The SHA-256 digest of `bytes`, as 64 lowercase hex characters. */
export function sha256Bytes(bytes: Uint8Array): string {
  const message = padded(bytes);
  const view = new DataView(message.buffer);
  const state = Uint32Array.from(INITIAL_STATE);
  const schedule = new Uint32Array(64);
  for (let offset = 0; offset < message.length; offset += 64) {
    compress(state, view, offset, schedule);
  }
  return [...state].map((word) => word.toString(16).padStart(8, '0')).join('');
}

/** The SHA-256 digest of `text`'s UTF-8 bytes, as 64 lowercase hex characters. */
export function sha256Hex(text: string): string {
  return sha256Bytes(new TextEncoder().encode(text));
}
