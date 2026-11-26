// One suggestion and a list of them, as the answers carry them: matching what was typed, ordering, and the list's bound.
import { CODE_INTEL_LIMITS, type CodeCompletion, type CodeCompletions, type CompletionKind } from '../../../shared/ipc/codeIntel';

export function suggestion(label: string, kind: CompletionKind, more: Partial_<CodeCompletion> = {}): CodeCompletion {
  return {
    label: clip(label, CODE_INTEL_LIMITS.labelCharsMax),
    kind,
    detail: more.detail === undefined ? undefined : clip(more.detail, CODE_INTEL_LIMITS.labelCharsMax),
    insert: more.insert,
    cursor: more.cursor,
    boost: more.boost ?? 0,
    required: more.required ?? false,
    color: more.color,
    signature: more.signature === undefined ? undefined : clip(more.signature, CODE_INTEL_LIMITS.signatureCharsMax),
    documentation: more.documentation === undefined ? undefined : clip(more.documentation, CODE_INTEL_LIMITS.documentationCharsMax),
    edits: more.edits ?? [],
    entry: more.entry,
  };
}

// The fields a suggestion may be made with. Spelled as a mapped type, since an output's optional fields are what is
// meant here, not a function that accepts any part of a value it then trusts.
type Partial_<T> = { readonly [Key in keyof T]?: T[Key] | undefined };

export function clip(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

/** 0 for a prefix, 1 for the typed letters in order, undefined for no match. */
export function matchRank(label: string, typed: string): number | undefined {
  if (typed === '') {
    return 0;
  }
  const name = label.toLowerCase();
  const wanted = typed.toLowerCase();
  if (name.startsWith(wanted)) {
    return 0;
  }
  if (name.charAt(0) !== wanted.charAt(0) && !name.includes(wanted)) {
    return undefined;
  }
  let at = 0;
  for (const character of wanted) {
    at = name.indexOf(character, at) + 1;
    if (at === 0) {
      return undefined;
    }
  }
  return 1;
}

/** The suggestions that match, best first, cut to the answer's bound. */
export function completions(
  place: { readonly from: number; readonly to: number; readonly typed: string; readonly exclusive: boolean },
  items: readonly CodeCompletion[],
): CodeCompletions {
  const matched: Array<{ readonly item: CodeCompletion; readonly rank: number }> = [];
  for (const item of items) {
    const rank = matchRank(item.label, place.typed);
    if (rank !== undefined) {
      matched.push({ item, rank });
    }
  }
  matched.sort((left, right) => left.rank - right.rank || right.item.boost - left.item.boost || left.item.label.localeCompare(right.item.label));
  return {
    from: place.from,
    to: place.to,
    exclusive: place.exclusive,
    incomplete: matched.length > CODE_INTEL_LIMITS.completionsMax,
    items: matched.slice(0, CODE_INTEL_LIMITS.completionsMax).map((entry) => entry.item),
  };
}

export function noCompletions(position: number, exclusive: { readonly exclusive: boolean }): CodeCompletions {
  return { from: position, to: position, exclusive: exclusive.exclusive, incomplete: false, items: [] };
}
