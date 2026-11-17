// The one code block of Settings → Style tags: a whole `<style ...>` tag, as a new tag will be
// written, that the person edits in place.
//
// What can change is what a project may choose: the attributes on the opening tag (add
// `lang="scss"`, take `is:global` off) and the content between the tags (the template rules go
// into, newStyleTag.ts). What cannot change is that it is one style tag: `<style`, the `>` that
// closes the opening tag and `</style>` are locked. The lock is a CodeMirror transaction filter
// over the person's own edits (typing, deleting, pasting, dropping): an edit that touches a locked
// range, or would leave anything but one style tag, is refused; a paste of a whole style tag into
// the content is reduced to that tag's content. Edits the editor makes itself (a new value from
// the file) are not the person's and pass, and the value they bring is built by `styleTagText`.
//
// The pure half (split, join, check) is separate from the extension so a test can drive it
// without an editor, and the extension is tested through a real EditorState.

import { EditorState, Transaction, type Extension, type TransactionSpec } from '@codemirror/state';
import { assert } from '../../../shared/core/assert';
import { styleTagAttributesText, type NewStyleTagSettings } from '../../../shared/properties/newStyleTag';

const OPEN = '<style';
const CLOSE = '</style>';

/** The three parts of a style tag's text: the attribute text, and the content between the tags. */
export interface StyleTagParts {
  /** What sits between `<style` and the `>` that closes the opening tag, as typed (leading space included). */
  readonly attributes: string;
  /** What sits between the tags, without the line break after `>` and before `</style>`. */
  readonly content: string;
  /** Where the opening tag's `>` is, in the text. */
  readonly openEnd: number;
  /** Where `</style>` starts, in the text. */
  readonly closeStart: number;
}

/** The text the block shows for settings: `<style is:global>`, the content on its own lines, `</style>`. */
export function styleTagText(settings: NewStyleTagSettings): string {
  const content = settings.content.replace(/^\n+|\n+$/g, '');
  const text = `${OPEN}${styleTagAttributesText(settings.attributes)}>\n${content === '' ? '' : `${content}\n`}${CLOSE}`;
  const parts = styleTagParts(text);
  assert(parts !== undefined, 'styleTagText: what is built splits back');
  assert(parts.content === content, 'styleTagText: the content round-trips');
  return text;
}

/**
 * The parts of `text`, or undefined when it is not exactly one style tag: it opens with `<style`,
 * its opening tag closes with a `>` outside quotes, it ends with `</style>`, and the content names
 * no other style tag. One pass over the text, so bounded by its length.
 */
export function styleTagParts(text: string): StyleTagParts | undefined {
  if (!text.startsWith(OPEN) || !text.endsWith(CLOSE)) {
    return undefined;
  }
  const closeStart = text.length - CLOSE.length;
  const openEnd = openingEnd(text, OPEN.length, closeStart);
  if (openEnd === undefined) {
    return undefined;
  }
  const attributes = text.slice(OPEN.length, openEnd);
  // `<stylesheet>` is not `<style>`: the name ends where the attributes start.
  if (attributes !== '' && !/^\s/.test(attributes)) {
    return undefined;
  }
  const inner = text.slice(openEnd + 1, closeStart);
  if (/<\/?style\b/i.test(inner)) {
    return undefined;
  }
  return { attributes, content: inner.replace(/^\n/, '').replace(/\n$/, ''), openEnd, closeStart };
}

// The index of the `>` that closes the opening tag, skipping quoted values; undefined when there is none before `limit`.
function openingEnd(text: string, from: number, limit: number): number | undefined {
  let quote: string | undefined = undefined;
  for (let index = from; index < limit; index += 1) {
    const char = text.charAt(index);
    if (quote !== undefined) {
      quote = char === quote ? undefined : quote;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '<') {
      return undefined;
    } else if (char === '>') {
      return index;
    }
  }
  return undefined;
}

/** What a person's edit does to the block: goes through, goes through reduced, or is refused. */
export type StyleTagEdit =
  { readonly kind: 'keep' } | { readonly kind: 'refuse' } | { readonly kind: 'reduce'; readonly from: number; readonly to: number; readonly insert: string };

/**
 * Whether one change of `before` (replace `from`..`to` with `insert`) keeps the block one style
 * tag with its delimiters untouched. A whole style tag pasted into the content becomes its content.
 */
export function styleTagEditOf(before: string, change: { readonly from: number; readonly to: number; readonly insert: string }): StyleTagEdit {
  const parts = styleTagParts(before);
  assert(parts !== undefined, 'styleTagEditOf: the block holds one style tag before the edit');
  assert(change.from <= change.to, 'styleTagEditOf: a change keeps its order');
  // `<style` and `</style>` are never touched; the `>` is not either, but text may go right before it.
  if (change.from < OPEN.length || change.to > parts.closeStart) {
    return { kind: 'refuse' };
  }
  const coversOpenEnd = change.from <= parts.openEnd && parts.openEnd < change.to;
  if (coversOpenEnd) {
    return { kind: 'refuse' };
  }
  const inContent = change.from > parts.openEnd;
  const pasted = inContent ? styleTagParts(change.insert.trim()) : undefined;
  const insert = pasted === undefined ? change.insert : pasted.content;
  const after = before.slice(0, change.from) + insert + before.slice(change.to);
  const afterParts = styleTagParts(after);
  if (afterParts === undefined) {
    return { kind: 'refuse' };
  }
  // An attribute edit never moves where the opening tag ends except by its own length.
  if (!inContent && afterParts.openEnd !== parts.openEnd + insert.length - (change.to - change.from)) {
    return { kind: 'refuse' };
  }
  return pasted === undefined ? { kind: 'keep' } : { kind: 'reduce', from: change.from, to: change.to, insert };
}

/**
 * The CodeMirror extension that keeps the block one style tag. Only the person's edits are
 * checked (a transaction with a user event); several changes in one transaction (multiple
 * cursors) go through only when every one of them would on its own.
 */
export function styleTagLock(): Extension {
  return EditorState.transactionFilter.of((transaction: Transaction): TransactionSpec | readonly TransactionSpec[] => {
    if (!transaction.docChanged || transaction.annotation(Transaction.userEvent) === undefined) {
      return transaction;
    }
    const before = transaction.startState.doc.toString();
    const changes: Array<{ from: number; to: number; insert: string }> = [];
    transaction.changes.iterChanges((from, to, _fromAfter, _toAfter, inserted) => {
      changes.push({ from, to, insert: inserted.toString() });
    });
    const edits = changes.map((change) => styleTagEditOf(before, change));
    if (edits.some((edit) => edit.kind === 'refuse')) {
      return [];
    }
    const reduced = edits.filter((edit): edit is Extract<StyleTagEdit, { kind: 'reduce' }> => edit.kind === 'reduce');
    if (reduced.length === 0) {
      return transaction;
    }
    const replaced = changes.map((change, index) => {
      const edit = edits[index];
      return edit !== undefined && edit.kind === 'reduce' ? { from: edit.from, to: edit.to, insert: edit.insert } : change;
    });
    assert(replaced.length === changes.length, 'styleTagLock: a reduced edit replaces each change once');
    return { changes: replaced, userEvent: 'input.paste', scrollIntoView: true };
  });
}
