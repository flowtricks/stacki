// A QR code encoder for one job: the phone preview's address (src/features/preview/phone), drawn
// locally so the address never leaves this computer to be turned into a picture.
//
// Why hand-rolled (AGENTS.md §17): the platform has no QR encoder, and the subset this needs is small:
// byte mode only (a URL is bytes), error correction level M only (the common choice for a code shown on
// a screen: it survives glare and a partly covered code), versions 1 to 10 only (213 bytes, far more
// than an address with a path). That is Reed-Solomon over GF(256), the fixed function patterns, the
// zigzag placement and the eight masks with their penalty rules: one file, tested against the
// standard's published vectors (test/renderer/lib/qrEncode.test.js), with no dependency to vet or keep.
//
// Terms follow ISO/IEC 18004: a module is one square; x is its column and y its row, both 0-based.
import { assert } from '../../../shared/core/assert';

/** A square of modules, row-major: `modules[y * size + x]` is dark when true. Quiet zone not included. */
export interface QrCode {
  readonly version: number;
  readonly size: number;
  readonly mask: number;
  readonly modules: readonly boolean[];
}

export const QR_LIMITS = {
  versionMax: 10,
  /** The most bytes version 10 holds at level M in byte mode. */
  bytesMax: 213,
  /** The standard's quiet zone: four light modules on every side. */
  quietZoneModules: 4,
} as const satisfies Record<string, number>;

// Level M, per version (index 0 is version 1): error-correction codewords per block, and the data
// codewords of each block, short blocks first (ISO/IEC 18004 table 9).
const MEDIUM_LEVEL_BLOCKS: readonly { readonly ecPerBlock: number; readonly dataPerBlock: readonly number[] }[] = [
  { ecPerBlock: 10, dataPerBlock: [16] },
  { ecPerBlock: 16, dataPerBlock: [28] },
  { ecPerBlock: 26, dataPerBlock: [44] },
  { ecPerBlock: 18, dataPerBlock: [32, 32] },
  { ecPerBlock: 24, dataPerBlock: [43, 43] },
  { ecPerBlock: 16, dataPerBlock: [27, 27, 27, 27] },
  { ecPerBlock: 18, dataPerBlock: [31, 31, 31, 31] },
  { ecPerBlock: 22, dataPerBlock: [38, 38, 39, 39] },
  { ecPerBlock: 22, dataPerBlock: [36, 36, 36, 37, 37] },
  { ecPerBlock: 26, dataPerBlock: [43, 43, 43, 43, 44] },
];
// Centre coordinates of the alignment patterns, per version (version 1 has none).
const ALIGNMENT_CENTRES: readonly (readonly number[])[] = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
const MEDIUM_LEVEL_FORMAT_BITS = 0b00;

/** The smallest code holding `text` as UTF-8 bytes, or undefined when it is longer than version 10 holds. */
export function encodeQr(text: string): QrCode | undefined {
  const bytes = new TextEncoder().encode(text);
  const version = smallestVersion(bytes.length);
  if (version === undefined) {
    return undefined;
  }
  const codewords = interleave(version, dataCodewords(version, bytes));
  const grid = baseGrid(version);
  grid.placeCodewords(codewords);
  let best: { readonly modules: readonly boolean[]; readonly mask: number; readonly penalty: number } | undefined;
  for (let mask = 0; mask < 8; mask++) {
    const modules = grid.masked(mask);
    const penalty = penaltyOf(grid.size, modules);
    if (best === undefined || penalty < best.penalty) {
      best = { modules, mask, penalty };
    }
  }
  assert(best !== undefined, 'encodeQr: a mask is chosen');
  assert(best.modules.length === grid.size * grid.size, 'encodeQr: the matrix is square');
  return { version, size: grid.size, mask: best.mask, modules: best.modules };
}

/** Whether the module at column `x`, row `y` is dark; outside the code (the quiet zone) is light. */
export function qrModuleDark(code: QrCode, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= code.size || y >= code.size) {
    return false;
  }
  return code.modules[y * code.size + x] === true;
}

