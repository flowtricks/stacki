// Goal: src/lib/qr/qrEncode.ts, the phone preview's QR encoder, writes codes a phone camera reads, and
// refuses what it cannot hold. It is hand-rolled (no dependency, AGENTS.md §17), so it is held to the
// standard's own published numbers rather than to another encoder.
//
// Method: the parts are checked against ISO/IEC 18004's worked vectors: the Reed-Solomon codewords of
// the "HELLO WORLD" 1-M example, the format-bit table for level M and every mask, and the version
// bits of versions 7 and 10. The whole matrix of one address is compared with a golden copy that was
// decoded back to the same text by an independent decoder (Apple's CIDetector, run by hand when the
// golden was recorded; every mask and versions 1, 2, 3, 5, 9 and 10 decoded then too). Structure is
// checked for every version the encoder can choose: the size, the three finders, the timing lines and
// the dark module. The negative space: text longer than version 10 holds has no code, a mask outside 0
// to 7 is a programmer error, and the length at the edge of each version moves to the next one.
const test = require('node:test');
const assert = require('node:assert/strict');
const load = require('../../helpers/rendererModule');
const { encodeQr, formatBits, versionBits, reedSolomon, qrModuleDark, QR_LIMITS } = load('src/lib/qr/qrEncode.ts');

// "http://192.168.1.23:4321/": version 2, mask 2, as decoded back by CIDetector.
const GOLDEN = [
  '1111111000010010001111111',
  '1000001001111101001000001',
  '1011101011101000101011101',
  '1011101010100100001011101',
  '1011101011011010001011101',
  '1000001010010101101000001',
  '1111111010101010101111111',
  '0000000011000011000000000',
  '1011111000100101101111100',
  '1111100010001110010000010',
  '1000111000100101001101011',
  '0110110100001000100010001',
  '1110001111101100001110111',
  '1010010011000010000001010',
  '1001111011011011010101011',
  '1011010110010001000001001',
  '1000001001111100111110100',
  '0000000011001010100011100',
  '1111111000100100101011111',
  '1000001011110011100011011',
  '1011101010111101111111100',
  '1011101011011011101110111',
  '1011101011000100010000101',
  '1000001000001000101111001',
  '1111111011100101011111111',
];

const rowsOf = (code) => {
  const rows = [];
  for (let y = 0; y < code.size; y++) {
    let row = '';
    for (let x = 0; x < code.size; x++) {
      row += qrModuleDark(code, x, y) ? '1' : '0';
    }
    rows.push(row);
  }
  return rows;
};

test("Reed-Solomon matches the standard's HELLO WORLD 1-M example", () => {
  const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
  assert.deepEqual([...reedSolomon(data, 10)], [196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
  assert.throws(() => reedSolomon(data, 0), /at least one codeword/);
  assert.throws(() => reedSolomon([256], 10), /data are bytes/);
});

test('format bits match the level M table for every mask, and a ninth mask is refused', () => {
  const table = [
    '101010000010010',
    '101000100100101',
    '101111001111100',
    '101101101001011',
    '100010111111001',
    '100000011001110',
    '100111110010111',
    '100101010100000',
  ];
  table.forEach((bits, mask) => assert.equal(formatBits(mask).toString(2).padStart(15, '0'), bits, `mask ${mask}`));
  assert.throws(() => formatBits(8), /the mask is 0 to 7/);
  assert.throws(() => formatBits(-1), /the mask is 0 to 7/);
  assert.throws(() => formatBits(1.5), /the mask is an integer/);
});

test('version bits match the standard for versions 7 and 10, and do not exist below 7', () => {
  assert.equal(versionBits(7).toString(2).padStart(18, '0'), '000111110010010100');
  assert.equal(versionBits(10).toString(2).padStart(18, '0'), '001010010011010011');
  assert.throws(() => versionBits(6), /versions 7 and up/);
});

test('an address encodes to the golden matrix', () => {
  const code = encodeQr('http://192.168.1.23:4321/');
  assert.equal(code.version, 2);
  assert.equal(code.size, 25);
  assert.equal(code.mask, 2);
  assert.deepEqual(rowsOf(code), GOLDEN);
});

test('every version keeps its finders, timing lines and dark module', () => {
  // A length that needs each version in turn: version N holds these many bytes at level M.
  const capacities = [14, 26, 42, 62, 84, 106, 122, 152, 180, 213];
  capacities.forEach((bytes, index) => {
    const version = index + 1;
    const fits = encodeQr('a'.repeat(bytes));
    assert.equal(fits.version, version, `${bytes} bytes fit version ${version}`);
    assert.equal(fits.size, version * 4 + 17);
    assert.equal(fits.modules.length, fits.size * fits.size);
    if (version < QR_LIMITS.versionMax) {
      assert.equal(encodeQr('a'.repeat(bytes + 1)).version, version + 1, `one byte more needs version ${version + 1}`);
    }
    const finder = (left, top) => {
      for (let y = 0; y < 7; y++) {
        for (let x = 0; x < 7; x++) {
          const ring = Math.max(Math.abs(x - 3), Math.abs(y - 3));
          assert.equal(qrModuleDark(fits, left + x, top + y), ring !== 2, `finder module ${x},${y} of version ${version}`);
        }
      }
    };
    finder(0, 0);
    finder(fits.size - 7, 0);
    finder(0, fits.size - 7);
    for (let i = 8; i < fits.size - 8; i++) {
      assert.equal(qrModuleDark(fits, i, 6), i % 2 === 0, 'the horizontal timing line alternates');
      assert.equal(qrModuleDark(fits, 6, i), i % 2 === 0, 'the vertical timing line alternates');
    }
    assert.equal(qrModuleDark(fits, 8, fits.size - 8), true, 'the dark module');
    assert.equal(qrModuleDark(fits, -1, 0), false, 'the quiet zone is light');
    assert.equal(qrModuleDark(fits, fits.size, 0), false, 'the quiet zone is light');
  });
});

test('text longer than version 10 holds has no code; non-ASCII text counts its UTF-8 bytes', () => {
  assert.equal(encodeQr('a'.repeat(QR_LIMITS.bytesMax + 1)), undefined);
  assert.equal(encodeQr('é'.repeat(107)), undefined, '214 bytes');
  assert.equal(encodeQr('é'.repeat(106)).version, 10, '212 bytes');
  assert.equal(encodeQr('').version, 1, 'an empty text is still a code');
});
