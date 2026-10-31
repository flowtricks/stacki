// A CMS field drawn as a component prop field, so the two read and work alike:
// the same label (blue once set), the same help `?`, the same text box, number
// stepper, True/False switch and dropdown, and the same `{}` beside a dropdown
// to type a value it does not list. Text, numbers, switches and choices go
// through the props panel's own PropField; everything else (images, lists,
// references, rich text, groups) keeps its own control under the same label
// row (CmsFieldFrame).
//
// CMS values are plain data, never code, so code access is off: there is no
// data-binding handle, and `{}` opens a plain text box rather than the
// expression editor.
import { useState, type ReactNode } from 'react';
import { assert } from '../../../shared/core/assert';
import type { Attr } from '../../../shared/page/pageNodeTypes';
import { CodeAccess } from '../../ui/CodeAccess';
import { BracesIcon, DropletIcon, FieldSwitchIcon } from '../../ui/Icons';
import { CmsColorInput, HEX_COLOR } from './CmsColorInput';
import PropField from '../props/PropField';
import PropTip from '../props/PropTip';
import { PropHoverPreviewContext, PropValuePolicyContext } from '../props/propValuePolicy';
import { suggestedOptions } from './cmsSuggestions';

export type CmsScalar = string | number | boolean;
export type CmsScalarKind = 'string' | 'text' | 'number' | 'boolean';

export function CmsPropField(props: {
  readonly name: string;
  /** The `?` beside the name: what the field is for, and whether it is required. */
  readonly help: string;
  readonly kind: CmsScalarKind;
  /** Fixed choices (a schema's `options.list`); none means free text, or suggestions. */
  readonly options: readonly string[];
  readonly value: CmsScalar | undefined;
  readonly onChange: (value: CmsScalar | undefined) => void;
}) {
  const { kind, value } = props;
  const text = value === undefined ? undefined : String(value);
  const suggested = kind === 'string' ? suggestedOptions(props.name, text) : [];
  const options = props.options.length > 0 ? props.options : suggested;
  assert(options.length <= 256, 'A CMS field offers a dropdown’s worth of choices');
  const type = options.length > 0 ? 'enum' : kind;
  const color = kind === 'string' && options.length === 0 && looksLikeColor(props.name, text);
  if (color) {
    return <CmsColorField {...props} value={text ?? ''} />;
  }
  if (kind === 'boolean') {
    // A CMS switch is on or off, so it is a toggle rather than a True/False pair.
    return (
      <CmsFieldFrame
        name={props.name}
        help={props.help}
        icon={<FieldSwitchIcon size={12} />}
        set={value !== undefined}
      >
        <CmsToggle on={value === true} onChange={(next) => props.onChange(next)} />
      </CmsFieldFrame>
    );
  }
  return (
    // Explicit choices stay explicit, as in a recipe: a CMS stores what was picked.
    <PropValuePolicyContext.Provider value="defaults">
      <CodeAccess.Provider value={false}>
        <PropHoverPreviewContext.Provider value={false}>
          <PropField
            field={{
              name: props.name,
              type,
              optional: true,
              ...(options.length > 0 ? { options } : {}),
              ...(props.help ? { doc: props.help } : {}),
            }}
            value={toAttr(kind, value)}
            onChange={(next) => {
              // A number half-typed ("-", "1e") is not one yet: keep the last one.
              if (kind === 'number' && partialNumber(next)) {
                return;
              }
              props.onChange(fromAttr(kind, next));
            }}
          />
        </PropHoverPreviewContext.Provider>
      </CodeAccess.Provider>
    </PropValuePolicyContext.Provider>
  );
}

// A colour field: the picker, or with `{}` a plain box for any other value,
// as a prop dropdown has (a CMS may hold `transparent` or a variable there).
function CmsColorField(props: {
  readonly name: string;
  readonly help: string;
  readonly value: string;
  readonly onChange: (value: CmsScalar | undefined) => void;
}) {
  const [plain, setPlain] = useState(false);
  const change = (next: string) => props.onChange(next === '' ? undefined : next);
  return (
    <CmsFieldFrame
      name={props.name}
      help={props.help}
      icon={<DropletIcon size={12} />}
      set={props.value !== ''}
      plain={{ on: plain, onToggle: () => setPlain(!plain), control: 'colour picker' }}
    >
      {plain ? (
        <input value={props.value} onChange={(event) => change(event.target.value)} />
      ) : (
        <CmsColorInput value={props.value} label={props.name} onChange={change} />
      )}
    </CmsFieldFrame>
  );
}

// A hex value, or an empty field named for a colour ("Main colour").
function looksLikeColor(name: string, text: string | undefined): boolean {
  if (text !== undefined && text !== '') {
    return HEX_COLOR.test(text.trim());
  }
  return /colou?r$/i.test(name.trim());
}

/** An on/off switch: the knob slides, and the word beside it says which. */
export function CmsToggle(props: {
  readonly on: boolean;
  readonly onChange: (on: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.on}
      className={`cms-toggle ${props.on ? 'on' : ''}`}
      onClick={() => props.onChange(!props.on)}
    >
      <span className="cms-toggle-knob" />
      <span className="cms-toggle-label">{props.on ? 'On' : 'Off'}</span>
    </button>
  );
}

/** Any other CMS control under the same label row a prop field has. */
export function CmsFieldFrame(props: {
  readonly name: string;
  /** The `?` beside the name: what the field is for, and whether it is required. */
  readonly help: string;
  readonly icon: ReactNode;
  readonly set: boolean;
  /** The props panel's `{}`: between the field's own control and a plain text box. */
  readonly plain?: {
    readonly on: boolean;
    readonly onToggle: () => void;
    readonly control: string;
  };
  readonly children: ReactNode;
}) {
  const { plain } = props;
  return (
    <div className="props-field">
      <label onClick={(event) => event.preventDefault()}>
        <span className={`prop-label${props.set ? ' set' : ''}`}>
          <span className="prop-label-icon">{props.icon}</span>
          {props.name}
        </span>
        <PropTip {...(props.help ? { text: props.help } : {})} />
        {plain && (
          <button
            type="button"
            className={`prop-expr-toggle${plain.on ? ' on' : ''}`}
            title={plain.on ? `Use the ${plain.control}` : 'Type any value'}
            aria-pressed={plain.on}
            onClick={plain.onToggle}
          >
            <BracesIcon size={12} />
          </button>
        )}
      </label>
      {props.children}
    </div>
  );
}

// A prop field holds text as a string and numbers and switches as code.
function toAttr(kind: CmsScalarKind, value: CmsScalar | undefined): Attr | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (kind === 'number' || kind === 'boolean') {
    return { type: 'expr', value: String(value) };
  }
  return { type: 'string', value: String(value) };
}

function fromAttr(kind: CmsScalarKind, attr: Attr | undefined): CmsScalar | undefined {
  if (attr === undefined || attr.type === 'bare' || attr.type === 'spread') {
    return undefined;
  }
  const text = attr.value;
  if (kind === 'boolean') {
    return text === 'true';
  }
  if (kind === 'number') {
    const number = Number(text);
    return text.trim() === '' || !Number.isFinite(number) ? undefined : number;
  }
  return text === '' ? undefined : text;
}

function partialNumber(attr: Attr | undefined): boolean {
  if (attr === undefined || attr.type === 'bare' || attr.type === 'spread') {
    return false;
  }
  return attr.value.trim() !== '' && !Number.isFinite(Number(attr.value));
}
