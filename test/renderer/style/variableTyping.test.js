// Goal: the rules behind the variable chooser's newer gestures hold at their
// edges. Typing `var(`, `var(--`, `--` or a partial name finds the fragment a
// pick replaces; picking over a selection replaces exactly what was selected
// (widened over any variable it cuts into); a pressed chip swaps that chip and
// no other; offsets convert between the serialized value and the field, where a
// chip is one character; and the token field's own undo history groups typing,
// stays bounded, and walks back and forward.
// Method: pure functions driven with tables of valid input, then the negative
// space: boundaries that are names rather than references, out-of-range
// offsets, and the assertions that pin each precondition.
const assert = require('node:assert/strict');
const load = require('../../helpers/rendererModule');
const { typedVariableAt, completeTypedVariable, replaceVariableAt, fieldOffsetOf } = load('src/features/style/model/typedVariable.ts');
const { insertBindingAt } = load('src/features/style/model/insertBinding.ts');
const history = load('src/features/style/tokenFieldHistory.ts');

let checked = 0;
const equal = (actual, expected, message) => {
  assert.deepEqual(actual, expected, message);
  checked++;
};

// Typing a reference.
const typed = (text, caret = text.length) => typedVariableAt(text, caret);
equal(typed('var('), { start: 0, end: 4, query: '' }, 'var( at the start');
equal(typed('var()', 4), { start: 0, end: 5, query: '' }, 'the paired ) is taken too');
equal(typed('calc(var(--br', 13), { start: 5, end: 13, query: 'br' }, 'a partial name inside calc');
equal(typed('calc(var(--br) + 1rem)', 13), { start: 5, end: 14, query: 'br' }, 'a paired ) after the name');
equal(typed('2rem --'), { start: 5, end: 7, query: '' }, 'a bare -- after a space');
equal(typed('--Brand-1'), { start: 0, end: 9, query: 'brand-1' }, 'the query is lower case');
equal(typed('calc(var(--brand) + 1rem)', 12), { start: 5, end: 17, query: 'brand' }, 'a caret mid-name replaces the whole name');
equal(typed('--a)', 3), { start: 0, end: 3, query: 'a' }, 'a bare name never takes a )');
equal(typed('my-var('), undefined, 'part of a longer name is not a reference');
equal(typed('a--b'), undefined, '-- inside a name is not one');
equal(typed('2rem'), undefined, 'plain text is not one');
equal(typed('var(--a)'), undefined, 'a finished reference is not being typed');
equal(typed('var(', 9), undefined, 'a caret past the end finds nothing');
assert.throws(() => typedVariableAt('var(', -1), /typedVariableAt: the caret is not before the value/);
assert.throws(() => typedVariableAt('var(', 1.5), /typedVariableAt: the caret is a whole offset/);
checked += 2;

const fragment = typed('calc(var(--br) + 1rem)', 13);
equal(
  completeTypedVariable('calc(var(--br) + 1rem)', fragment, 'var(--brand)'),
  { value: 'calc(var(--brand) + 1rem)', caret: 17 },
  'completion keeps the rest',
);
assert.throws(() => completeTypedVariable('ab', { start: 2, end: 1, query: '' }, 'x'), /does not end before it starts/);
checked++;

// Picking over a selection.
equal(insertBindingAt('calc(2rem + 1rem)', 'var(--h3)', { start: 5, end: 9 }), 'calc(var(--h3) + 1rem)', 'the selected 2rem is replaced');
equal(
  insertBindingAt('calc(var(--a) + 1rem)', 'var(--h3)', { start: 7, end: 17 }),
  'calc(var(--h3)rem)',
  'a selection cutting into a variable takes all of it',
);
equal(insertBindingAt('calc(2rem + 1rem)', 'var(--h3)', { start: 9, end: 9 }), 'calc(2remvar(--h3) + 1rem)', 'a caret inserts');
equal(insertBindingAt('2rem', 'var(--h3)', { start: 0, end: 4 }), 'var(--h3)', 'the whole plain value selected');
equal(insertBindingAt('2rem', 'var(--h3)', undefined), 'var(--h3)', 'no selection known: a plain value is replaced');
equal(insertBindingAt('ab', 'x', { start: 1, end: 99 }), 'ax', 'a selection past the end is clamped');
assert.throws(() => insertBindingAt('ab', 'x', { start: 2, end: 1 }), /insertBindingAt: the selection does not end before it starts/);
checked++;

