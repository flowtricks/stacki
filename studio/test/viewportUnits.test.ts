// Goal: freeze viewport dimensions without corrupting other CSS values.
// Method: cover every height unit, nested calculations, literals, repeated passes,
// and invalid values at the parent-message boundary. Browser tests cover layout.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  freezeViewportValue,
  parseViewportHeight,
} from '../vendor/stacki/electron/preload/frameViewportUnits';

test('viewport dimensions become fixed calculations and stay idempotent', () => {
  for (const unit of ['vh', 'svh', 'lvh', 'dvh', 'VH']) {
    const frozen = freezeViewportValue(`clamp(20px, calc(100${unit} - 4rem), 200${unit})`);
    assert.equal(
      frozen,
      'clamp(20px, calc(calc(100 * var(--avb-vh)) - 4rem), calc(200 * var(--avb-vh)))',
    );
    assert.equal(freezeViewportValue(frozen), frozen);
  }
  assert.equal(
    freezeViewportValue('-.5vh 1e2vh'),
    'calc(-.5 * var(--avb-vh)) calc(1e2 * var(--avb-vh))',
  );
});

test('viewport freezing preserves strings, URLs and custom property names', () => {
  const value = '"100vh" \'50svh\' url(/100vh.svg) var(--space-100vh) 100vw';
  assert.equal(freezeViewportValue(value), value);
});

test('viewport height messages accept only bounded positive finite numbers', () => {
  for (const height of [812, 900, 1024, 30_000]) {
    assert.equal(parseViewportHeight(height), height);
  }
  for (const invalid of [undefined, null, '900', {}, 0, -1, NaN, Infinity, 30_001]) {
    assert.equal(parseViewportHeight(invalid), undefined);
  }
});
