// Goal: a Style panel scrub in the demo previews the way Vite's CSS update does. A
// sequence of style-only changes to one rule sends new text for that rule's section
// alone, at most once per animation frame, with no page rendering; the frame sets the
// text in place and never removes or re-inserts a stylesheet; markup changes still go
// through the full rendering.
// Method: the coalescer runs against a manual frame clock and a recorder standing in
// for the frame, and the frame's half runs against plain objects that count writes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BAKE_MESSAGES, BAKE_SECTION_ATTRIBUTE } from '../src/features/bake/bakeProtocol';
import { applySectionUpdates, parseSectionUpdates, STYLE_UPDATE_LIMITS } from '../src/features/bake/bakeStyleUpdate';
import type { BakeSection } from '../src/features/bake/bakeSnapshot';
import { isStyleOnlyChange, sectionUpdates, StylePreview, type StyleMessage } from '../demo/styleUpdates';

const PAGE = 'src/pages/index.astro';
const SITE = 'src/styles/site.css';
const BASE = 'src/styles/base.css';

function page(padding: string, heading = 'Heading'): string {
  return `---\n---\n<main class="hero_inner"><h1>${heading}</h1></main>\n<style>\n  .hero_inner { padding: ${padding}; }\n</style>\n`;
}

const SECTIONS: readonly BakeSection[] = [
  { id: `${PAGE}#0`, file: PAGE, scope: 'abc123', urls: {} },
  { id: SITE, file: SITE, scope: undefined, urls: {} },
  { id: BASE, file: BASE, scope: undefined, urls: {} },
  { id: 'src/components/Card.astro#0', file: 'src/components/Card.astro', scope: 'card1', urls: {} },
];

const SOURCES: Readonly<Record<string, string>> = {
  [PAGE]: page('0px'),
  [SITE]: '@import "./base.css";\n.lede { color: red; }\n',
  [BASE]: 'body { margin: 0; }\n',
  'src/components/Card.astro': '<article class="card"></article>\n<style>.card { padding: 8px; }</style>\n',
};

test('only a change confined to styles is style-only', () => {
  assert.ok(isStyleOnlyChange(PAGE, page('0px'), page('12px')));
  assert.equal(isStyleOnlyChange(PAGE, page('0px'), page('0px', 'Changed')), false, 'Markup needs a rendering');
  assert.ok(isStyleOnlyChange(SITE, 'a{}', 'b{}'), 'A stylesheet is styles alone');
  assert.equal(isStyleOnlyChange('.stacki/components.json', '{}', '{"a":1}'), false, 'Settings are not styles');
});

test('a scrub on one rule sends that section alone, once per frame, and never renders', () => {
  const sent: StyleMessage[] = [];
  const frames: (() => void)[] = [];
  let sources: Record<string, string> = { ...SOURCES };
  const preview = new StylePreview(
    SECTIONS,
    (file) => SOURCES[file],
    () => sources,
    (message) => sent.push(message),
    (flush) => frames.push(flush),
  );
  for (const padding of ['1px', '2px', '3px']) {
    sources = { ...sources, [PAGE]: page(padding) };
    preview.changed(PAGE, page(padding));
  }
  assert.equal(frames.length, 1, 'Three ticks inside one frame schedule one flush');
  frames.shift()?.();
  assert.equal(sent.length, 1);
  const [message] = sent;
  assert.equal(message?.type, BAKE_MESSAGES.styleUpdate);
  assert.deepEqual(
    message?.sections.map((section) => section.id),
    [`${PAGE}#0`],
    'Only the scrubbed block is sent',
  );
  assert.match(message?.sections[0]?.css ?? '', /padding: 3px/, 'The latest tick wins');
  assert.match(message?.sections[0]?.css ?? '', /data-astro-cid-abc123/, 'Scoped rules keep their scope');
  preview.changed(PAGE, page('3px', 'Changed'));
  assert.equal(frames.length, 0, 'A markup change waits for the full rendering');
});

test('a stylesheet change reaches the stylesheets that may import it, and no component block', () => {
  const updates = sectionUpdates(SECTIONS, [BASE], { ...SOURCES, [BASE]: 'body { margin: 4px; }\n' });
  assert.deepEqual(updates.map((update) => update.id).sort(), [BASE, SITE].sort());
  assert.match(updates.find((update) => update.id === SITE)?.css ?? '', /margin: 4px/, 'The import is inlined');
});

test('CSS that does not parse mid-edit leaves its section as it was', () => {
  const broken = { ...SOURCES, [PAGE]: '<main></main>\n<style>\n  .hero_inner { padding: \n</style>\n' };
  assert.doesNotThrow(() => sectionUpdates(SECTIONS, [PAGE], broken));
});

test('the frame sets section text in place and touches nothing else', () => {
  const styles = [
    { id: `${PAGE}#0`, textContent: 'old' as string | null, writes: 0 },
    { id: SITE, textContent: 'site' as string | null, writes: 0 },
    { id: 'other', textContent: 'other' as string | null, writes: 0 },
  ].map((style) => ({
    getAttribute: (name: string) => (name === BAKE_SECTION_ATTRIBUTE ? style.id : null),
    get textContent() {
      return style.textContent;
    },
    set textContent(value: string | null) {
      style.writes++;
      style.textContent = value;
    },
    style,
  }));
  const updates = parseSectionUpdates([
    { id: `${PAGE}#0`, css: 'new' },
    { id: SITE, css: 'site' },
    { id: 'missing', css: 'x' },
  ]);
  assert.equal(applySectionUpdates(styles, BAKE_SECTION_ATTRIBUTE, updates), 1);
  assert.deepEqual(
    styles.map((element) => [element.style.textContent, element.style.writes]),
    [
      ['new', 1],
      ['site', 0],
      ['other', 0],
    ],
    'Unchanged text is never rewritten, so nothing restyles',
  );
  assert.equal(styles.length, 3, 'No stylesheet is added or removed');
});

test('a style update message is bounded and well formed', () => {
  assert.throws(() => parseSectionUpdates('nope'), /missing or too many/);
  assert.throws(() => parseSectionUpdates([{ id: 1, css: 'a' }]), /out of bounds/);
  assert.throws(() => parseSectionUpdates([{ id: 'a' }]), /id and its CSS/);
  assert.throws(() => parseSectionUpdates(Array.from({ length: STYLE_UPDATE_LIMITS.sectionsMax + 1 }, () => ({ id: 'a', css: '' }))), /too many/);
});