// Swapping a pressed chip.
equal(replaceVariableAt('calc(var(--a) + var(--b))', 1, 'var(--c)'), 'calc(var(--a) + var(--c))', 'the second chip only');
equal(replaceVariableAt('calc(var(--a) + var(--b))', 0, 'var(--c)'), 'calc(var(--c) + var(--b))', 'the first chip only');
equal(replaceVariableAt('brand/primary', 0, 'var(--c)'), 'var(--c)', 'a native binding is the whole value');
equal(replaceVariableAt('var(--a)', 3, 'var(--c)'), 'var(--a)', 'a chip that is not there changes nothing');
assert.throws(() => replaceVariableAt('var(--a)', -1, 'x'), /replaceVariableAt: the chip index is not negative/);
checked++;

// Offsets: a chip is one character in the field.
equal(fieldOffsetOf('calc(var(--brand) + 1rem)', 17), 6, 'just after the chip');
equal(fieldOffsetOf('calc(var(--brand) + 1rem)', 5), 5, 'before the chip nothing moves');
equal(fieldOffsetOf('calc(var(--brand) + 1rem)', 25), 14, 'the end');
equal(fieldOffsetOf('calc(var(--brand) + 1rem)', 10), 6, 'inside a reference lands after its chip');
assert.throws(() => fieldOffsetOf('ab', 3), /fieldOffsetOf: the offset lies inside the value/);
checked++;

// The token field's own history.
const snap = (text, caret = text.length) => ({ text, chips: [], caret });
let state = history.EMPTY_FIELD_HISTORY;
state = history.recordEdit(state, snap(''), { kind: 'insertText', atMs: 0, grouped: true });
state = history.recordEdit(state, snap('a'), { kind: 'insertText', atMs: 200, grouped: true });
state = history.recordEdit(state, snap('ab'), { kind: 'insertText', atMs: 400, grouped: true });
equal(state.past.length, 1, 'a quick run of typing is one step');
state = history.recordEdit(state, snap('abc'), { kind: 'insertText', atMs: 400 + history.TYPING_RUN_MS + 1, grouped: true });
equal(state.past.length, 2, 'a pause starts a new step');
state = history.recordEdit(state, snap('abcd'), { kind: 'key:(', atMs: 3000, grouped: false });
equal(state.past.length, 3, 'a bracket pair is its own step');
const back = history.undoStep(state, snap('abcd()'));
equal(back.show, snap('abcd'), 'undo shows the state before the last step');
equal(back.history.future, [snap('abcd()')], 'and keeps the current one to redo');
const forward = history.redoStep(back.history, back.show);
equal(forward.show, snap('abcd()'), 'redo comes back');
equal(history.undoStep(history.EMPTY_FIELD_HISTORY, snap('x')), undefined, 'nothing to undo');
equal(history.redoStep(history.EMPTY_FIELD_HISTORY, snap('x')), undefined, 'nothing to redo');
const cleared = history.recordEdit(back.history, snap('abcd'), { kind: 'insertText', atMs: 9000, grouped: true });
equal(cleared.future, [], 'a new edit clears redo');
let long = history.EMPTY_FIELD_HISTORY;
for (let index = 0; index < history.FIELD_HISTORY_STEPS_MAX + 20; index++) {
  long = history.recordEdit(long, snap(String(index)), { kind: 'replace', atMs: index, grouped: false });
}
equal(long.past.length, history.FIELD_HISTORY_STEPS_MAX, 'the history is bounded');
equal(long.past[0].text, '20', 'the oldest steps go first');

console.log(`variable-typing: ${checked} passed`);
