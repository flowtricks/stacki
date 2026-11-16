// The line under a Content field whose text is printed from data: where editing it
// writes. It is the canvas cue's sentence at rest, so the Settings panel and the
// canvas never disagree about which source a change reaches. Reads only; typing in
// the field is unchanged.
import React from 'react';
import { useLiveValue } from '../../ui/liveValue';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { CodeInline } from '../../ui/CodeBlock';
import { canvasSourceTargets } from '../../ui/canvasTextSourceCue';

/** The path a content made of one `{path}` chip names, or undefined for any other content. */
export function singleChipPath(nodes: readonly { readonly kind: string; readonly value?: string }[]): string | undefined {
  const [only] = nodes;
  if (nodes.length !== 1 || only?.kind !== 'expr' || only.value === undefined) {
    return undefined;
  }
  const match = /^\{\s*([^{}]+?)\s*\}$/.exec(only.value);
  return match?.[1];
}

export function SourceHint({ expression }: { readonly expression: string | undefined }) {
  const translate = useTranslate();
  const targets = useLiveValue(canvasSourceTargets);
  const target = expression === undefined ? undefined : targets.get(expression);
  if (!target) {
    return undefined;
  }
  const path = target.file === '' ? target.expression : `${target.file} › ${target.expression}`;
  return (
    <div className="source-hint">
      <span>{translate('preview.text.source.label')}</span>
      <CodeInline text={path} language="typescript" className="source-hint-path" />
      {target.uses > 1 && <span className="source-hint-uses">{translate('preview.text.source.uses', { count: target.uses })}</span>}
    </div>
  );
}
