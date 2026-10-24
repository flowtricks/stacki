import { PropValuePolicyContext } from './propValuePolicy';
import { PropPreviewContext } from './propPreviewContext';
// The control a prop field shows for its kind of value: a binding, style,
// attribute, class, slot, an option, a boolean, a number, a link, media, an
// imported asset, an object, a list, an expression or text (PropField.tsx).

import React, { useContext, useEffect, useState } from 'react';
import { assert } from '../../../shared/core/assert';
import { definedFields } from '../../../shared/core/boundary';
import { resolveAssetImport } from '../../ipc/assetBridge';
import { BindField, ExprValueField } from './propBindings';
import { ObjectAttrsField, parseObjectLiteral, serializeObjectLiteral } from './propAttributes';
import { looksLikeAssetPath, mediaKindFor } from '../../ui/AssetThumb';
import AssetField from '../../ui/AssetField';
import LinkField from './LinkField';
import ListField from './ListField';
import ObjectField from './ObjectField';
import ClassInput from './ClassInput';
import Dropdown from '../../ui/Dropdown';
import AutoTextarea from '../../ui/AutoTextarea';
import HtmlField from '../../ui/HtmlField';
import DateField from '../../ui/DateField';
import { containsHTML } from '../../ui/htmlFieldModel';
import { calendarValue } from '../../ui/dateFieldModel';
import SegSwitch from './SegSwitch';
import StyleEditor, { collapseDeclarations } from './StyleEditor';
import { ChevronDownIcon } from '../../ui/Icons';
import {
  type AssetImportFieldProps,
  attrText,
  mediaWord,
  boundsHint,
  type PropControlState,
  numberControlBounds,
} from './propFieldModel';

