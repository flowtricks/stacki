// The pure rules of a permission request: which option reads first, which is the recommended one,
// which key answers what, what an answered request says, and what the request asks for in words.
// PermissionCard.tsx and PermissionPin.tsx draw what this module decides.
import type { ToolKindName } from '../../../../shared/properties/ai/chatModel';
import type { Translator } from '../../../lib/i18n/localeContext';
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
export function verdictLabel(item: PermissionItem, translate: Translator): string | undefined {
  const answer = item.answer;
  if (answer === undefined) {
    return undefined;
  }
  if (answer.outcome === 'cancelled') {
    return translate('ai.permission.verdict.stopped');
  }
  const chosen = item.options.find((option) => option.id === answer.optionId);
  const kind = chosen?.kind;
  switch (kind) {
    case 'allow_once':
      return translate('ai.permission.verdict.allowed');
    case 'allow_always':
      return translate('ai.permission.verdict.alwaysAllowed');
    case 'reject_once':
    case 'reject_always':
      return translate('ai.permission.verdict.denied');
    case undefined:
      return translate('ai.permission.verdict.answered');
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

/** What the request is about, in a few words, from the tool call it asks about. */
/** Whether an answered request was refused (a denial or a stopped turn): the card marks it with a cross instead of a check. */
export function wasRefused(item: PermissionItem): boolean {
  const answer = item.answer;
  if (answer === undefined) {
    return false;
  }
  if (answer.outcome === 'cancelled') {
    return true;
  }
  const kind = item.options.find((option) => option.id === answer.optionId)?.kind;
  return kind === 'reject_once' || kind === 'reject_always';
}

export function askLabel(kind: ToolKindName | undefined, translate: Translator): string {
  switch (kind) {
    case 'execute':
      return translate('ai.permission.ask.command');
    case 'edit':
      return translate('ai.permission.ask.edit');
    case 'move':
      return translate('ai.permission.ask.move');
    case 'delete':
      return translate('ai.permission.ask.delete');
    case 'read':
      return translate('ai.permission.ask.read');
    case 'search':
      return translate('ai.permission.ask.search');
    case 'fetch':
      return translate('ai.permission.ask.fetch');
    case 'think':
    case 'switch_mode':
    case 'other':
    case undefined:
      return translate('ai.permission.ask.other');
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
