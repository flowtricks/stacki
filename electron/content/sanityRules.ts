// A field's validation as its schema states it, read from the source of its
// `validation: (rule) => rule.required().max(5)` without running it.
//
// The checks read are the ones Sanity's rule builder spells as plain calls:
// required, min, max, length, email, uri (with its schemes and whether relative
// links are allowed), unique, integer and positive. A chain ending in
// `.warning()` warns instead of blocking publishing, as in the Studio. A
// `.custom(…)` check is the Studio's own code and is not run here.

import { assert } from '../../shared/core/assert';
import { REMOTE_SCHEMA_LIMITS, type RemoteRule } from '../../shared/properties/cmsRemoteSchema';

const CALL = /\.(required|min|max|length|email|uri|unique|integer|positive)\(([^()]*)\)/g;

export function rulesOf(source: string | undefined): RemoteRule[] {
  if (source === undefined) {
    return [];
  }
  const level = /\.warning\(/.test(source) && !/\.error\(/.test(source) ? 'warning' : 'error';
  const rules: RemoteRule[] = [];
  for (const match of source.matchAll(CALL)) {
    const rule = ruleOf(match[1] ?? '', match[2] ?? '', level);
    if (rule !== undefined && rules.length < REMOTE_SCHEMA_LIMITS.rulesMax) {
      rules.push(rule);
    }
  }
  assert(rules.length <= REMOTE_SCHEMA_LIMITS.rulesMax, 'A field states few rules');
  return rules;
}

function ruleOf(name: string, args: string, level: RemoteRule['level']): RemoteRule | undefined {
  switch (name) {
    case 'required':
    case 'email':
    case 'unique':
    case 'integer':
    case 'positive':
      return { level, kind: name };
    case 'min':
    case 'max':
    case 'length': {
      // Only a literal limit is known; a limit computed by code is the Studio's.
      const limit = /^\s*(-?\d+(?:\.\d+)?)\s*$/.exec(args)?.[1];
      return limit === undefined ? undefined : { level, kind: name, limit: Number(limit) };
    }
    case 'uri': {
      const schemes = /scheme\s*:\s*\[([^\]]*)\]/.exec(args)?.[1];
      const named = [...(schemes ?? '').matchAll(/["'`]([a-z][a-z0-9+.-]{0,31})["'`]/g)].map(
        (scheme) => scheme[1] ?? '',
      );
      return {
        level,
        kind: 'uri',
        schemes: named.length > 0 ? named : ['http', 'https'],
        relative: /allowRelative\s*:\s*true/.test(args),
      };
    }
    default:
      return undefined;
  }
}