export function AssetImportField({ binding, name, assetContext, onChange }: AssetImportFieldProps) {
  const [rel, setRel] = useState<string | undefined>(undefined);

  useEffect(() => {
    let live = true;
    setRel(undefined);
    if (!assetContext.projectPath || !assetContext.filePath) {
      return undefined;
    }
    void resolveAssetImport(assetContext.projectPath, assetContext.filePath, binding.spec).then(
      (result) => {
        if (live) {
          setRel(result.ok ? result.rel : undefined);
        }
      },
    );
    return () => {
      live = false;
    };
  }, [binding.spec, assetContext.projectPath, assetContext.filePath]);

  return (
    <AssetField
      value=""
      srcRel={rel}
      mediaKind={/\.(mp4|webm|mov|m4v)$/i.test(binding.spec) ? 'video' : 'image'}
      initialMode="asset"
      plainLabel="URL"
      projectPath={assetContext.projectPath ?? ''}
      onChange={(next, immediate) =>
        next === ''
          ? onChange(undefined, immediate)
          : onChange({ type: 'string', value: next }, immediate)
      }
      onPickEntry={
        assetContext.onPickAsset &&
        ((picked) => assetContext.onPickAsset && assetContext.onPickAsset(name, picked))
      }
      onDimensions={(dimensions) => assetContext.onPickDimensions?.(name, dimensions)}
      onCurrentDimensions={(dimensions) =>
        /^src$/i.test(name) && assetContext.onSrcDimensions?.(dimensions)
      }
    />
  );
}
export function BindingControl({ state }: { readonly state: PropControlState }) {
  const {
    field,
    value,
    bindContext,
    dataContext,
    onChange,
    setCustom,
    bindApiRef,
    placeholderFor,
    label,
  } = state;

  return (
    <div className="props-field">
      {label}
      <BindField
        value={value}
        field={field}
        apiRef={bindApiRef}
        placeholder={placeholderFor(field)}
        bindContext={bindContext}
        dataContext={dataContext}
        onChange={(next, immediate) => {
          // Editing holds the field open: clearing a binding on the way to
          // another one shouldn't snap the control back mid-edit. An empty
          // value unsets the prop and leaves the field where it is.
          setCustom(true);
          onChange(next, immediate);
        }}
      />
    </div>
  );
}
export function StyleControl({ state }: { readonly state: PropControlState }) {
  const { value, onChange, label } = state;

  return (
    <div className="props-field">
      {label}
      <StyleEditor
        value={attrText(value) || ''}
        placeholder="color: red;"
        onChange={(text) => {
          const flat = collapseDeclarations(text);
          // Nothing left in it means no attribute at all — an element never
          // asked for an empty style="" and shouldn't carry one.
          if (!flat) {
            onChange(undefined, true);
          } else {
            onChange({ type: 'string', value: flat }, false);
          }
        }}
      />
    </div>
  );
}
export function AttributeControl({ state }: { readonly state: PropControlState }) {
  const { field, value, bindContext, assetContext, onChange, pill, menu } = state;

  const source = value?.type === 'expr' ? value.value : undefined;
  const entries =
    source !== undefined
      ? parseObjectLiteral(source)
      : (parseObjectLiteral(typeof field.default === 'string' ? field.default : '{}') ?? []);
  if (entries) {
    return (
      <ObjectAttrsField
        pill={pill}
        menu={menu}
        entries={entries}
        bindContext={bindContext}
        projectPath={assetContext?.projectPath}
        onCommit={(next) =>
          next.length
            ? onChange({ type: 'expr', value: serializeObjectLiteral(next) }, true)
            : onChange(undefined, true)
        }
      />
    );
  }
  // Unparsable (nested objects, spreads) — fall through to the generic
  // expression field below.

  return undefined;
}
export function ClassControl({ state }: { readonly state: PropControlState }) {
  const { value, projectClasses, onChange, label } = state;

  return (
    <div className="props-field">
      {label}
      <ClassInput
        value={attrText(value) || ''}
        suggestions={projectClasses || []}
        onChange={(next, immediate) =>
          next.trim()
            ? onChange({ type: 'string', value: next }, immediate)
            : onChange(undefined, true)
        }
      />
    </div>
  );
}
export function SlotControl({ state }: { readonly state: PropControlState }) {
  const { value, slotOptions, onChange, label } = state;
  assert(slotOptions?.length, 'Slot control: slots exist');

  const raw = attrText(value);
  const named = slotOptions.filter((slot) => slot !== 'default');
  // Keep an out-of-list current value selectable rather than losing it.
  const choices = [
    { value: '', label: 'default', dim: true },
    ...(raw && raw !== 'default' && !named.includes(raw) ? [{ value: raw, label: raw }] : []),
    ...named.map((slot) => ({ value: slot, label: slot })),
  ];
  return (
    <div className="props-field">
      {label}
      <Dropdown
        value={raw && raw !== 'default' ? raw : ''}
        options={choices}
        onChange={(next) =>
          next === '' ? onChange(undefined, true) : onChange({ type: 'string', value: next }, true)
        }
      />
    </div>
  );
}
export function EnumControl({ state }: { readonly state: PropControlState }) {
  const preview = useContext(PropPreviewContext);
  const policy = useContext(PropValuePolicyContext);
  const { field, value, onChange, placeholderFor, label } = state;
  assert(field.options?.length, 'Enum control: options exist');

  const renderedDefault =
    value === undefined && field.name === 'type' ? state.assetContext?.layoutType : undefined;
  const defaultText =
    renderedDefault ?? (field.default !== undefined ? String(field.default) : undefined);
  const raw = attrText(value);
  // Exactly two options, one of them the default: the same shape as a
  // boolean — an either/or with a known resting state — so it reads as one.
  // Only when what's set is one of the two; an out-of-schema value has to
  // stay visible, and the dropdown is the only field that can show it.
  if (
    field.options.length === 2 &&
    (policy === 'defaults' || (defaultText !== undefined && field.options.includes(defaultText))) &&
    (raw === undefined || field.options.includes(raw))
  ) {
    const current = raw ?? defaultText;
    return (
      <div className="props-field">
        {label}
        <SegSwitch
          options={field.options.map((option) => ({ value: option, label: option }))}
          current={current}
          onPick={(next) =>
            // Defaults recipes retain every explicit choice.
            policy === 'instance' && next === defaultText
              ? onChange(undefined, true)
              : onChange({ type: field.numeric ? 'expr' : 'string', value: next }, true)
          }
        />
      </div>
    );
  }
  // Only ordinary instances encode the default as an omitted prop.
  const omittedDefault = policy === 'instance' ? defaultText : undefined;
  // An unset recipe uses the placeholder so choosing its fallback still commits.
  const selected = raw ?? (policy === 'instance' ? (defaultText ?? '') : '');
  const selectedOption = selected === omittedDefault ? '' : selected;
  // Keep an out-of-schema current value selectable rather than losing it.
  const choices =
    raw === undefined || field.options.includes(raw) ? field.options : [raw, ...field.options];
  return (
    <div className="props-field">
      {label}
      <Dropdown
        value={selectedOption}
        {...(preview
          ? {
              onPrepare: () =>
                preview.prepare(
                  field.name,
                  choices.map((option) =>
                    option === omittedDefault ? undefined : field.numeric ? Number(option) : option,
                  ),
                ),
              onPreview: (next: string) =>
                preview.hover(next === '' ? undefined : field.numeric ? Number(next) : next),
              onCancelPreview: preview.cancel,
              onCommitPreview: preview.commit,
            }
          : {})}
        // Says what happens when nothing is picked. For a conditional
        // default that's the condition itself — better than naming one of
        // the two answers as if it were the only one.
        placeholder={renderedDefault ?? (placeholderFor(field) || '(not set)')}
        options={choices.map((option) => ({
          value: option === omittedDefault ? '' : option,
          label: option,
        }))}
        // A union of numbers is still numbers: the component is typed for one,
        // so it has to be written `cols={3}`, not `cols="3"`.
        onChange={(next) =>
          next === ''
            ? onChange(undefined, true)
            : onChange({ type: field.numeric ? 'expr' : 'string', value: next }, true)
        }
      />
    </div>
  );
}
export function BooleanControl({ state }: { readonly state: PropControlState }) {
  const policy = useContext(PropValuePolicyContext);
  const { field, value, onChange, label } = state;

  // Instances omit redundant fallbacks; recipes keep explicit choices so they
  // remain visible as set and survive future changes to the Astro fallback.
  // Show the effective boolean while the label tracks only an explicit override.
  const fallback = !!field.default;
  const current = value ? value.type !== 'expr' || value.value === 'true' : fallback;
  return (
    <div className="props-field">
      {label}
      <SegSwitch
        options={[
          { value: true, label: 'True' },
          { value: false, label: 'False' },
        ]}
        current={current}
        onPick={(next) =>
          policy === 'instance' && next === fallback
            ? onChange(undefined, true)
            : onChange({ type: 'expr', value: next ? 'true' : 'false' }, true)
        }
      />
    </div>
  );
}
export function NumberControl({ state }: { readonly state: PropControlState }) {
  const model = numberControlState(state);
  return <NumberControlView state={model} />;
}
export function numberControlState(state: PropControlState) {
  const { field, value, onChange, lastGoodRef, placeholderFor } = state;

  const numberText = value?.type === 'expr' ? value.value : (attrText(value) ?? '');
  // What the component says it will accept (see numberRules): a bound the
  // type can't express, read from the doc comment. Typing stays free — you
  // have to be able to pass through "-" or "1." on the way to a real number
  // — and the check happens when the value is committed, on Enter or on
  // leaving the field.
  const { bounded, allows, clamp } = numberControlBounds(field);
  // The last value that was allowed, to fall back to. An empty field is
  // allowed — it means "unset", and the component's own default applies.
  if (numberText === '' || allows(parseFloat(numberText))) {
    lastGoodRef.current = numberText;
  }
  const revertIfRejected = () => {
    if (!bounded || numberText === '' || allows(parseFloat(numberText))) {
      return;
    }
    const back = lastGoodRef.current;
    onChange(back === '' ? undefined : { type: 'expr', value: back }, true);
  };
  // One place decides what a step does, so the arrow keys and the buttons
  // can't drift apart. Shift ×10, Option ÷10 — the modifiers the style
  // panel's number fields already use.
  const step = (
    direction: number,
    mods: { readonly shiftKey: boolean; readonly altKey: boolean },
    from: string,
  ) => {
    const size = mods.shiftKey ? 10 : mods.altKey ? 0.1 : 1;
    const current = parseFloat(from);
    // An empty field steps from the value it is SHOWING — the placeholder is
    // the effective value (the source image's 115, the component's default),
    // so ▲ on a blank width goes to 116, not 1.
    const shown = parseFloat(placeholderFor(field));
    const base = Number.isFinite(current)
      ? current
      : Number.isFinite(shown)
        ? shown
        : parseFloat(String(field.default)) || 0;
    // Round away float noise (e.g. 38.1 + 0.1 = 38.199999…), then keep the
    // result inside what the component accepts — a step is an applied value,
    // so it should never land somewhere the field would reject.
    const next = Math.round((base + direction * size) * 1e6) / 1e6;
    onChange({ type: 'expr', value: String(bounded ? clamp(next) : next) });
  };
  const onStepKey = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      revertIfRejected();
      return;
    }
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') {
      return;
    }
    event.preventDefault();
    step(event.key === 'ArrowUp' ? 1 : -1, event, event.currentTarget.value);
  };
  return { ...state, numberText, revertIfRejected, onStepKey, step };
}
export function NumberControlView({
  state,
}: {
  readonly state: ReturnType<typeof numberControlState>;
}) {
  const { label, numberText, placeholderFor, field, onStepKey, revertIfRejected, onChange, step } =
    state;

  return (
    <div className="props-field">
      {label}
      {/* type=text, not number: the native spinner can't be styled, ignores
            the modifier steps, and its scroll-to-change fires while scrolling
            the panel. inputMode keeps the numeric keypad on touch. */}
      <div className="num-field">
        <input
          type="text"
          inputMode="decimal"
          value={numberText}
          placeholder={placeholderFor(field)}
          onKeyDown={onStepKey}
          onBlur={revertIfRejected}
          title={boundsHint(field)}
          onChange={(event) =>
            event.target.value === ''
              ? onChange(undefined)
              : onChange({ type: 'expr', value: event.target.value })
          }
        />
        <span className="num-steppers">
          {[1, -1].map((direction) => (
            <button
              key={direction}
              type="button"
              tabIndex={-1}
              aria-label={direction > 0 ? 'Increase' : 'Decrease'}
              title={`${direction > 0 ? 'Increase' : 'Decrease'} — ⇧ by 10, ⌥ by 0.1`}
              onClick={(event) => step(direction, event, numberText)}
            >
              <ChevronDownIcon
                size={11}
                style={direction > 0 ? { transform: 'rotate(180deg)' } : undefined}
              />
            </button>
          ))}
        </span>
      </div>
    </div>
  );
}
export function LinkControl({ state }: { readonly state: PropControlState }) {
  const { value, assetContext, linkContext, onChange, label } = state;
  assert(linkContext, 'Link control: context exists');

  return (
    <div className="props-field">
      {label}
      <LinkField
        {...(value === undefined ? {} : { value })}
        context={{ ...linkContext, projectPath: assetContext?.projectPath ?? '' }}
        onChange={onChange}
      />
    </div>
  );
}
export function MediaControl({ state }: { readonly state: PropControlState }) {
  const policy = useContext(PropValuePolicyContext);
  const { assetContext, onChange, name, valueText, isMediaAttr, label } = state;
  assert(assetContext?.projectPath, 'Media control: project exists');
  const fallback = state.field.default ?? state.branchDefault;
  const fallbackValue =
    policy === 'instance' && !state.field.defaultExpr && typeof fallback === 'string'
      ? fallback
      : undefined;
  const renderedFallback = name === 'image' ? assetContext.layoutImage : undefined;

  const nodeName = String(assetContext.nodeName || '').toLowerCase();
  const mediaKind = looksLikeAssetPath(valueText)
    ? mediaKindFor(valueText)
    : /^(poster|image|logo|icon|avatar|thumb|thumbnail|photo|banner|cover)$/.test(mediaWord(name))
      ? 'image'
      : mediaWord(name) === 'video'
        ? 'video'
        : mediaWord(name) === 'audio'
          ? 'audio'
          : nodeName === 'video'
            ? 'video'
            : nodeName === 'audio'
              ? 'audio'
              : ['img', 'source', 'picture', 'image'].includes(nodeName)
                ? 'image'
                : 'asset';
  return (
    <div className="props-field">
      {label}
      <AssetField
        value={state.isSet ? valueText : undefined}
        fallbackValue={renderedFallback ?? fallbackValue}
        mediaKind={mediaKind}
        // A non-media prop only lands here because its value is an asset
        // path, so open in asset mode; "Text" is the way back out.
        {...definedFields({ initialMode: isMediaAttr ? undefined : ('asset' as const) })}
        plainLabel={isMediaAttr ? 'URL' : 'Text'}
        projectPath={assetContext.projectPath ?? ''}
        onChange={(next, immediate) =>
          next === ''
            ? onChange(undefined, immediate)
            : onChange({ type: 'string', value: next }, immediate)
        }
        onPickEntry={
          assetContext.onPickAsset &&
          ((picked) => assetContext.onPickAsset && assetContext.onPickAsset(name, picked))
        }
        onDimensions={(dimensions) => assetContext.onPickDimensions?.(name, dimensions)}
        onCurrentDimensions={(dimensions) =>
          /^src$/i.test(name) && assetContext.onSrcDimensions?.(dimensions)
        }
      />
    </div>
  );
}
export function ImportedAssetControl({ state }: { readonly state: PropControlState }) {
  const { assetContext, onChange, name, assetBinding, label } = state;
  assert(assetContext, 'Imported asset: context exists');
  assert(assetBinding, 'Imported asset: binding exists');

  return (
    <div className="props-field">
      {label}
      <AssetImportField
        binding={assetBinding}
        name={name}
        assetContext={assetContext}
        onChange={onChange}
      />
    </div>
  );
}
export function ObjectControl({ state }: { readonly state: PropControlState }) {
  const { onChange, valueText, label } = state;

  return (
    <div className="props-field">
      {label}
      <ObjectField
        value={valueText}
        onChange={(text, immediate) => onChange({ type: 'expr', value: text }, immediate)}
      />
    </div>
  );
}
export function ListControl({ state }: { readonly state: PropControlState }) {
  const { field, onChange, valueText, placeholderFor, label } = state;

  return (
    <div className="props-field">
      {label}
      <ListField
        value={valueText}
        placeholder={placeholderFor(field)}
        onChange={(text, immediate) => onChange({ type: 'expr', value: text }, immediate)}
      />
    </div>
  );
}
export function ExpressionControl({ state }: { readonly state: PropControlState }) {
  const { field, dataContext, onChange, valueText, placeholderFor, label } = state;

  return (
    <div className="props-field">
      {label}
      <ExprValueField
        value={valueText}
        placeholder={placeholderFor(field)}
        dataContext={dataContext}
        onChange={onChange}
      />
    </div>
  );
}
export function TextControl({ state }: { readonly state: PropControlState }) {
  const { field, onChange, name, valueText, placeholderFor, label } = state;
  // A bare attribute has no authored text value; preserve that absence in the input.
  const text = state.value?.type === 'bare' ? undefined : valueText;
  const content = text ?? '';
  if (containsHTML(content)) {
    return (
      <div className="props-field">
        {label}
        <HtmlField
          value={content}
          label={name}
          onChange={(next) => onChange({ type: 'string', value: next })}
        />
      </div>
    );
  }
  if (calendarValue(content)) {
    return (
      <div className="props-field">
        {label}
        <DateField
          value={content}
          label={name}
          onChange={(next) => onChange({ type: 'string', value: next })}
        />
      </div>
    );
  }
  const long =
    String(valueText).length > 48 || /text|description|content|body|paragraph/i.test(name);
  return (
    <div className="props-field">
      {label}
      {long ? (
        <AutoTextarea
          value={text}
          placeholder={placeholderFor(field)}
          onChange={(event) => onChange({ type: 'string', value: event.target.value })}
        />
      ) : (
        <input
          value={text}
          placeholder={placeholderFor(field)}
          onChange={(event) => onChange({ type: 'string', value: event.target.value })}
        />
      )}
    </div>
  );
}
