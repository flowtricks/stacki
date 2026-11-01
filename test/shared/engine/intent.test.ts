// Goal: the intent contract (plan §3.3, §3.5). One known-good intent per
// operation passes; each malformed shape, each crossed bound and each
// anchor/operation mismatch fails with a message naming the field. Submission
// results and terminal outcomes are separate types with their own parsers;
// every rejection reason has notice text.
// Method: build wire values as plain objects (what IPC delivers), mutate one
// field at a time, and pin the error message.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  describeRejection,
  intentPayloadBytes,
  parseIntent,
  parseOutcome,
  parseRejectionReason,
  parseSubmissionResult,
  REJECTION_REASONS,
  type OperationTag,
} from '#dist/shared/engine/intent.js';
import { LIMITS } from '#dist/shared/core/limits.js';
import { parseAnchorRef, STRUCTURAL_PATH_STEPS_MAX } from '#dist/shared/page/ref.js';

// Null as a boundary receives it, parsed from JSON: inputs may hold it; our values never do.
const jsonNull: unknown = JSON.parse('null');

const DIGEST = 'a'.repeat(64);
const element = { span: { start: 10, end: 40 }, path: [0, 2], expectedKind: 'element' };
const loop = { span: { start: 10, end: 90 }, path: [1], expectedKind: 'map' };
const frontmatter = { span: { start: 0, end: 30 }, path: [], expectedKind: 'frontmatter' };
const documentAnchor = { span: { start: 0, end: 120 }, path: [], expectedKind: 'document' };

const wire = (anchor: object, operation: object, extra: object = {}) => ({
  id: 'i1',
  file: '/site/src/pages/index.astro',
  authoredChecksum: DIGEST,
  anchor,
  operation,
  ...extra,
});

const GOOD: readonly (readonly [object, object])[] = [
  [element, { tag: 'set-attribute', name: 'title', value: { type: 'string', value: 'New' } }],
  [element, { tag: 'set-attribute', name: 'hidden', value: { type: 'bare' } }],
  [element, { tag: 'remove-attribute', name: 'data-x' }],
  [element, { tag: 'insert-node', placement: 'after', source: '<p>Hi</p>' }],
  [element, { tag: 'remove-node' }],
  [element, { tag: 'move-node', destination: { ...element, path: [0] }, placement: 'first-child' }],
  [
    loop,
    {
      tag: 'rename-binding',
      from: 'item',
      to: 'entry',
      sites: [
        { start: 12, end: 16 },
        { start: 40, end: 44 },
      ],
    },
  ],
  [element, { tag: 'set-inline-style', property: '--gap', declaration: { tag: 'set', value: '1rem' } }],
  [element, { tag: 'set-inline-style', property: 'color', declaration: { tag: 'remove' } }],
  [documentAnchor, { tag: 'apply-code-patch', hunks: [{ span: { start: 3, end: 5 }, text: 'x' }] }],
  [documentAnchor, { tag: 'revert-splices', hunks: [{ span: { start: 3, end: 5 }, text: 'x' }] }],
  [frontmatter, { tag: 'edit-frontmatter-slot', slot: { start: 4, end: 20 }, text: 'const a = 1;' }],
  [documentAnchor, { tag: 'rewrite-text', hunks: [{ span: { start: 3, end: 5 }, text: 'x' }] }],
  // Step 9.
  [element, { tag: 'rename-tag', from: 'div', to: 'Card' }],
  [element, { tag: 'rename-attribute', from: 'title', to: 'aria-label' }],
  [element, { tag: 'rewrite-node', hunks: [{ span: { start: 21, end: 24 }, text: 'x' }] }],
  [element, { tag: 'wrap-nodes', last: { ...element, path: [0, 3] }, open: '<A>', close: '</A>' }],
  [documentAnchor, { tag: 'append-body', source: '<main></main>' }],
  // Step 10.
  [documentAnchor, { tag: 'insert-frontmatter', source: '---\nlayout: ../L.astro\n---\n' }],
];

// Every operation of the closed union, by name: a new operation is a compile
// error here until it has a known-good intent above.
const OPERATIONS: Readonly<Record<OperationTag, true>> = {
  'append-body': true,
  'apply-code-patch': true,
  'edit-frontmatter-slot': true,
  'insert-frontmatter': true,
  'insert-node': true,
  'move-node': true,
  'remove-attribute': true,
  'remove-node': true,
  'rename-attribute': true,
  'rename-binding': true,
  'rename-tag': true,
  'revert-splices': true,
  'rewrite-node': true,
  'rewrite-text': true,
  'set-attribute': true,
  'set-inline-style': true,
  'wrap-nodes': true,
};

test('one known-good intent per operation parses to itself', () => {
  for (const [anchor, operation] of GOOD) {
    const parsed = parseIntent(wire(anchor, operation));
    assert.deepEqual(parsed.operation, operation);
    assert.deepEqual(parsed.anchor, anchor);
  }
  const tags = new Set(GOOD.map(([, operation]): unknown => Reflect.get(operation, 'tag')));
  assert.deepEqual([...tags].sort(), Object.keys(OPERATIONS).sort(), 'every operation is covered');
});