/** The 15 format bits for level M and `mask`, BCH-protected and masked with 0x5412 (ISO/IEC 18004 7.9). */
export function formatBits(mask: number): number {
  assert(Number.isInteger(mask), 'formatBits: the mask is an integer');
  assert(mask >= 0, 'formatBits: the mask is 0 to 7');
  assert(mask < 8, 'formatBits: the mask is 0 to 7');
  const data = (MEDIUM_LEVEL_FORMAT_BITS << 3) | mask;
  let remainder = data;
  for (let i = 0; i < 10; i++) {
    remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
  }
  return ((data << 10) | remainder) ^ 0x5412;
}

/** The 18 version bits for versions 7 and up, BCH-protected (ISO/IEC 18004 7.10). */
export function versionBits(version: number): number {
  assert(version >= 7, 'versionBits: only versions 7 and up carry version bits');
  let remainder = version;
  for (let i = 0; i < 12; i++) {
    remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
  }
  return (version << 12) | remainder;
}

/** The `degree` Reed-Solomon error-correction codewords of `data` over GF(256), polynomial 0x11D. */
export function reedSolomon(data: readonly number[], degree: number): readonly number[] {
  assert(degree > 0, 'reedSolomon: at least one codeword');
  assert(degree <= 30, 'reedSolomon: at most the standard 30 codewords');
  const generator = rsGenerator(degree);
  const result = new Array<number>(degree).fill(0);
  for (const byte of data) {
    assert(byte >= 0, 'reedSolomon: data are bytes');
    assert(byte <= 255, 'reedSolomon: data are bytes');
    const factor = byte ^ (result.shift() ?? 0);
    result.push(0);
    for (let i = 0; i < degree; i++) {
      result[i] = (result[i] ?? 0) ^ gfMultiply(generator[i] ?? 0, factor);
    }
  }
  return result;
}

function smallestVersion(byteCount: number): number | undefined {
  for (let version = 1; version <= QR_LIMITS.versionMax; version++) {
    const countBits = version < 10 ? 8 : 16;
    if (4 + countBits + byteCount * 8 <= dataCapacity(version) * 8) {
      return version;
    }
  }
  return undefined;
}

function blocksOf(version: number): { readonly ecPerBlock: number; readonly dataPerBlock: readonly number[] } {
  const blocks = MEDIUM_LEVEL_BLOCKS[version - 1];
  assert(blocks !== undefined, 'blocksOf: a known version');
  return blocks;
}

function dataCapacity(version: number): number {
  return blocksOf(version).dataPerBlock.reduce((sum, count) => sum + count, 0);
}

