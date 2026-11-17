// A prop's Default value set by conditions, drawn and edited with the same
// purple Conditional chip, summary and Value conditions editor an attribute
// field uses (ConditionalValue.tsx), so a designer who made a Heading's class
// conditional already knows it: "If Variant = Play and Pressed is true ↳ Pause".
//
// The host (the Properties panel's Default value, PropertyDefault.tsx) says
// what to do with a closed editor's model: write it into the destructure, or
// into the lookup table the component already reads (conditionalDefault.ts).
// A default the model cannot hold stays its code, read-only, under one word.

import { useMemo, useRef } from 'react';
import type { ComponentProperty } from '../../../shared/properties/propertyEditing';
import type { Attr } from '../../../shared/page/pageNode';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { CodeInline } from '../../ui/CodeBlock';
import { emitConditionalExpression, readConditionalExpression, type ConditionalValue } from '../../editor/conditionalValue';
import { ConditionalEditor, ConditionalField } from './ConditionalValue';
import { newGroup, resultOfAttr, conditionProps } from './conditionalModel';
import { conditionSchema } from './conditionalDefault';
import type { RichContext } from './RichContent';
import './conditionalValue.css';

/** The context a default's conditions are chosen in: the component's frontmatter and its props. */
export function useDefaultConditionContext(frontmatter: string, properties: readonly ComponentProperty[]): RichContext {
  return useMemo(() => ({ frontmatter, propsSchema: conditionSchema(properties) }), [frontmatter, properties]);
}

/** A conditional default: its chip and summary, reopening the editor; `onApply` gets the model the editor closed on. */
export function ConditionalDefaultField(props: {
  readonly model: ConditionalValue;
  readonly context: RichContext;
  readonly quote: '"' | "'";
  readonly onApply: (model: ConditionalValue) => void;
}) {
  const value: Attr = { type: 'expr', value: emitConditionalExpression(props.model, { quote: props.quote }) };
  return (
    <ConditionalField model={props.model} value={value} bindContext={props.context} language="text" onApply={(next) => props.onApply(modelOfAttr(next))} />
  );
}

/** The editor opened from the Default value's branch button on a plain default, which stays the Else. */
export function ConditionalDefaultStart(props: {
  readonly defaultResult: Attr | undefined;
  readonly context: RichContext;
  readonly onApply: (model: ConditionalValue) => void;
  readonly onClose: () => void;
}) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const catalog = useMemo(() => conditionProps(props.context.frontmatter ?? '', props.context.propsSchema ?? []), [props.context]);
  const otherwise = resultOfAttr(props.defaultResult) ?? { kind: 'none', word: 'undefined' };
  return (
    <>
      <span ref={anchorRef} className="conditional-anchor" />
      <ConditionalEditor
        anchorRef={anchorRef}
        // A default usually depends on a choice (`variant`): the first group starts on the first prop of options.
        start={{ groups: [newGroup([...catalog.filter((prop) => prop.kind === 'option'), ...catalog.filter((prop) => prop.kind !== 'option')])], otherwise }}
        model={undefined}
        value={props.defaultResult}
        bindContext={props.context}
        language="text"
        onApply={(next) => props.onApply(modelOfAttr(next))}
        onClose={props.onClose}
      />
    </>
  );
}

/** A default computed by code the conditions cannot show: the code, highlighted and read-only, under one word. */
export function ComputedDefault({ code }: { readonly code: string }) {
  const translate = useTranslate();
  return (
    <div className="conditional-computed" role="group" aria-label={translate('componentProps.defaults.computed')}>
      <span className="conditional-badge">{translate('componentProps.defaults.computed')}</span>
      <CodeInline text={code} language="typescript" className="conditional-computed-code" />
    </div>
  );
}

// What the editor wrote, as a model: a chain, a plain value (its Else), or nothing.
function modelOfAttr(attr: Attr | undefined): ConditionalValue {
  if (attr?.type === 'expr') {
    const chain = readConditionalExpression(attr.value);
    if (chain !== undefined) {
      return chain;
    }
  }
  return { groups: [], otherwise: resultOfAttr(attr) ?? { kind: 'none', word: 'undefined' } };
}
