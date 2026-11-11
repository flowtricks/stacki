// The stacki ESLint plugin: AGENTS.md rules that stock ESLint cannot express.
// Each rule cites the section it enforces; docs/enforcement.md maps every
// AGENTS.md rule to the mechanism that checks it. Loaded directly by
// eslint.config.mjs under Node's type stripping (Node >= 22.18), so there is
// no build step between editing a rule and running it.

import { boundedRecursion } from './boundedRecursion.mts';
import { commentSentence, requireDisableReason } from './comments.mts';
import { naming } from './naming.mts';
import { noBooleanParameter } from './noBooleanParameter.mts';
import { noNativeSelect } from './noNativeSelect.mts';
import { noNull } from './noNull.mts';
import { sourceLayers } from './sourceLayers.mts';
import { callbackLast, catchUnknown, divisionIntent, noCompoundAssert, noEnum, noOverloads, noPartialParameter, noUnboundedLoop } from './statements.mts';

export const rules = {
  'bounded-recursion': boundedRecursion,
  'callback-last': callbackLast,
  'catch-unknown': catchUnknown,
  'comment-sentence': commentSentence,
  'division-intent': divisionIntent,
  naming,
  'no-boolean-parameter': noBooleanParameter,
  'no-compound-assert': noCompoundAssert,
  'no-enum': noEnum,
  'no-native-select': noNativeSelect,
  'no-null': noNull,
  'no-overloads': noOverloads,
  'no-partial-parameter': noPartialParameter,
  'no-unbounded-loop': noUnboundedLoop,
  'require-disable-reason': requireDisableReason,
  'source-layers': sourceLayers,
} as const;

export default {
  meta: { name: 'eslint-plugin-stacki', version: '1.0.0' },
  rules,
};
