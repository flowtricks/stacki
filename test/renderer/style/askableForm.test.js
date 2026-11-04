// Goal: every rule that styles an element is asked about, so it shows as one
// of the element's selectors. States (`:hover`, `:open`) and pseudo-elements
// (`::after`) are stripped before asking the page, which cannot match them on
// demand; where one was a whole compound it leaves `*`, never a dangling
// combinator. `:open > &::after` nested in `.faq_summary` was never shown.
// Method: askableForm on each shape, the reported one first, then what must
// still be refused.
const assert = require('node:assert/strict');
const load = require('../../helpers/rendererModule');
const { askableForm } = load('src/features/style/model/canvasAsk.ts');

assert.equal(askableForm(':open > .faq_summary::after'), '* > .faq_summary');
assert.equal(askableForm('details:open > .faq_summary::after'), 'details > .faq_summary');
assert.equal(askableForm('.faq_summary:hover::after'), '.faq_summary');
assert.equal(askableForm('.list :hover'), '.list *');
assert.equal(askableForm(':hover:focus-visible > .a'), '* > .a');
assert.equal(askableForm('.a:focus-visible'), '.a', 'a longer name is not cut at a shorter one');
assert.equal(askableForm(':is(:hover, .b) .c'), ':is(*, .b) .c');
assert.equal(askableForm('.card'), '.card');
// What is left must still be a selector about the element.
assert.equal(askableForm(':hover'), undefined, 'a bare state asks about every element');
assert.equal(askableForm('::before'), undefined);
assert.equal(askableForm(':hover > :focus'), undefined);
assert.equal(askableForm(''), undefined);
assert.equal(askableForm('.a >'), undefined);
console.log('askable form: ok');
