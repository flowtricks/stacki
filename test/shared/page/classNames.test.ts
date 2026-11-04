// Goal: the class field suggests every class a project uses, not only styled
// ones: classes written in markup, added or queried by scripts, and styled by
// stylesheets. Method: read each way a class is written, then the negative
// space (dots that are not classes, template holes, words that are not class
// names) and the bounds.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLASS_NAMES_PER_SOURCE_MAX, classNamesIn, classSourceKind } from '#dist/shared/page/classNames.js';

test('markup classes: attributes, expressions and class:list', () => {
  const page = [
    '<p class="faq_description  is-open">a</p>',
    "<div className='card'></div>",
    '<li class={`item ${active ? "item--on" : ""}`}></li>',
    "<a class:list={['link', { 'is-current': here, visited: seen }]}></a>",
  ].join('\n');
  assert.deepEqual([...classNamesIn(page, 'markup')].sort(), ['card', 'faq_description', 'is-current', 'is-open', 'item', 'item--on', 'link', 'visited']);
});

test('script classes: classList, className and selector strings', () => {
  const script = [
    "button.classList.toggle('is-open');",
    'el.classList.add("a", "b");',
    "el.className = 'menu menu--dark';",
    "document.querySelectorAll('.faq_item > .faq_summary');",
    "el.closest('nav.site_nav');",
  ].join('\n');
  assert.deepEqual([...classNamesIn(script, 'script')].sort(), ['a', 'b', 'faq_item', 'faq_summary', 'is-open', 'menu', 'menu--dark', 'site_nav']);
});

test('stylesheet and <style> classes, but no dots that are not classes', () => {
  const css =
    ".faq_summary { & > .icon { color: red } }\nsummary.faq_detail:is(.open) { background: url(image.png); font-size: 1.5rem; content: 'x.y'; } /* .old */";
  assert.deepEqual([...classNamesIn(css, 'stylesheet')].sort(), ['faq_detail', 'faq_summary', 'icon', 'open']);
  assert.deepEqual(classNamesIn(`<style>${css}</style><p class="x"></p>`, 'markup').includes('icon'), true);
});

test('only class names, once each, and a bounded number of them', () => {
  assert.deepEqual(classNamesIn('<p class="a a 9bad {x} b"></p>', 'markup'), ['a', 'b']);
  const many = Array.from({ length: CLASS_NAMES_PER_SOURCE_MAX + 5 }, (_, index) => `c${index}`).join(' ');
  assert.equal(classNamesIn(`<p class="${many}"></p>`, 'markup').length, CLASS_NAMES_PER_SOURCE_MAX);
  assert.equal(classSourceKind('a.astro'), 'markup');
  assert.equal(classSourceKind('a.scss'), 'stylesheet');
  assert.equal(classSourceKind('a.ts'), 'script');
  assert.equal(classSourceKind('a.json'), undefined);
});
