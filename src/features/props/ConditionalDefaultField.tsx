// A prop's Default value set by conditions, edited in the same Value
// conditions editor an attribute field opens (ConditionalValue.tsx), so a
// designer who made a Heading's class conditional already knows it. In the
// panel it is one compact line, the purple Conditional chip with its values
// after it ("Conditional  Pause, Play, Close…"); each option's own default is
// on its row in Controlled by, so no long summary is repeated here.
//
// The host (the Properties panel's Default value, PropertyDefault.tsx) says
// what to do with a closed editor's model: write it into the destructure, or
// into the lookup table the component already reads (conditionalDefault.ts).
// A default the model cannot hold stays its code, read-only, under one word.

import { useMemo, useRef, useState } from 'react';
import type { ComponentProperty } from '../../../shared/properties/propertyEditing';
import type { Attr } from '../../../shared/page/pageNode';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { CodeInline } from '../../ui/CodeBlock';
import { BranchIcon } from '../../ui/Icons';
import type { ValueChoice } from './ValueChoices';
import { emitConditionalExpression, readConditionalExpression, type ConditionalValue } from '../../editor/conditionalValue';
import { ConditionalEditor } from './ConditionalValue';
import { draftOf, newGroup, resultOfAttr, resultWords, conditionProps } from './conditionalModel';
import { conditionSchema } from './conditionalDefault';
import type { RichContext } from './RichContent';
import './conditionalValue.css';

const SUMMARY_VALUES_MAX = 6;

/** The context a default's conditions are chosen in: the component's frontmatter and its props. */
export function useDefaultConditionContext(frontmatter: string, properties: readonly ComponentProperty[]): RichContext {
  return useMemo(() => ({ frontmatter, propsSchema: conditionSchema(properties) }), [frontmatter, properties]);
}

/**
 * A conditional default: the Conditional chip with its values on one line,
 * opening the editor. `start` opens it already, on a draft of the model with
 * a group added (the Default for one option, asked for from its row).
 */
export function ConditionalDefaultField(props: {
  readonly model: ConditionalValue;
  readonly context: RichContext;
  readonly quote: '"' | "'";
  readonly start?: ConditionalValue | undefined;
  readonly onStarted?: (() => void) | undefined;
  readonly onApply: (model: ConditionalValue) => void;
  /** Values picked from a list (a Visibility's states), and the line that says them; the default is the values' words. */
  readonly valueChoices?: readonly ValueChoice[] | undefined;
  readonly summary?: string | undefined;
  readonly title?: string | undefined;
  /** Shown, never edited: the one word for why (a union the writer cannot keep in step). */
  readonly readonlyWord?: string | undefined;
}) {
  const translate = useTranslate();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const value: Attr = { type: 'expr', value: emitConditionalExpression(props.model, { quote: props.quote }) };
  const words = [
    ...new Set([...props.model.groups.map((group) => group.value), props.model.otherwise].filter((result) => result.kind !== 'none').map(resultWords)),
  ];
  const summary = props.summary ?? words.slice(0, SUMMARY_VALUES_MAX).join(', ') + (words.length > SUMMARY_VALUES_MAX ? '…' : '');
  const showing = props.readonlyWord === undefined && (open || props.start !== undefined);
  return (
    <div className="conditional-default" ref={anchorRef}>
      <button
        type="button"
        className="conditional-chip conditional-default-chip"
        aria-haspopup="dialog"
        aria-expanded={showing}
        title={summary === '' ? translate('props.conditional.edit') : summary}
        disabled={props.readonlyWord !== undefined}
        onClick={() => setOpen(!open)}
      >
        <BranchIcon size={11} />
        <span className="conditional-default-word">{props.readonlyWord ?? translate('props.conditional.chip')}</span>
        {summary !== '' && <span className="conditional-default-summary">{summary}</span>}
      </button>
      {showing && (
        <ConditionalEditor
          anchorRef={anchorRef}
          start={props.start === undefined ? undefined : draftOf(props.start)}
          model={props.model}
          value={value}
          bindContext={props.context}
          language="text"
          valueChoices={props.valueChoices}
          title={props.title}
          onApply={(next) => props.onApply(modelOfAttr(next))}
          onClose={() => {
            setOpen(false);
            props.onStarted?.();
          }}
        />
      )}
    </div>
  );
}

/** The editor opened on a plain default, which stays the Else; `start` seeds its groups (the Default for one option). */
export function ConditionalDefaultStart(props: {
  readonly defaultResult: Attr | undefined;
  readonly context: RichContext;
  readonly start?: ConditionalValue | undefined;
  readonly onApply: (model: ConditionalValue) => void;
  readonly onClose: () => void;
  readonly valueChoices?: readonly ValueChoice[] | undefined;
  readonly title?: string | undefined;
  /** The value a new first group gives, when the start is not seeded (a Visibility's Hide). */
  readonly firstValue?: ConditionalValue['otherwise'] | undefined;
}) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const catalog = useMemo(() => conditionProps(props.context.frontmatter ?? '', props.context.propsSchema ?? []), [props.context]);
  const otherwise = resultOfAttr(props.defaultResult) ?? { kind: 'none', word: 'undefined' };
  // A default usually depends on a choice (`variant`): a first group starts on the first prop of options.
  const fresh = newGroup([...catalog.filter((prop) => prop.kind === 'option'), ...catalog.filter((prop) => prop.kind !== 'option')]);
  const first = props.firstValue === undefined ? fresh : { ...fresh, value: props.firstValue };
  return (
    <>
      <span ref={anchorRef} className="conditional-anchor" />
      <ConditionalEditor
        anchorRef={anchorRef}
        start={props.start === undefined ? { groups: [first], otherwise } : draftOf({ ...props.start, otherwise })}
        model={undefined}
        value={props.defaultResult}
        bindContext={props.context}
        language="text"
        valueChoices={props.valueChoices}
        title={props.title}
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
