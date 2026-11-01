// Goal: the shipped document actor (shared/engine/documentActor.ts) reaches exactly one
// terminal outcome per accepted intent on every path of the §5.2 protocol, and
// each path is the one the plan names: backpressure at a full queue, the lock
// held by a cooperating writer, a replace that failed or landed without a
// durable directory, a verifying read that fails or sees another writer, and a
// stale intent whose authored bytes are gone. The seeded simulator reaches these
// paths at random; this suite pins each one by hand, with its outcome.
// Method: the fake disk, wrapped where a test needs a read to fail, and the
// simulator's projector (the real parser). Steps are driven one at a time so
// each phase transition is visible. `reconcileUncertain` is pinned as a table.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toFilePath, toIntentId, type Digest } from '#dist/shared/core/brand.js';
import {
  actorQuiescent,
  createActor,
  reconcileUncertain,
  stepActor,
  submitIntent,
  type ActorDependencies,
  type ActorState,
  type ActorStep,
  type DocumentDisk,
} from '#dist/shared/engine/documentActor.js';
import { toIntent, type Intent, type Outcome } from '#dist/shared/engine/intent.js';
import { diffCodePatch } from '#dist/shared/engine/codePatch.js';
import { createLazySnapshot } from '#dist/shared/page/snapshot.js';
import { LIMITS } from '#dist/shared/core/limits.js';
import { err } from '#dist/shared/core/result.js';
import { encodeUtf8, toByteSpan } from '#dist/shared/core/span.js';
import { SIMULATOR_PROJECTOR } from './candidate.ts';
import { planEngine } from './enginePlanner.ts';
import { FakeDisk } from './fakeDisk.ts';
import { sha256 } from './project.ts';

const PAGE = toFilePath('/project/page.astro');
const TEXT = '<Hero title="Old" />\n';

function setup(disk: DocumentDisk = new FakeDisk()) {
  return { planner: planEngine, projector: SIMULATOR_PROJECTOR, disk };
}

function fakeWith(text: string): FakeDisk {
  const disk = new FakeDisk();
  disk.writeExternally(PAGE, encodeUtf8(text));
  return disk;
}

let intents = 0;
function rewriteIntent(authoredText: string, text: string): Intent {
  intents += 1;
  const length = encodeUtf8(authoredText).length;
  const patch = diffCodePatch(authoredText, text);
  assert.ok(patch.ok, 'the rewrite fits the bounds');
  return toIntent({
    id: toIntentId(`actor-test-${intents}`),
    file: PAGE,
    authoredChecksum: sha256(encodeUtf8(authoredText)),
    anchor: { span: toByteSpan(0, length), path: [], expectedKind: 'document' },
    operation: {
      tag: 'rewrite-text',
      hunks: patch.value.map((hunk) => ({ span: hunk.span, text: hunk.text })),
    },
  });
}

/** Step until the actor holds nothing; return every outcome and the last state. */
function run(state: ActorState, dependencies: ActorDependencies) {
  const outcomes: Outcome[] = [];
  const steps: ActorStep[] = [];
  let current = state;
  for (let step = 0; step < 16; step++) {
    const result = stepActor(current, dependencies);
    steps.push(result);
    current = result.state;
    for (const effect of result.effects) {
      if (effect.tag === 'outcome') {
        outcomes.push(effect.outcome);
      }
    }
    if (actorQuiescent(current)) {
      return { state: current, outcomes, steps };
    }
  }
  throw new Error('the actor did not settle in 16 steps');
}

function submitted(intent: Intent): ActorState {
  const result = submitIntent(createActor(PAGE), { intent, authored: undefined });
  assert.equal(result.result.tag, 'accepted');
  return result.state;
}

test('a fresh rewrite-text applies through idle → planned → written → idle', () => {
  const disk = fakeWith(TEXT);
  const next = '<Hero title="New" />\n';
  const intent = rewriteIntent(TEXT, next);
  const { state, outcomes, steps } = run(submitted(intent), setup(disk));
  assert.deepEqual(
    steps.map((step) => step.state.phase.tag),
    ['planned', 'written', 'idle'],
  );
  const checksum = sha256(encodeUtf8(next));
  const range = toByteSpan(13, 16); // `Old` → `New`: only the bytes that differ.
  assert.deepEqual(outcomes, [{ tag: 'applied', intentId: intent.id, changedRanges: [range], checksum }]);
  assert.equal(state.snapshot?.checksum, checksum, 'the candidate is committed');
  assert.equal(disk.lockHeld(PAGE), false, 'the lock is released');
});