// Mode indicator, count, the bytes, a terminator, then padding to the version's capacity.
function dataCodewords(version: number, bytes: Uint8Array): readonly number[] {
  const bits: number[] = [];
  const push = (value: number, length: number): void => {
    for (let i = length - 1; i >= 0; i--) {
      bits.push((value >>> i) & 1);
    }
  };
  push(0b0100, 4);
  push(bytes.length, version < 10 ? 8 : 16);
  bytes.forEach((byte) => push(byte, 8));
  const capacityBits = dataCapacity(version) * 8;
  assert(bits.length <= capacityBits, 'dataCodewords: the data fits the version');
  push(0, Math.min(4, capacityBits - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    codewords.push(bits.slice(i, i + 8).reduce((byte, bit) => (byte << 1) | bit, 0));
  }
  for (let pad = 0; codewords.length < dataCapacity(version); pad++) {
    codewords.push(pad % 2 === 0 ? 0xec : 0x11);
  }
  return codewords;
}

// Split into blocks, add each block's error correction, then read the blocks column by column.
function interleave(version: number, data: readonly number[]): readonly number[] {
  const { ecPerBlock, dataPerBlock } = blocksOf(version);
  const blocks: { readonly data: readonly number[]; readonly ec: readonly number[] }[] = [];
  let offset = 0;
  for (const count of dataPerBlock) {
    const slice = data.slice(offset, offset + count);
    blocks.push({ data: slice, ec: reedSolomon(slice, ecPerBlock) });
    offset += count;
  }
  assert(offset === data.length, 'interleave: every data codeword is in a block');
  const result: number[] = [];
  const longest = Math.max(...dataPerBlock);
  for (let i = 0; i < longest; i++) {
    blocks.forEach((block) => (i < block.data.length ? result.push(block.data[i] ?? 0) : undefined));
  }
  for (let i = 0; i < ecPerBlock; i++) {
    blocks.forEach((block) => result.push(block.ec[i] ?? 0));
  }
  return result;
}

// The matrix while it is built: what each module is, and which modules belong to a function pattern
// (finders, timing, alignment, format and version areas) and so take no data and no mask.
class Grid {
  private readonly dark: boolean[];
  private readonly reserved: boolean[];

  constructor(readonly size: number) {
    assert(size >= 21, 'Grid: version 1 is 21 modules wide');
    this.dark = new Array<boolean>(size * size).fill(false);
    this.reserved = new Array<boolean>(size * size).fill(false);
  }

  /** Draws a function module; outside the matrix is ignored, as a finder's separator at an edge is. */
  setFunction(x: number, y: number, { dark }: { readonly dark: boolean }): void {
    if (x >= 0 && y >= 0 && x < this.size && y < this.size) {
      this.dark[y * this.size + x] = dark;
      this.reserved[y * this.size + x] = true;
    }
  }

  // The zigzag: two columns at a time from the right, upward then downward, skipping the timing column.
  placeCodewords(codewords: readonly number[]): void {
    const size = this.size;
    let bit = 0;
    const bitsTotal = codewords.length * 8;
    for (let right = size - 1; right >= 1; right -= 2) {
      const column = right <= 6 ? right - 1 : right;
      const upward = ((column + 1) & 2) === 0;
      for (let step = 0; step < size; step++) {
        const y = upward ? size - 1 - step : step;
        for (let offset = 0; offset < 2; offset++) {
          const index = y * size + (column - offset);
          if (!this.reserved[index] && bit < bitsTotal) {
            this.dark[index] = (((codewords[bit >>> 3] ?? 0) >>> (7 - (bit & 7))) & 1) === 1;
            bit++;
          }
        }
      }
    }
    assert(bit === bitsTotal, 'placeCodewords: every codeword bit is placed');
  }

  /** A copy with `mask` applied to the data modules and its format bits written. */
  masked(mask: number): readonly boolean[] {
    const size = this.size;
    const modules = this.dark.map((dark, index) => (this.reserved[index] === true ? dark : maskFlips(mask, index % size, Math.floor(index / size)) !== dark));
    for (const write of formatWrites(size, mask)) {
      modules[write.index] = write.dark;
    }
    assert(modules.length === size * size, 'masked: the copy is the whole matrix');
    return modules;
  }
}

// Finders, separators, timing, alignment, the dark module, version bits and the format areas.
function baseGrid(version: number): Grid {
  const size = version * 4 + 17;
  const grid = new Grid(size);
  for (let i = 0; i < size; i++) {
    grid.setFunction(6, i, { dark: i % 2 === 0 });
    grid.setFunction(i, 6, { dark: i % 2 === 0 });
  }
  for (const [cx, cy] of [
    [3, 3],
    [size - 4, 3],
    [3, size - 4],
  ] as const) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const ring = Math.max(Math.abs(dx), Math.abs(dy));
        grid.setFunction(cx + dx, cy + dy, { dark: ring !== 2 && ring !== 4 });
      }
    }
  }
  const centres = ALIGNMENT_CENTRES[version - 1] ?? [];
  for (const cy of centres) {
    for (const cx of centres) {
      if (!overlapsFinder(size, cx, cy)) {
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            grid.setFunction(cx + dx, cy + dy, { dark: Math.max(Math.abs(dx), Math.abs(dy)) !== 1 });
          }
        }
      }
    }
  }
  // Reserved now with mask 0's bits; masked() writes the real ones.
  for (const write of formatWrites(size, 0)) {
    grid.setFunction(write.index % size, Math.floor(write.index / size), { dark: write.dark });
  }
  if (version >= 7) {
    const bits = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) === 1;
      const far = size - 11 + (i % 3);
      const near = Math.floor(i / 3);
      grid.setFunction(far, near, { dark });
      grid.setFunction(near, far, { dark });
    }
  }
  return grid;
}

function overlapsFinder(size: number, cx: number, cy: number): boolean {
  if (cx === 6) {
    return cy === 6 || cy === size - 7;
  }
  return cx === size - 7 && cy === 6;
}

