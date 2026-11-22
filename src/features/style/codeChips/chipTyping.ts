import { Prec, type Extension } from '@codemirror/state';
import { EditorView, ViewPlugin } from '@codemirror/view';
import { assert } from '../../../../shared/core/assert';
import { codeTypedVariableAt, type CodeTypedVariable } from '../model/codeVariableScope';
import type { ProjectVariable } from '../model/webflow';
import { styleBlocks, type CssChipRange, type CssChipText, type CssValueChip } from './cssValueChips';

// Variables typed into a code window's CSS, and which references are drawn as purple chips.
//
// The Style panel's CSS Code section has offered the variable chooser as `--` or `var(` is typed for a
// while (CodeVariables.tsx). The code windows (a stylesheet, an Astro file's `<style>`, the style tag
// setting) carry only the chips, and had none of it: typing `--` there showed nothing. This module
// gives the chips' editors the same chooser, on the same rule for where a reference is being typed
// (codeVariableScope.ts), with what a whole file adds to it: markup is CSS only inside its `<style>`
// blocks, and a comment or a string is never a value.
//
// A reference becomes the purple chip only once it names a variable the project has (the list the
// chooser offers) and is complete, `)` and all. While the caret is inside it, it stays text: the
// chip is atomic, and turning `var(--s|)` into one as it is spelt took the name out from under the
// caret before it was finished.

/** Why the typed reference is being reported. */
export type ChipTypingCause = 'input' | 'selection';

/** The keys the chooser takes from the editor while it follows typing. */
export type ChipTypingKey = 'ArrowDown' | 'ArrowUp' | 'Enter' | 'Tab' | 'Escape';
const CHOOSER_KEYS: ReadonlyArray<ChipTypingKey> = ['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'];

export interface ChipTypingHandlers {
  /** What the editor's text is; undefined while it is not CSS. */
  readonly text: () => CssChipText | undefined;
  /** The reference at the caret after an edit (`input`) or a caret move (`selection`). */
  readonly onTyped: (view: EditorView, typed: CodeTypedVariable | undefined, cause: ChipTypingCause) => void;
  /** A chooser key pressed in the editor; true when the chooser took it. */
  readonly onKey: (view: EditorView, key: ChipTypingKey) => boolean;
}

/** The extension that reports typed references, and hands the chooser its keys while it is open. */
export function chipTypingExtension(handlersRef: { readonly current: ChipTypingHandlers }): Extension {
  const listener = EditorView.updateListener.of((update) => {
    if (!update.docChanged && !update.selectionSet) {
      return;
    }
    const handlers = handlersRef.current;
    const kind = handlers.text();
    const typedByHand = update.transactions.some((transaction) => transaction.isUserEvent('input.type') || transaction.isUserEvent('delete'));
    const cause: ChipTypingCause = update.docChanged && typedByHand ? 'input' : 'selection';
    const { main } = update.state.selection;
    const typed =
      kind === undefined || update.state.readOnly || main.from !== main.to ? undefined : chipTypedVariableAt(update.state.doc.toString(), kind, main.head);
    handlers.onTyped(update.view, typed, cause);
  });
  // Ahead of every keymap, and stopped here: Enter would otherwise break the line, an arrow move the
  // caret, and Escape reach the window around the editor. Closed, the chooser takes no key.
  const keys = Prec.highest(
    EditorView.domEventHandlers({
      keydown: (event, view) => {
        const key = CHOOSER_KEYS.find((candidate) => candidate === event.key);
        if (key === undefined) {
          return false;
        }
        if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
          return false;
        }
        if (!handlersRef.current.onKey(view, key)) {
          return false;
        }
        event.preventDefault();
        event.stopPropagation();
        return true;
      },
    }),
  );
  // A view that goes takes its chooser with it.
  const closer = ViewPlugin.define((view) => ({ destroy: () => handlersRef.current.onTyped(view, undefined, 'input') }));
  return [listener, keys, closer];
}

/**
 * The reference being typed at `caret` in `text` read as `kind`: `--`, `var(`, `var(--` or `var(--na`
 * in a declaration's value. Undefined in a selector, a property name (`--brand:` being declared), a
 * comment, a string, outside markup's `<style>` blocks, and for a bare `--` that starts a line, which
 * is a custom property's name being typed even when the declaration above it has no `;` yet.
 */
export function chipTypedVariableAt(text: string, kind: CssChipText, caret: number): CodeTypedVariable | undefined {
  assert(Number.isSafeInteger(caret), 'chipTypedVariableAt: the caret is a whole offset');
  assert(caret >= 0, 'chipTypedVariableAt: the caret is not before the text');
  if (caret > text.length) {
    return undefined;
  }
  const region = kind === 'stylesheet' ? { from: 0, to: text.length } : styleBlocks(text).find((block) => block.from <= caret && caret <= block.to);
  if (region === undefined) {
    return undefined;
  }
  if (insideCommentOrString(text, { from: region.from, to: caret })) {
    return undefined;
  }
  const typed = codeTypedVariableAt(text, caret, { kind: 'declarations' });
  if (typed === undefined) {
    return undefined;
  }
  assert(typed.typed.start <= caret, 'chipTypedVariableAt: the fragment starts before the caret');
  if (typed.typed.start < region.from) {
    return undefined;
  }
  const lineStart = text.lastIndexOf('\n', typed.typed.start - 1) + 1;
  if (text.startsWith('--', typed.typed.start) && text.slice(lineStart, typed.typed.start).trim() === '') {
    return undefined;
  }
  return typed;
}