test('a full queue backpressures the next submission and keeps the queue intact', () => {
  let state = createActor(PAGE);
  for (let index = 0; index < LIMITS.intentsPendingMax; index++) {
    const result = submitIntent(state, {
      intent: rewriteIntent(TEXT, `${index}`),
      authored: undefined,
    });
    assert.equal(result.result.tag, 'accepted');
    state = result.state;
  }
  const extra = submitIntent(state, { intent: rewriteIntent(TEXT, 'x'), authored: undefined });
  assert.deepEqual(extra.result, { tag: 'backpressured' });
  assert.equal(extra.state, state, 'backpressure changes nothing');
  assert.equal(extra.state.queue.length, LIMITS.intentsPendingMax);
});

test('an intent authored against other bytes is refused without its authored bytes', () => {
  const disk = fakeWith(`${TEXT}<!-- outside -->\n`);
  const intent = rewriteIntent(TEXT, 'mine');
  const { outcomes } = run(submitted(intent), setup(disk));
  assert.deepEqual(outcomes, [{ tag: 'rejected', intentId: intent.id, reason: 'region-externally-modified' }]);
});

test('a cooperating writer holding the lock is a write-race, and nothing is written', () => {
  const disk = fakeWith(TEXT);
  disk.contendNextLock(PAGE);
  const intent = rewriteIntent(TEXT, 'mine');
  const { outcomes } = run(submitted(intent), setup(disk));
  assert.deepEqual(outcomes, [{ tag: 'rejected', intentId: intent.id, reason: 'write-race' }]);
  assert.equal(readText(disk), TEXT);
});

test('an outside write between planning and the lock is caught by the re-read', () => {
  const disk = fakeWith(TEXT);
  const intent = rewriteIntent(TEXT, 'mine');
  const planned = stepActor(submitted(intent), setup(disk));
  assert.equal(planned.state.phase.tag, 'planned');
  disk.writeExternally(PAGE, encodeUtf8('outside\n'));
  const { outcomes } = run(planned.state, setup(disk));
  assert.deepEqual(outcomes, [{ tag: 'rejected', intentId: intent.id, reason: 'region-externally-modified' }]);
  assert.equal(readText(disk), 'outside\n', 'the outside edit survives');
});

test('a failed replace is write-failed; a replace without a durable directory is uncertain', () => {
  const failed = fakeWith(TEXT);
  failed.failNextReplace(PAGE, 'failed');
  const first = rewriteIntent(TEXT, 'mine');
  assert.deepEqual(run(submitted(first), setup(failed)).outcomes, [{ tag: 'rejected', intentId: first.id, reason: 'write-failed' }]);
  assert.equal(readText(failed), TEXT);
  const fragile = fakeWith(TEXT);
  fragile.failNextReplace(PAGE, 'not-durable');
  const second = rewriteIntent(TEXT, 'mine');
  const candidateChecksum = sha256(encodeUtf8('mine'));
  assert.deepEqual(run(submitted(second), setup(fragile)).outcomes, [{ tag: 'uncertain', intentId: second.id, candidateChecksum }]);
  assert.equal(fragile.lockHeld(PAGE), false, 'the lock is released on every path');
});

test('the verifying read: another writer is a write-race, an unreadable file is uncertain', () => {
  const raced = fakeWith(TEXT);
  const first = rewriteIntent(TEXT, 'mine');
  const written = run2(submitted(first), setup(raced));
  raced.writeExternally(PAGE, encodeUtf8('theirs'));
  assert.deepEqual(run(written, setup(raced)).outcomes, [{ tag: 'rejected', intentId: first.id, reason: 'write-race' }]);
  const broken = fakeWith(TEXT);
  const second = rewriteIntent(TEXT, 'mine');
  const unreadable: DocumentDisk = {
    read: () => err({ code: 'failed', message: 'EIO' }),
    lock: (path) => broken.lock(path),
    unlock: (lock) => broken.unlock(lock),
    replace: (path, bytes) => broken.replace(path, bytes),
  };
  const midway = run2(submitted(second), setup(broken));
  const candidateChecksum = sha256(encodeUtf8('mine'));
  assert.deepEqual(run(midway, setup(unreadable)).outcomes, [{ tag: 'uncertain', intentId: second.id, candidateChecksum }]);
  assert.equal(broken.lockHeld(PAGE), false);
});

test('reconcileUncertain compares checksums: applied, not applied, changed again', () => {
  const base = digestOf('base');
  const candidate = digestOf('candidate');
  const other = digestOf('other');
  const cases: readonly [Digest | undefined, Digest | undefined, string][] = [
    [candidate, candidate, 'applied'],
    [candidate, base, 'not-applied'],
    [candidate, other, 'changed-again'],
    [candidate, undefined, 'changed-again'],
    [undefined, base, 'not-applied'],
    [undefined, other, 'changed-again'],
    [base, base, 'applied'], // A no-op candidate: the bytes are where it left them.
  ];
  for (const [candidateChecksum, currentChecksum, expected] of cases) {
    const verdict = reconcileUncertain({ baseChecksum: base, candidateChecksum, currentChecksum });
    assert.equal(verdict, expected, `${String(candidateChecksum)} / ${String(currentChecksum)}`);
  }
});