test('malformed intents fail at the field that is wrong', () => {
  const set = { tag: 'set-attribute', name: 'title', value: { type: 'string', value: 'x' } };
  const cases: readonly [unknown, RegExp][] = [
    [jsonNull, /Intent: expected object/],
    [{ ...wire(element, set), id: 7 }, /Intent.id: expected string/],
    [{ ...wire(element, set), id: 'bad id' }, /IntentId/],
    [{ ...wire(element, set), file: '' }, /FilePath/],
    [{ ...wire(element, set), authoredChecksum: 'abc' }, /Digest/],
    [wire(element, { tag: 'teleport' }), /unknown operation/],
    [wire(element, { ...set, name: 'bad name' }), /expected an attribute name/],
    [wire(element, { ...set, value: { type: 'spread', value: 'x' } }), /value.type: unknown/],
    [
      wire(element, {
        ...set,
        value: { type: 'string', value: 'x'.repeat(LIMITS.attrCharsMax + 1) },
      }),
      /exceeds/,
    ],
    [wire(element, { tag: 'insert-node', placement: 'inside', source: '' }), /placement: unknown/],
    [
      wire(element, {
        tag: 'set-inline-style',
        property: 'Color!',
        declaration: { tag: 'remove' },
      }),
      /CSS property/,
    ],
    [wire(element, { tag: 'set-inline-style', property: 'color', declaration: { tag: 'toggle' } }), /declaration.tag/],
    [
      wire(loop, {
        tag: 'rename-binding',
        from: 'item',
        to: 'item',
        sites: [{ start: 12, end: 16 }],
      }),
      /must change/,
    ],
    [wire(loop, { tag: 'rename-binding', from: 'it em', to: 'x', sites: [] }), /expected an identifier/],
    [wire(documentAnchor, { tag: 'apply-code-patch', hunks: {} }), /hunks: expected array/],
    [wire(element, { tag: 'rename-tag', from: 'div', to: 'my div' }), /expected a tag name/],
    [wire(element, { tag: 'rename-tag', from: 'div', to: 'div' }), /must change the name/],
    [wire(element, { tag: 'rename-attribute', from: 'a', to: 'a' }), /must change/],
    [wire(element, { tag: 'rewrite-node', hunks: [{ span: { start: 0, end: 1 }, text: '' }] }), /outside its anchor/],
    [wire(element, { tag: 'wrap-nodes', last: frontmatter, open: '', close: '' }), /wrap-nodes cannot/],
    [wire({ ...element, path: 'x' }, set), /path: expected array/],
    [wire({ ...element, expectedKind: 'widget' }, set), /unknown anchor kind/],
  ];
  for (const [input, message] of cases) {
    assert.throws(() => parseIntent(input), message);
  }
});

test('the operation must fit its anchor', () => {
  const set = { tag: 'set-attribute', name: 'title', value: { type: 'string', value: 'x' } };
  const cases: readonly [object, object, RegExp][] = [
    [{ ...element, expectedKind: 'text' }, set, /set-attribute cannot target/],
    [documentAnchor, set, /set-attribute cannot target/],
    [element, { tag: 'rewrite-text', hunks: [] }, /rewrite-text cannot target/],
    [element, { tag: 'insert-frontmatter', source: '---\n---\n' }, /insert-frontmatter cannot/],
    // Step 10 retired the whole-file replacement: no such operation parses.
    [documentAnchor, { tag: 'replace-source', text: '' }, /unknown operation/],
    [element, { tag: 'apply-code-patch', hunks: [{ span: { start: 0, end: 1 }, text: '' }] }, /apply-code-patch cannot/],
    [element, { tag: 'rename-binding', from: 'a', to: 'b', sites: [{ start: 12, end: 13 }] }, /rename-binding cannot/],
    [documentAnchor, { tag: 'insert-node', placement: 'after', source: '' }, /insert-node cannot/],
    [element, { tag: 'move-node', destination: frontmatter, placement: 'after' }, /move-node cannot/],
    [element, { tag: 'edit-frontmatter-slot', slot: { start: 0, end: 1 }, text: '' }, /edit-frontmatter-slot cannot/],
  ];
  for (const [anchor, operation, message] of cases) {
    assert.throws(() => parseIntent(wire(anchor, operation)), message);
  }
});

test('multi-span sites lie inside the anchor, ascend, do not overlap, and are bounded', () => {
  const rename = (sites: readonly object[]) => wire(loop, { tag: 'rename-binding', from: 'a', to: 'b', sites });
  assert.throws(() => parseIntent(rename([])), /needs at least one site/);
  assert.throws(() => parseIntent(rename([{ start: 5, end: 8 }])), /outside its anchor/);
  assert.throws(
    () =>
      parseIntent(
        rename([
          { start: 20, end: 25 },
          { start: 12, end: 14 },
        ]),
      ),
    /ascend/,
  );
  assert.throws(
    () =>
      parseIntent(
        rename([
          { start: 12, end: 20 },
          { start: 15, end: 22 },
        ]),
      ),
    /ascend/,
  );
  const tooMany = Array.from({ length: LIMITS.splicesPerIntentMax + 1 }, (_, index) => ({
    start: index,
    end: index,
  }));
  assert.throws(() => parseIntent(rename(tooMany)), /exceeds/);
  const slot = { tag: 'edit-frontmatter-slot', slot: { start: 25, end: 31 }, text: '' };
  assert.throws(() => parseIntent(wire(frontmatter, slot)), /outside its anchor/);
});