/**
 * The edit a pick makes over the typed fragment: the whole reference, and the caret after it. Typed
 * in front of a fallback (`var(--s|, 1rem)`), the pick leaves the fallback and its `)` as written.
 */
export function chipTypedCompletion(
  text: string,
  typed: CodeTypedVariable,
  binding: string,
): { readonly from: number; readonly to: number; readonly insert: string; readonly caret: number } {
  const { start, end } = typed.typed;
  assert(start <= end, 'chipTypedCompletion: the fragment keeps its order');
  assert(end <= text.length, 'chipTypedCompletion: the fragment lies in the text');
  assert(binding.length > 0, 'chipTypedCompletion: a pick is never empty');
  const reference = /^var\(/i.test(text.slice(start, end));
  const fallback = reference && /^\s*,/.test(text.slice(end, end + 64)) && binding.endsWith(')');
  const insert = fallback ? binding.slice(0, -1) : binding;
  return { from: start, to: end, insert, caret: start + insert.length };
}

// Whether `range.to` sits inside a comment or a string that opens in `range`.
function insideCommentOrString(text: string, range: CssChipRange): boolean {
  assert(range.from <= range.to, 'insideCommentOrString: the range keeps its order');
  let index = range.from;
  // Each pass moves `index` forward by at least one, so the range's length bounds the loop.
  for (let step = 0; index < range.to; step++) {
    assert(step <= range.to - range.from, 'insideCommentOrString: the scan moves forward');
    const character = text.charAt(index);
    if (character === '/' && text.charAt(index + 1) === '*') {
      const close = text.indexOf('*/', index + 2);
      if (close < 0 || close + 2 > range.to) {
        return true;
      }
      index = close + 2;
      continue;
    }
    if (character === '"' || character === "'") {
      const close = stringEnd(text, index, range.to);
      if (close === undefined) {
        return true;
      }
      index = close;
      continue;
    }
    index += 1;
  }
  return false;
}

// The offset after the string that opens at `open`, or undefined when it is still open at `limit`.
function stringEnd(text: string, open: number, limit: number): number | undefined {
  const quote = text.charAt(open);
  for (let index = open + 1; index < limit; index++) {
    const character = text.charAt(index);
    if (character === '\\') {
      index += 1;
    } else if (character === quote || character === '\n') {
      return index + 1;
    }
  }
  return undefined;
}

/** The reference the chooser follows: in which view, and the fragment typed so far. */
export interface ChipFollowing<View> {
  readonly view: View;
  readonly typed: CodeTypedVariable;
}

/** A reference put away with Escape (or a press outside), until the caret leaves it. */
export interface ChipDismissed<View> {
  readonly view: View;
  readonly start: number;
}

/**
 * What the chooser follows after a report: typing opens it, a caret moved by hand only updates one
 * already open (clicking into `var(--a)` is not asking for the list), and a reference put away stays
 * away until the caret leaves it. `dismissedRef` is cleared here once that happens.
 */
export function nextFollowing<View>(
  report: { readonly view: View; readonly typed: CodeTypedVariable | undefined; readonly cause: ChipTypingCause },
  current: ChipFollowing<View> | undefined,
  dismissedRef: { current: ChipDismissed<View> | undefined },
): ChipFollowing<View> | undefined {
  const { view, typed, cause } = report;
  if (typed === undefined) {
    if (dismissedRef.current?.view === view) {
      dismissedRef.current = undefined;
    }
    return current?.view === view ? undefined : current;
  }
  const dismissed = dismissedRef.current;
  if (dismissed !== undefined && dismissed.view === view) {
    if (dismissed.start === typed.typed.start) {
      return undefined;
    }
    dismissedRef.current = undefined;
  }
  if (current === undefined) {
    return cause === 'input' ? { view, typed } : undefined;
  }
  return { view, typed };
}

// ─────────────────────────── Which references are chips ───────────────────────────

const REFERENCE_NAME = /^var\(\s*(--[A-Za-z0-9_-]+)/i;
const CUSTOM_PROPERTY = /--[A-Za-z0-9_-]+/;

/** The custom properties the project has, by the bindings the chooser lists (`var(--gap)` → `--gap`). */
export function variableNames(variables: readonly ProjectVariable[]): ReadonlySet<string> {
  const names = new Set<string>();
  for (const variable of variables) {
    const name = CUSTOM_PROPERTY.exec(variable.binding)?.[0];
    if (name !== undefined) {
      names.add(name);
    }
  }
  return names;
}

/**
 * Whether a variable reference is drawn as the purple chip: it names a variable the project has
 * (a fallback, `var(--a, 1rem)`, is judged by its own name) and the caret is not inside it. The
 * scanner only finds complete references, so the closing `)` is already there. `caret` is undefined
 * while the editor is not focused, where no reference is being edited.
 */
export function variableChipShown(chip: Extract<CssValueChip, { kind: 'variable' }>, names: ReadonlySet<string>, caret: number | undefined): boolean {
  assert(chip.from < chip.to, 'variableChipShown: a reference covers its text');
  assert(chip.value.endsWith(')'), 'variableChipShown: a reference is complete');
  const name = REFERENCE_NAME.exec(chip.value)?.[1];
  if (name === undefined) {
    return false;
  }
  if (!names.has(name)) {
    return false;
  }
  if (caret === undefined) {
    return true;
  }
  return caret <= chip.from || caret >= chip.to;
}