test('preconditions assert: an intent goes to its own actor with its own snapshot', () => {
  const other = createActor(toFilePath('/project/other.astro'));
  const intent = rewriteIntent(TEXT, 'x');
  assert.throws(() => submitIntent(other, { intent, authored: undefined }), /Assertion failed: An intent is submitted to its own file actor/);
  const wrong = SIMULATOR_PROJECTOR.snapshot(PAGE, encodeUtf8('not the authored bytes'));
  assert.throws(() => submitIntent(createActor(PAGE), { intent, authored: wrong }), /Assertion failed: The authored snapshot is the one the intent names/);
});

// Run to the `written` phase: the replace has landed, the verify has not run.
function run2(state: ActorState, dependencies: ActorDependencies): ActorState {
  const planned = stepActor(state, dependencies);
  assert.equal(planned.state.phase.tag, 'planned');
  const written = stepActor(planned.state, dependencies);
  assert.equal(written.state.phase.tag, 'written');
  return written.state;
}

function readText(disk: FakeDisk): string {
  const read = disk.read(PAGE);
  assert.ok(read.ok);
  return new TextDecoder().decode(read.value.bytes);
}

function digestOf(text: string): Digest {
  return sha256(encodeUtf8(text));
}

// Found by the step-8 long run (seed 139): external edits put comments inside
// unfinished tags. The old parser exposed a fake image and later lost it during
// an attribute edit. Balanced tag scanning rejects that target before editing;
// the valid enclosing expression remains opaque and its bytes stay untouched.
const COMMENTS_IN_TAGS = [
  '<ul class="filter_content_list">',
  '  {items.map((item) => {',
  '    return (',
  '      <li',
  '        data-search={[',
  '        ]',
  '          .join(" ")}',
  '      >',
  '        <div class="card_filter_wrap">',
  '          <Element',
  '          >',
  '            <span',
  '            >',
  '              {item.image && (',
  '                <img',
  '<!-- external -->',
  '              )}',
  '            </span>',
  '            <span class="card_filter_content">',
  '              <span class="card_filter_title text-style-h6">',
  '              </span>',
  '              {(item.subheading ||',
  '                <span class="card_filter_row">',
  '<!-- external -->',
  '                  {item.subheading && (',
  '                    <span class="card_filter_subheading text-style-small">',
  '                    </span>',
  '                  )}',
  '                  {!item.href &&',
  '                    item.contacts?.map(({ type, href }) => (',
  '                        aria-label={CONTACTS[type].label(',
  '                        )}',
  '                    ))}',
  '                </span>',
  '              )}',
  '              {item.meta && (',
  '                <span class="card_filter_paragraph text-style-small">',
  '                </span>',
  '              )}',
  '            </span>',
  '          </Element>',
  '        </div>',
  '      </li>',
  '    );',
  '  })}',
  '</ul>',
].join('\n');

test('malformed tags inside expressions never expose a false native edit target', () => {
  const disk = fakeWith(COMMENTS_IN_TAGS);
  const snapshot = SIMULATOR_PROJECTOR.snapshot(PAGE, encodeUtf8(COMMENTS_IN_TAGS));
  assert.equal(snapshot.projection.tag, 'valid');
  assert.ok(snapshot.projection.tag === 'valid');
  const image = snapshot.projection.nodes.find((node) => node.span.start === COMMENTS_IN_TAGS.indexOf('<img'));
  assert.equal(image, undefined, 'an unfinished tag cannot become an editable image');
  const held = disk.read(PAGE);
  assert.ok(held.ok);
  assert.equal(new TextDecoder().decode(held.value.bytes), COMMENTS_IN_TAGS, 'nothing written');
});

test('a lazy snapshot derives its projection once, on first read, and checks it', () => {
  let derivations = 0;
  const bytes = encodeUtf8(TEXT);
  const project = () => {
    derivations += 1;
    return SIMULATOR_PROJECTOR.snapshot(PAGE, bytes).projection;
  };
  const snapshot = createLazySnapshot({ path: PAGE, bytes }, project, sha256);
  assert.equal(snapshot.checksum, sha256(bytes), 'the checksum is computed at once');
  assert.equal(derivations, 0, 'nothing is parsed until the projection is read');
  assert.equal(snapshot.projection.tag, 'valid');
  assert.equal(snapshot.projection, snapshot.projection, 'memoized');
  assert.equal(derivations, 1);
  const wrong = createLazySnapshot({ path: PAGE, bytes }, () => project(), sha256);
  const short = createLazySnapshot({ path: PAGE, bytes: encodeUtf8(`${TEXT} `) }, () => SIMULATOR_PROJECTOR.snapshot(PAGE, bytes).projection, sha256);
  assert.equal(wrong.projection.byteLength, bytes.length);
  assert.throws(() => short.projection, /Assertion failed: The projection was derived from bytes of this length/);
});
