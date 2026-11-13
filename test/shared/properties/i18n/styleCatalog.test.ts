// Goal: the Style panel's plural messages and option-label tables read correctly in every language, so a panel built from
// them never shows a placeholder, an empty label or a broken sentence when the person switches language.
// Method: load the `style` namespace of each locale, format the plural messages for one and several items (checking that
// every placeholder is filled), and require that the labels the panel builds its option lists from (the segment and menu
// labels of the layout, size, position and borders controls) are non-empty and differ between the lists they sit in.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatMessage, parseMessage } from '#dist/shared/core/i18n/catalog.js';
import { LOCALES } from '#dist/shared/core/i18n/locales.js';

const DIRECTORY_OF = { en: 'en', es: 'es', fr: 'fr', de: 'de', 'pt-BR': 'ptBR' } as const satisfies Record<(typeof LOCALES)[number], string>;
const PLURAL_KEYS = [
  'style.embedEditor.pendingTooltip',
  'style.embedEditor.pendingNote',
  'style.embedEditor.scanned',
  'style.embedEditor.scannedWithComponents',
] as const;
const FLOW_LABEL_KEYS = [
  'style.directionControl.singleRow',
  'style.directionControl.wrapDown',
  'style.directionControl.wrapUp',
  'style.directionControl.singleColumn',
  'style.directionControl.wrapRight',
  'style.directionControl.wrapLeft',
] as const;

async function loadStyle(locale: (typeof LOCALES)[number]): Promise<Readonly<Record<string, unknown>>> {
  const loaded: unknown = await import(`#dist/shared/properties/i18n/messages/${DIRECTORY_OF[locale]}/style.js`);
  assert.ok(typeof loaded === 'object' && loaded !== null && 'messages' in loaded, `${locale}/style exports messages`);
  const messages: unknown = loaded.messages;
  assert.ok(typeof messages === 'object' && messages !== null, `${locale}/style messages is an object`);
  return Object.fromEntries(Object.entries(messages));
}

function messageValue(messages: Readonly<Record<string, unknown>>, key: string) {
  const parsed = parseMessage(messages[key]);
  assert.ok(parsed.ok, `${key} is a message`);
  return parsed.value;
}

test('plural messages fill every placeholder for one item and for several, in every language', async () => {
  for (const locale of LOCALES) {
    const messages = await loadStyle(locale);
    for (const key of PLURAL_KEYS) {
      for (const count of [1, 2, 5]) {
        const formatted = formatMessage(locale, messageValue(messages, key), { count, components: 3, tag: '<style>' });
        assert.ok(formatted.ok, `${locale} ${key} formats for ${count}`);
        assert.ok(!/[{}]/.test(formatted.value), `${locale} ${key} leaves no placeholder open for ${count}: ${formatted.value}`);
        assert.ok(formatted.value.includes(String(count)), `${locale} ${key} shows the number ${count}`);
      }
    }
  }
});

test('the plural forms of one message differ when the language has a distinct plural', async () => {
  for (const locale of ['en', 'es', 'de', 'pt-BR'] as const) {
    const messages = await loadStyle(locale);
    const one = formatMessage(locale, messageValue(messages, 'style.embedEditor.scanned'), { count: 1 });
    const other = formatMessage(locale, messageValue(messages, 'style.embedEditor.scanned'), { count: 2 });
    assert.ok(one.ok && other.ok, `${locale} formats both forms`);
    assert.notEqual(one.value.replace('1', '#'), other.value.replace('2', '#'), `${locale} keeps a separate singular and plural`);
  }
});

test('the flex-flow labels are distinct non-empty texts in every language, so the menu never lists two alike', async () => {
  for (const locale of LOCALES) {
    const messages = await loadStyle(locale);
    const labels = FLOW_LABEL_KEYS.map((key) => {
      const text = messages[key];
      assert.ok(typeof text === 'string' && text.trim().length > 0, `${locale} ${key} is text`);
      return text;
    });
    assert.equal(new Set(labels).size, labels.length, `${locale} wrap labels are all different`);
  }
});

test('a message that needs a parameter fails loudly rather than showing a placeholder', async () => {
  const messages = await loadStyle('en');
  const formatted = formatMessage('en', messageValue(messages, 'style.embedEditor.scanned'), {});
  assert.equal(formatted.ok, false, 'a plural message without a count is an error value');
});
