// The selected component instance: its props and variants, switched freely and rendered again by the dev
// server for this frame only (designInstances.ts), and "Unlink", which turns this one instance into plain
// elements while every other instance stays a component.
import { useState } from 'react';
import Dropdown from '../../../ui/Dropdown';
import SegmentedControl from '../../../ui/SegmentedControl';
import { Switch } from '../../../ui/Switch';
import TipAnchor from '../../../ui/TipAnchor';
import type { DesignJson } from '../../../../shared/designMode/designModeContract';
import { instanceKeyOf, unlinkInstance } from '../model/designDom';
import type { DesignInstanceInfo, FrameId } from '../model/designTypes';
import { commitFrame, frameDocument, instanceInfo } from '../runtime/designSession';
import { currentProps, planRerender } from '../runtime/designInstances';
import type { DesignWords } from '../i18n/designWords';
import { useDesignActions, type DesignPropField } from './designActions';
import { UnlinkIcon, ResetIcon } from './designIcons';

export function DesignComponentPanel({ frame, element, words }: { readonly frame: FrameId; readonly element: Element; readonly words: DesignWords }) {
  const actions = useDesignActions();
  const [busy, setBusy] = useState(false);
  const key = instanceKeyOf(element);
  const info = key === undefined ? undefined : instanceInfo(frame, key);
  const document = frameDocument(frame);
  if (key === undefined || info === undefined || document === undefined) {
    return undefined;
  }
  const fields = actions.components.find((component) => component.path === info.component)?.fields ?? [];
  const values = currentProps(document, key, info);
  const change = async (next: Readonly<Record<string, DesignJson>>) => {
    setBusy(true);
    try {
      const plan = await planRerender(document, key, info, next);
      if (!plan.ok) {
        actions.toast(words('toast.renderFailed', { detail: plan.detail.slice(0, 200) }), 'error');
        return;
      }
      commitFrame(frame, plan.apply);
    } finally {
      setBusy(false);
    }
  };
  const setProp = (name: string, value: DesignJson | undefined) => {
    const next: Record<string, DesignJson> = { ...values };
    if (value === undefined) {
      delete next[name];
    } else {
      next[name] = value;
    }
    void change(next);
  };
  return (
    <section className={`dm-section dm-component${busy ? ' is-busy' : ''}`} aria-busy={busy}>
      <div className="dm-component-head">
        <div className="dm-component-name">
          <span>{info.name}</span>
          <span className="dm-component-file">{info.component}</span>
        </div>
        <TipAnchor text={words('component.unlinkTip')}>
          <button
            type="button"
            className="ghost dm-icon-button"
            aria-label={words('component.unlink')}
            onClick={() =>
              commitFrame(frame, (target) => {
                unlinkInstance(target, key, info.component);
                return undefined;
              })
            }
          >
            <UnlinkIcon size={16} />
          </button>
        </TipAnchor>
        <TipAnchor text={words('component.resetProps')}>
          <button
            type="button"
            className="ghost dm-icon-button"
            aria-label={words('component.resetProps')}
            disabled={busy}
            onClick={() => void change(info.props)}
          >
            <ResetIcon size={16} />
          </button>
        </TipAnchor>
      </div>
      {fields.length === 0 && Object.keys(info.codeProps).length === 0 ? (
        <div className="dm-muted">{words('component.noProps')}</div>
      ) : (
        <div className="dm-props">
          {fields.map((field) => (
            <PropRow
              key={field.name}
              field={field}
              info={info}
              value={values[field.name]}
              words={words}
              disabled={busy}
              onChange={(value) => setProp(field.name, value)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function PropRow({
  field,
  info,
  value,
  words,
  disabled,
  onChange,
}: {
  readonly field: DesignPropField;
  readonly info: DesignInstanceInfo;
  readonly value: DesignJson | undefined;
  readonly words: DesignWords;
  readonly disabled: boolean;
  readonly onChange: (value: DesignJson | undefined) => void;
}) {
  const code = info.codeProps[field.name];
  const shown = value ?? field.defaultValue;
  let control: React.ReactNode;
  if (code !== undefined && value === undefined) {
    control = (
      <TipAnchor text={words('component.setInCodeTip', { code })}>
        <span className="dm-muted">{words('component.setInCode')}</span>
      </TipAnchor>
    );
  } else if (field.kind === 'choice') {
    const options = field.options;
    control =
      options.length <= 3 && options.every((option) => option.length <= 10) ? (
        <SegmentedControl
          options={options.map((option) => ({ value: option, label: option }))}
          value={typeof shown === 'string' ? shown : ''}
          ariaLabel={field.name}
          disabled={disabled}
          onChange={(next) => onChange(next)}
        />
      ) : (
        <Dropdown
          value={typeof shown === 'string' ? shown : ''}
          options={[{ value: '', label: words('component.unset') }, ...options.map((option) => ({ value: option, label: option }))]}
          ariaLabel={field.name}
          disabled={disabled}
          onChange={(next) => onChange(next === '' ? undefined : next)}
        />
      );
  } else if (field.kind === 'boolean') {
    control = <Switch label={field.name} checked={shown === true} disabled={disabled} onToggle={() => onChange(!(shown === true))} />;
  } else if (field.kind === 'number' || field.kind === 'text') {
    control = (
      <input
        className="dm-field-input"
        defaultValue={shown === undefined || shown === null ? '' : String(shown)}
        key={String(shown)}
        disabled={disabled}
        placeholder={words('component.unset')}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.currentTarget.blur();
          }
        }}
        onBlur={(event) => {
          const text = event.currentTarget.value;
          const next = field.kind === 'number' ? (text.trim() === '' ? undefined : Number(text)) : text === '' ? undefined : text;
          if (next !== shown && !(typeof next === 'number' && !Number.isFinite(next))) {
            onChange(next);
          }
        }}
      />
    );
  } else {
    control = <span className="dm-muted">{words('component.setInCode')}</span>;
  }
  return (
    <div className="dm-row">
      <TipAnchor text={field.doc ?? field.name}>
        <span className="dm-row-label">{field.name}</span>
      </TipAnchor>
      <div className="dm-row-control">{control}</div>
    </div>
  );
}