// Where format bit `i` is written: around the top-left finder, and split between the other two.
function formatPositions(size: number, i: number): readonly (readonly [number, number])[] {
  const first: readonly [number, number] = i < 6 ? [8, i] : i < 8 ? [8, i + 1] : i === 8 ? [7, 8] : [14 - i, 8];
  const second: readonly [number, number] = i < 8 ? [size - 1 - i, 8] : [8, size - 15 + i];
  return [first, second];
}

// The format bits' modules for `mask`, and the dark module beside the bottom-left finder.
function formatWrites(size: number, mask: number): readonly { readonly index: number; readonly dark: boolean }[] {
  const bits = formatBits(mask);
  const writes: { readonly index: number; readonly dark: boolean }[] = [];
  for (let i = 0; i < 15; i++) {
    const dark = ((bits >>> i) & 1) === 1;
    for (const [x, y] of formatPositions(size, i)) {
      writes.push({ index: y * size + x, dark });
    }
  }
  writes.push({ index: (size - 8) * size + 8, dark: true });
  return writes;
}

function maskFlips(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    case 7:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      throw new Error(`maskFlips: no mask ${mask}`);
  }
}

// The standard's four penalty rules (ISO/IEC 18004 7.8.3); the mask with the lowest total is used.
function penaltyOf(size: number, modules: readonly boolean[]): number {
  const at = (x: number, y: number): boolean => modules[y * size + x] === true;
  let penalty = 0;
  for (let line = 0; line < size; line++) {
    penalty += linePenalty(size, (i) => at(i, line));
    penalty += linePenalty(size, (i) => at(line, i));
  }
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const dark = at(x, y);
      if (at(x + 1, y) === dark && at(x, y + 1) === dark && at(x + 1, y + 1) === dark) {
        penalty += 3;
      }
    }
  }
  const darkCount = modules.filter(Boolean).length;
  const total = size * size;
  penalty += (Math.ceil(Math.abs(darkCount * 20 - total * 10) / total) - 1) * 10;
  return penalty;
}

const FINDER_LIKE = [true, false, true, true, true, false, true];

// Rule 1 (runs of five or more) and rule 3 (a finder-like 1:1:3:1:1 with four light modules beside it).
function linePenalty(size: number, dark: (i: number) => boolean): number {
  let penalty = 0;
  let run = 1;
  for (let i = 1; i <= size; i++) {
    if (i < size && dark(i) === dark(i - 1)) {
      run++;
    } else {
      if (run >= 5) {
        penalty += run - 2;
      }
      run = 1;
    }
  }
  const lightAt = (i: number): boolean => i < 0 || i >= size || !dark(i);
  for (let start = 0; start + 7 <= size; start++) {
    if (FINDER_LIKE.every((expected, offset) => dark(start + offset) === expected)) {
      const lightBefore = [1, 2, 3, 4].every((offset) => lightAt(start - offset));
      const lightAfter = [0, 1, 2, 3].every((offset) => lightAt(start + 7 + offset));
      if (lightBefore || lightAfter) {
        penalty += 40;
      }
    }
  }
  return penalty;
}

const GF_EXP: readonly number[] = (() => {
  const table: number[] = [];
  let value = 1;
  for (let i = 0; i < 255; i++) {
    table.push(value);
    value <<= 1;
    if (value & 0x100) {
      value ^= 0x11d;
    }
  }
  return table;
})();
const GF_LOG: readonly number[] = (() => {
  const table = new Array<number>(256).fill(0);
  GF_EXP.forEach((value, power) => (table[value] = power));
  return table;
})();

function gfMultiply(left: number, right: number): number {
  if (left === 0 || right === 0) {
    return 0;
  }
  return GF_EXP[((GF_LOG[left] ?? 0) + (GF_LOG[right] ?? 0)) % 255] ?? 0;
}

// The generator polynomial (x - α^0)(x - α^1)…(x - α^(degree-1)), highest coefficient dropped.
function rsGenerator(degree: number): readonly number[] {
  let coefficients = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array<number>(coefficients.length + 1).fill(0);
    coefficients.forEach((coefficient, j) => {
      next[j] = (next[j] ?? 0) ^ coefficient;
      next[j + 1] = (next[j + 1] ?? 0) ^ gfMultiply(coefficient, GF_EXP[i] ?? 0);
    });
    coefficients = next;
  }
  return coefficients.slice(1);
}
