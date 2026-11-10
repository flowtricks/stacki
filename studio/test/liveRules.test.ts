// Goal: a Style panel edit reaches the matching rule in the canvas's loaded stylesheets, and
// nothing else: the message is parsed strictly, selectors compare without Astro's scoping,
// @media/@supports/@container must match while @layer is ignored, and a window that lacks a
// rule class still works.
// Method: the pure helpers directly; applyLiveRule against a small stand-in CSSOM whose rule
// classes come from a stand-in window, as the canvas frame's come from its own window.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyLiveRule, normalizeAtRule, normalizeSelector, parseLiveRule, type LiveRule } from '../src/features/preview/liveRules';

class RuleList extends Array<unknown> {}
class StyleRule {
  readonly values = new Map<string, { value: string; priority: string }>();
  readonly style = {
    setProperty: (prop: string, value: string, priority: string) => {
      this.values.set(prop, { value, priority });
    },
  };
  constructor(readonly selectorText: string) {}
}
class MediaRule {
  readonly cssRules: RuleList;
  readonly media: { readonly mediaText: string };
  constructor(mediaText: string, rules: readonly unknown[]) {
    this.media = { mediaText };
    this.cssRules = RuleList.from(rules);
  }
}
class SupportsRule {
  readonly cssRules: RuleList;
  constructor(
    readonly conditionText: string,
    rules: readonly unknown[],
  ) {
    this.cssRules = RuleList.from(rules);
  }
}
class LayerRule {
  readonly cssRules: RuleList;
  constructor(
    readonly name: string,
    rules: readonly unknown[],
  ) {
    this.cssRules = RuleList.from(rules);
  }
}

// A document whose stylesheets hold `rules`; `layers: false` is a window without CSSLayerBlockRule.
function documentWith(rules: readonly unknown[], { layers = true }: { readonly layers?: boolean } = {}): Document {
  const view = {
    CSSStyleRule: StyleRule,
    CSSMediaRule: MediaRule,
    CSSSupportsRule: SupportsRule,
    CSSContainerRule: undefined,
    CSSLayerBlockRule: layers ? LayerRule : undefined,
    CSSRuleList: RuleList,
  };
  // The stand-in covers only what applyLiveRule reads.
  return { defaultView: view, styleSheets: [{ cssRules: RuleList.from(rules) }] } as unknown as Document;
}

// An edit of `.title`'s font-size to 21px, with the fields a test changes.
const edit = (change: {
  readonly selector?: string;
  readonly atContext?: readonly string[];
  readonly value?: string;
  readonly important?: boolean;
}): LiveRule => ({ selector: '.title', atContext: [], prop: 'font-size', value: '21px', important: false, ...change });

test('a live rule message is parsed strictly', () => {
  const message = { type: 'studio:live-rule', selector: '.title', atContext: ['@media (max-width: 767px)'], prop: 'font-size', value: '21px', important: true };
  assert.deepEqual(parseLiveRule(message), { selector: '.title', atContext: ['@media (max-width: 767px)'], prop: 'font-size', value: '21px', important: true });
  assert.equal(parseLiveRule({ ...message, prop: '--accent' })?.prop, '--accent');
  assert.equal(parseLiveRule({ ...message, important: 'yes' })?.important, false);
  assert.equal(parseLiveRule({ ...message, type: 'studio:live-styles' }), undefined);
  assert.equal(parseLiveRule({ ...message, prop: 'font-size; color' }), undefined);
  assert.equal(parseLiveRule({ ...message, selector: '' }), undefined);
  assert.equal(parseLiveRule({ ...message, atContext: '@media print' }), undefined);
  assert.equal(parseLiveRule({ ...message, atContext: Array.from({ length: 9 }, () => '@media print') }), undefined);
  assert.equal(parseLiveRule('studio:live-rule'), undefined);
});

test('selectors and at-rules compare without scoping or spacing differences', () => {
  assert.equal(normalizeSelector('.card[data-astro-cid-abc123] > .title[data-astro-cid-abc123]'), '.card>.title');
  assert.equal(normalizeSelector('.card:where(.astro-xyz)  .title'), '.card .title');
  assert.equal(normalizeSelector('.a ,  .b'), '.a,.b');
  assert.equal(normalizeAtRule('@media ( max-width: 767px )'), normalizeAtRule('@media (max-width:767px)'));
  assert.equal(normalizeAtRule('@MEDIA print'), '@mediaprint');
});

test('the edit lands on the rule with the same selector and conditions, and nowhere else', () => {
  const top = new StyleRule('.title[data-astro-cid-abc123]');
  const other = new StyleRule('.subtitle');
  const phone = new StyleRule('.title');
  const document = documentWith([top, other, new MediaRule('(max-width: 767px)', [phone])]);

  assert.equal(applyLiveRule(document, edit({})), 1);
  assert.deepEqual(top.values.get('font-size'), { value: '21px', priority: '' });
  assert.equal(other.values.size, 0);
  assert.equal(phone.values.size, 0);

  assert.equal(applyLiveRule(document, edit({ atContext: ['@media (max-width:767px)'], value: '18px', important: true })), 1);
  assert.deepEqual(phone.values.get('font-size'), { value: '18px', priority: 'important' });
  assert.equal(top.values.get('font-size')?.value, '21px');

  assert.equal(applyLiveRule(document, edit({ atContext: ['@media print'] })), 0);
  assert.equal(applyLiveRule(document, edit({ selector: '.missing' })), 0);
});

test('@supports must match, @layer is ignored, and a window without a rule class still works', () => {
  const layered = new StyleRule('.title');
  const supported = new StyleRule('.title');
  const rules = [new LayerRule('base', [layered]), new SupportsRule('(display: grid)', [supported])];

  // The panel may leave layers out of the context; they don't change what a rule matches.
  assert.equal(applyLiveRule(documentWith(rules), edit({})), 1);
  assert.equal(layered.values.get('font-size')?.value, '21px');
  assert.equal(applyLiveRule(documentWith(rules), edit({ atContext: ['@layer base'], value: '22px' })), 1);
  assert.equal(layered.values.get('font-size')?.value, '22px');
  assert.equal(applyLiveRule(documentWith(rules), edit({ atContext: ['@supports (display:grid)'], value: '23px' })), 1);
  assert.equal(supported.values.get('font-size')?.value, '23px');

  // Without CSSLayerBlockRule, nothing inside the layer is visited, and nothing breaks.
  assert.equal(applyLiveRule(documentWith(rules, { layers: false }), edit({ value: '24px' })), 0);
  assert.equal(layered.values.get('font-size')?.value, '22px');
});

test('a document without a window patches nothing', () => {
  assert.equal(applyLiveRule({ defaultView: null, styleSheets: [] } as unknown as Document, edit({})), 0);
});
