// The pure rules of a permission request: which option reads first, which is the recommended one,
// which key answers what, what an answered request says, and what the request asks for in words.
// PermissionCard.tsx and PermissionPin.tsx draw what this module decides.
import type { ToolKindName } from '../../../../shared/properties/ai/chatModel';
import type { PermissionItem } from '../chatReducer';

export type PermissionOption = PermissionItem['options'][number];
type OptionKind = PermissionOption['kind'];

/** Allow before reject, once before always: the order the person reads the question in. */
const KIND_ORDER: readonly OptionKind[] = ['allow_once', 'allow_always', 'reject_once', 'reject_always'];

export function sortedOptions(options: readonly PermissionOption[]): readonly PermissionOption[] {
  return [...options].sort((left, right) => KIND_ORDER.indexOf(left.kind) - KIND_ORDER.indexOf(right.kind));
}

export function isAllow(option: PermissionOption): boolean {
  return option.kind === 'allow_once' || option.kind === 'allow_always';
}

/** The recommended answer, drawn as the primary button: the first "allow once", else the first allow. */
export function primaryOption(options: readonly PermissionOption[]): PermissionOption | undefined {
  const sorted = sortedOptions(options);
  return sorted.find((option) => option.kind === 'allow_once') ?? sorted.find(isAllow);
}

/** What Esc answers: the first reject option. A request offering none is not denied by Esc, so a key can never cancel the turn. */
export function denyOption(options: readonly PermissionOption[]): PermissionOption | undefined {
  return sortedOptions(options).find((option) => !isAllow(option));
}

/** The option a digit key answers: `1` is the first button as drawn. Undefined for a key with no button. */
export function optionForKey(options: readonly PermissionOption[], key: string): PermissionOption | undefined {
  if (!/^[1-9]$/.test(key)) {
    return undefined;
  }
  return sortedOptions(options)[Number(key) - 1];
}

/** The answered request's verdict: "Allowed", "Always allowed", "Denied", "Stopped" when the turn was cancelled instead. */
export function verdictLabel(item: PermissionItem): string | undefined {
  const answer = item.answer;
  if (answer === undefined) {
    return undefined;
  }
  if (answer.outcome === 'cancelled') {
    return 'Stopped';
  }
  const chosen = item.options.find((option) => option.id === answer.optionId);
  const kind = chosen?.kind;
  switch (kind) {
    case 'allow_once':
      return 'Allowed';
    case 'allow_always':
      return 'Always allowed';
    case 'reject_once':
    case 'reject_always':
      return 'Denied';
    case undefined:
      return 'Answered';
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

/** What the request is about, in a few words, from the tool call it asks about. */
export function askLabel(kind: ToolKindName | undefined): string {
  switch (kind) {
    case 'execute':
      return 'Run a command';
    case 'edit':
      return 'Edit a file';
    case 'move':
      return 'Move a file';
    case 'delete':
      return 'Delete a file';
    case 'read':
      return 'Read a file';
    case 'search':
      return 'Search the project';
    case 'fetch':
      return 'Fetch a page';
    case 'think':
    case 'switch_mode':
    case 'other':
    case undefined:
      return 'Needs your answer';
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

/** A title with the project's root taken out wherever it appears; a title is returned as it is when the root is unknown. */
export function plainTitle(title: string, projectPath: string): string {
  if (projectPath === '' || projectPath === '/') {
    return title;
  }
  const root = projectPath.endsWith('/') ? projectPath : `${projectPath}/`;
  return title.split(root).join('');
}