test('the summed payload is bounded in UTF-8 bytes, not characters', () => {
  const text = '🎉'.repeat(Math.floor(LIMITS.intentPayloadBytesMax / 4) + 1);
  assert.ok(text.length <= LIMITS.intentPayloadBytesMax, 'the character count alone fits');
  const rewrite = { tag: 'rewrite-text', hunks: [{ span: { start: 0, end: 0 }, text }] };
  assert.throws(() => parseIntent(wire(documentAnchor, rewrite)), /payload exceeds/);
  const intent = parseIntent(wire(element, { tag: 'set-attribute', name: 'title', value: { type: 'string', value: 'é' } }));
  assert.equal(intentPayloadBytes(intent.operation), 'title'.length + 2);
});

test('anchors: path length and kind agree, documents start at zero, depth is bounded', () => {
  assert.deepEqual(parseAnchorRef(element, 'anchor'), element);
  const cases: readonly [object, RegExp][] = [
    [{ ...element, path: [] }, /needs at least one step/],
    [{ ...frontmatter, path: [0] }, /has no path/],
    [{ ...documentAnchor, span: { start: 1, end: 5 } }, /starts at byte 0/],
    [{ ...element, path: [-1] }, /ChildIndex/],
    [{ ...element, path: [LIMITS.treeNodesMax] }, /ChildIndex/],
    [{ ...element, path: ['0'] }, /expected number/],
    [{ ...element, path: Array.from({ length: STRUCTURAL_PATH_STEPS_MAX + 1 }, () => 0) }, /exceeds/],
    [{ ...element, span: { start: 4, end: 2 } }, /end must not precede start/],
  ];
  for (const [input, message] of cases) {
    assert.throws(() => parseAnchorRef(input, 'anchor'), message);
  }
});

test('submission results are accepted or backpressured, never an outcome', () => {
  assert.deepEqual(parseSubmissionResult({ tag: 'accepted', intentId: 'i1' }), {
    tag: 'accepted',
    intentId: 'i1',
  });
  assert.deepEqual(parseSubmissionResult({ tag: 'backpressured' }), { tag: 'backpressured' });
  assert.throws(() => parseSubmissionResult({ tag: 'rejected', intentId: 'i1' }), /unknown value/);
  assert.throws(() => parseSubmissionResult({ tag: 'accepted' }), /intentId: expected string/);
});

test('outcomes: applied, rejected and uncertain parse; everything else fails', () => {
  const applied = {
    tag: 'applied',
    intentId: 'i1',
    changedRanges: [{ start: 0, end: 2 }],
    checksum: DIGEST,
  };
  assert.deepEqual(parseOutcome(applied), applied);
  assert.deepEqual(parseOutcome({ tag: 'rejected', intentId: 'i1', reason: 'write-race' }), {
    tag: 'rejected',
    intentId: 'i1',
    reason: 'write-race',
  });
  assert.deepEqual(parseOutcome({ tag: 'uncertain', intentId: 'i1' }), {
    tag: 'uncertain',
    intentId: 'i1',
    candidateChecksum: undefined,
  });
  const cases: readonly [unknown, RegExp][] = [
    [{ ...applied, tag: 'done' }, /Outcome.tag: unknown/],
    [{ ...applied, checksum: 'x' }, /Digest/],
    [
      {
        ...applied,
        changedRanges: [
          { start: 4, end: 6 },
          { start: 0, end: 1 },
        ],
      },
      /ascending/,
    ],
    [
      {
        ...applied,
        changedRanges: Array.from({ length: LIMITS.splicesPerIntentMax + 1 }, () => ({
          start: 0,
          end: 0,
        })),
      },
      /exceeds/,
    ],
    [{ tag: 'rejected', intentId: 'i1', reason: 'queue-full' }, /unknown rejection reason/],
    [{ tag: 'uncertain', intentId: 'i1', candidateChecksum: 'nope' }, /Digest/],
    [{ tag: 'applied', changedRanges: [], checksum: DIGEST }, /intentId: expected string/],
  ];
  for (const [input, message] of cases) {
    assert.throws(() => parseOutcome(input), message);
  }
});

test('every rejection reason parses and has its own notice text', () => {
  const notices = new Set<string>();
  for (const reason of REJECTION_REASONS) {
    assert.equal(parseRejectionReason(reason, 'reason'), reason);
    notices.add(describeRejection(reason));
  }
  assert.equal(notices.size, REJECTION_REASONS.length);
  assert.equal(REJECTION_REASONS.length, 9, 'plan §3.5 names nine reasons');
  assert.throws(() => parseRejectionReason('backpressured', 'reason'), /unknown rejection reason/);
});
