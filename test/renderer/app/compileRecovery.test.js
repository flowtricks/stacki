// Goal: a page that stops compiling right after an edit gets a notice that carries the
// compiler's own words (file and line included) and offers to undo, and only then: a healthy
// page, a failure with no message, and a failure long after the last edit say nothing.
// Method: the pure rules over generated health verdicts, at the edges of the time window and the
// message bound.
const test = require('node:test');
const assert = require('node:assert/strict');
const { compileFailureMessage, failureFollowsEdit, COMPILE_RECOVERY_LIMITS } = require('../../helpers/rendererModule')('src/app/model/compileRecovery.ts');

const health = (kind, thrown) => ({ kind, status: 500, thrown, logTail: '' });

test('the compiler message keeps its first lines, which name the file and line', () => {
  const thrown =
    'CompilerError: Unexpected token\n  at /p/src/pages/index.astro:12:4\n  12 | <!doctype html>\n  at runInRunnerObject\n  at getComponentByRoute';
  assert.equal(
    compileFailureMessage(health('error-overlay', thrown)),
    'CompilerError: Unexpected token · at /p/src/pages/index.astro:12:4 · 12 | <!doctype html>',
  );
});

test('a healthy page, or a failure that says nothing, has no message', () => {
  assert.equal(compileFailureMessage(health('ok', undefined)), undefined);
  assert.equal(compileFailureMessage(health('ok', 'CompilerError: x')), undefined);
  assert.equal(compileFailureMessage(health('server-error', undefined)), undefined);
  assert.equal(compileFailureMessage(health('server-error', '  \n ')), undefined);
});

test('a long message is cut at its bound with an ellipsis', () => {
  const message = compileFailureMessage(health('server-error', 'x'.repeat(COMPILE_RECOVERY_LIMITS.messageCharsMax + 50)));
  assert.equal(message.length, COMPILE_RECOVERY_LIMITS.messageCharsMax);
  assert.ok(message.endsWith('…'));
});

test('only a failure shortly after the app’s own write is offered the undo', () => {
  const limit = COMPILE_RECOVERY_LIMITS.afterEditMsMax;
  assert.equal(failureFollowsEdit(1000, 1000), true);
  assert.equal(failureFollowsEdit(1000, 1000 + limit), true);
  assert.equal(failureFollowsEdit(1000, 1000 + limit + 1), false);
  assert.equal(failureFollowsEdit(1000, 999), false, 'a failure before the write is not its doing');
  assert.equal(failureFollowsEdit(-Infinity, 5), false, 'no write yet');
  assert.throws(() => failureFollowsEdit(0, Number.NaN), /clock reads a number/);
});
