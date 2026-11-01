// Goal: saved window geometry and mode are safe to restore; optional storage cannot block editing.
// Method: round-trip the real storage helpers, reject malformed and oversized inputs,
// and restore a saved rectangle against smaller viewport and minimum-size bounds.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const load = require('../../helpers/rendererModule');
const { parseStoredWindowRectangle, readWindowRectangle, storeWindowRectangle, readWindowMode, storeWindowMode } = load('src/ui/windowPreferences.ts');
const viewport = { width: 1440, height: 900 };
const minimum = { width: 560, height: 280 };
const rectangle = { x: 80, y: 70, width: 720, height: 500 };

test('stored geometry validates every field and rejects malformed boundaries', () => {
  assert.deepEqual(parseStoredWindowRectangle(JSON.stringify(rectangle)), rectangle);
  for (const raw of [undefined, 42, '', '{', 'null', '[]', '{}', 'x'.repeat(257)]) {
    assert.equal(parseStoredWindowRectangle(raw), undefined);
  }
  for (const field of ['x', 'y', 'width', 'height']) {
    for (const value of ['10', -1, 1.5, 100001, undefined]) {
      assert.equal(parseStoredWindowRectangle(JSON.stringify({ ...rectangle, [field]: value })), undefined);
    }
  }
  assert.equal(parseStoredWindowRectangle(JSON.stringify({ ...rectangle, width: 0 })), undefined);
  assert.equal(parseStoredWindowRectangle(JSON.stringify({ ...rectangle, height: 0 })), undefined);
});

test('restore keeps saved placement, fits smaller screens, and centers when storage fails', () => {
  const values = new Map();
  const previous = Object.getOwnPropertyDescriptor(global, 'localStorage');
  Object.defineProperty(global, 'localStorage', {
    configurable: true,
    writable: true,
    value: {
      getItem: (key) => values.get(key),
      setItem: (key, value) => values.set(key, value),
    },
  });
  try {
    storeWindowRectangle('variables', rectangle);
    assert.deepEqual(readWindowRectangle('variables', viewport, minimum), rectangle);
    const fitted = readWindowRectangle('variables', { width: 400, height: 320 }, minimum);
    assert.ok(fitted.x + fitted.width <= 400);
    assert.ok(fitted.y + fitted.height <= 320);
    assert.ok(fitted.x >= 0);
    assert.ok(fitted.y >= 42);
    values.set('variables', '{bad');
    const centered = readWindowRectangle('variables', viewport, minimum);
    assert.ok(Math.abs(centered.x * 2 + centered.width - viewport.width) <= 1);
    assert.ok(Math.abs(centered.y * 2 + centered.height - viewport.height) <= 1);
    global.localStorage = {
      getItem: () => {
        throw new Error('Storage unavailable');
      },
      setItem: () => {
        throw new Error('Storage unavailable');
      },
    };
    assert.deepEqual(readWindowRectangle('variables', viewport, minimum), centered);
    assert.doesNotThrow(() => storeWindowRectangle('variables', rectangle));
  } finally {
    if (previous) {
      Object.defineProperty(global, 'localStorage', previous);
    } else {
      delete global.localStorage;
    }
  }
});

test('window mode restores only valid preferences without overwriting geometry', () => {
  const values = new Map([['variables', JSON.stringify(rectangle)]]);
  const previous = Object.getOwnPropertyDescriptor(global, 'localStorage');
  Object.defineProperty(global, 'localStorage', {
    configurable: true,
    writable: true,
    value: {
      getItem: (key) => values.get(key),
      setItem: (key, value) => values.set(key, value),
    },
  });
  try {
    assert.equal(readWindowMode('variables.mode'), 'floating');
    for (const mode of ['docked', 'floating', 'docked']) {
      storeWindowMode('variables.mode', mode);
      assert.equal(readWindowMode('variables.mode'), mode);
      assert.equal(values.get('variables.mode'), mode);
      assert.deepEqual(readWindowRectangle('variables', viewport, minimum), rectangle);
    }
    for (const invalid of [undefined, 42, '', 'DOCKED', '"docked"', '{}', 'x'.repeat(257)]) {
      values.set('variables.mode', invalid);
      assert.equal(readWindowMode('variables.mode'), 'floating');
    }
    global.localStorage = {
      getItem: () => {
        throw new Error('Storage unavailable');
      },
      setItem: () => {
        throw new Error('Storage unavailable');
      },
    };
    assert.equal(readWindowMode('variables.mode'), 'floating');
    assert.doesNotThrow(() => storeWindowMode('variables.mode', 'docked'));
  } finally {
    if (previous) {
      Object.defineProperty(global, 'localStorage', previous);
    } else {
      delete global.localStorage;
    }
  }
});
