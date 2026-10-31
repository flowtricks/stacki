// A field's validation as the Studio would run it, for the rules its schema
// states (sanityRules.ts): what is wrong, said plainly, and whether it blocks
// publishing. The checks are the rule builder's own meanings — a minimum on
// text is characters, on a list is items, on a number is the value.

import { assert } from '../../../shared/core/assert';
import {
  remoteList,
  remoteObject,
  type RemoteRule,
  type RemoteSchemaField,
  type RemoteValue,
} from '../../../shared/properties/cmsRemoteSchema';
import type { RemoteDocument } from '../../../shared/properties/cmsRemote';
import { fieldTitle, isEmptyValue } from './remoteValues';

export interface RemoteProblem {
  readonly level: RemoteRule['level'];
  readonly message: string;
}

/** What is wrong with one field's value, by its rules; nothing when it passes. */
export function problemsOf(
  field: Pick<RemoteSchemaField, 'rules'>,
  value: RemoteValue | undefined,
): RemoteProblem[] {
  const problems: RemoteProblem[] = [];
  for (const rule of field.rules) {
    const message = check(rule, value);
    if (message !== undefined) {
      problems.push({ level: rule.level, message });
    }
  }
  assert(problems.length <= field.rules.length, 'Each rule reports at most once');
  return problems;
}

/** The errors that keep a document from being published, each named by its field. */
export function publishBlockers(document: RemoteDocument): string[] {
  return document.fields.flatMap((field) =>
    problemsOf(field, field.value)
      .filter((problem) => problem.level === 'error')
      .map((problem) => `${fieldTitle(field)}: ${problem.message}`),
  );
}

function check(rule: RemoteRule, value: RemoteValue | undefined): string | undefined {
  // An empty field breaks only `required`; every other rule checks a value that is there.
  if (isEmptyValue(value)) {
    return rule.kind === 'required' ? 'Required' : undefined;
  }
  switch (rule.kind) {
    case 'required':
      return undefined;
    case 'min':
    case 'max':
    case 'length':
      return limitProblem(rule.kind, rule.limit, value);
    case 'email':
      return typeof value === 'string' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
        ? 'Not an email address'
        : undefined;
    case 'uri':
      return typeof value === 'string' && !validLink(value, rule) ? 'Not a valid link' : undefined;
    case 'unique':
      return duplicated(value) ? 'Items must be unique' : undefined;
    case 'integer':
      return typeof value === 'number' && !Number.isInteger(value)
        ? 'Must be a whole number'
        : undefined;
    case 'positive':
      return typeof value === 'number' && value < 0 ? 'Must be positive' : undefined;
    default: {
      const exhaustive: never = rule;
      return exhaustive;
    }
  }
}

function limitProblem(
  kind: 'min' | 'max' | 'length',
  limit: number,
  value: RemoteValue | undefined,
): string | undefined {
  const list = remoteList(value);
  const measured = list?.length ?? (typeof value === 'string' ? value.length : value);
  if (typeof measured !== 'number') {
    return undefined;
  }
  const unit = list !== undefined ? ' items' : typeof value === 'string' ? ' characters' : '';
  if (kind === 'min') {
    return measured < limit ? `At least ${limit}${unit}` : undefined;
  }
  if (kind === 'max') {
    return measured > limit ? `At most ${limit}${unit}` : undefined;
  }
  return measured === limit ? undefined : `Exactly ${limit}${unit}`;
}

function validLink(value: string, rule: Extract<RemoteRule, { kind: 'uri' }>): boolean {
  if (value.startsWith('/')) {
    return rule.relative;
  }
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value)?.[1]?.toLowerCase();
  if (scheme === undefined) {
    return false;
  }
  return rule.schemes.includes(scheme);
}

// Items compared by content, ignoring the keys Sanity gives each one.
function duplicated(value: RemoteValue | undefined): boolean {
  const items = remoteList(value) ?? [];
  const seen = new Set(
    items.map((item) => {
      const object = remoteObject(item);
      if (object === undefined) {
        return JSON.stringify(item);
      }
      return JSON.stringify(Object.entries(object).filter(([key]) => key !== '_key'));
    }),
  );
  return seen.size < items.length;
}
