// Linking a list setting in a component to one of its properties, so each
// page using the component can set its own Filters, Sort, Show or Skip, as a
// builder's collection list settings link to component properties.
//
// An unlinked setting shows a purple dot beside its label (or on its field's
// corner); the dot opens "New Filters property" with a name to create it
// under. A linked setting shows as a purple bar instead (LoopLinked.tsx).
// The edits themselves are planned in optionsBinding.ts: a new property's
// default is the setting's current value, so the component looks the same
// until a page passes another.

import { useCallback, useState } from 'react';
import type { ReactNode, RefCallback } from 'react';
import { CheckIcon, CloseIcon, FieldNumberIcon, FilterIcon, PlusIcon, SortIcon } from '../../ui/Icons';
import AutoTextarea from '../../ui/AutoTextarea';
import { assert } from '../../../shared/core/assert';
import { SETTING_PROP_NAMES, settingTitle, type BindingChange } from '../../editor/optionsBinding';
import { curatedText, filterValueText, sortValueText, type LoopSetting, type SettingHome } from '../../editor/optionsQuery';
import type { LoopQuery } from '../../editor/loopQuery';
import { RowPopup } from './LoopRows';
import { useTranslate } from '../../lib/i18n/useTranslate';

/** What a section needs to offer linking: where each setting is, and how to change it. */
export interface BindingContext {
  readonly settings: Readonly<Record<LoopSetting, SettingHome>>;
  /** The component's name, heading the properties a setting can connect to. */
  readonly componentName: string;
  /** Why a name cannot be a new property, or undefined when it can. */
  readonly problemOf: (key: string) => string | undefined;
  /** The properties whose default this setting could read. */
  readonly connectable: (setting: LoopSetting) => readonly string[];
  /** A property's tooltip, as its tooltip comment says it. */
  readonly tooltipOf: (key: string) => string;
  readonly onChange: (change: BindingChange) => void;
  /** Renames a property or changes its tooltip; resolves with why it could not. */
  readonly onEditProperty?: ((key: string, edit: { readonly name: string; readonly description: string }) => Promise<string | undefined>) | undefined;
}

const NAME_SUFFIX_MAX = 100;

/** The icon a setting's purple bar and its menu show. */
export function settingIcon(setting: LoopSetting): ReactNode {
  switch (setting) {
    case 'filter':
      return <FilterIcon size={14} />;
    case 'sort':
      return <SortIcon size={14} />;
    case 'limit':
    case 'offset':
      return <FieldNumberIcon size={13} />;
    case 'curated':
      return <CheckIcon size={13} />;
    default: {
      const exhaustive: never = setting;
      return exhaustive;
    }
  }
}

/**
 * The setting's own editor over a value, for a new property's default: the
 * list's current value to start from, and how to draw the editor over another.
 */
export interface DraftEditor {
  readonly query: LoopQuery;
  readonly render: (query: LoopQuery, onChange: (query: LoopQuery) => void) => ReactNode;
}

const DIALOG_HEIGHT_PX_MAX = 560;

/** The dot offering to link an unlinked setting; nothing once it is linked. */
export function SettingDot(props: { readonly setting: LoopSetting; readonly binding: BindingContext | undefined; readonly draft: DraftEditor }) {
  const translate = useTranslate();
  const { binding, setting } = props;
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLButtonElement | undefined>(undefined);
  const attach = useCallback<RefCallback<HTMLButtonElement>>((element) => setAnchor(element ?? undefined), []);
  if (binding === undefined || binding.settings[setting].kind === 'prop') {
    return undefined;
  }
  const title = settingTitle(setting, translate);
  return (
    <>
      <button
        ref={attach}
        type="button"
        className={`loop-bind-dot${open ? ' on' : ''}`}
        title={translate('props.loop.binding.link', { title })}
        aria-label={translate('props.loop.binding.link', { title })}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen(!open)}
      >
        <span className="bind-dot" />
        <PlusIcon size={7} className="bind-plus" />
      </button>
      {open && (
        <RowPopup
          anchor={anchor}
          heightPxMax={DIALOG_HEIGHT_PX_MAX}
          label={translate('props.loop.binding.newProperty', { title })}
          onClose={() => setOpen(false)}
        >
          <NewProperty setting={setting} binding={binding} draft={props.draft} onDone={() => setOpen(false)} />
        </RowPopup>
      )}
    </>
  );
}

/**
 * A new property for a setting, as a builder asks for one: its name (checked
 * as it is typed), its tooltip, and its default, edited with the setting's own
 * editor and starting from what the list shows now. Nothing is written until
 * Create.
 */
export function NewProperty(props: {
  readonly setting: LoopSetting;
  readonly binding: BindingContext;
  readonly draft: DraftEditor;
  readonly onDone: () => void;
}) {
  const translate = useTranslate();
  const { binding, setting } = props;
  const title = settingTitle(setting, translate);
  const [name, setName] = useState(() => freeKey(SETTING_PROP_NAMES[setting], binding.problemOf));
  const [tooltip, setTooltip] = useState('');
  const [value, setValue] = useState(props.draft.query);
  const key = name.trim();
  const problem = key === '' ? translate('props.loop.binding.nameRequired') : binding.problemOf(key);
  const create = (): void => {
    if (problem === undefined) {
      binding.onChange({ kind: 'bind', setting, key, description: tooltip, defaultCode: defaultCodeOf(setting, value) });
      props.onDone();
    }
  };
  return (
    <div className="loop-bind-dialog loop-property-settings">
      <div className="loop-property-head">
        <span className="loop-bind-title">{translate('props.loop.binding.settings')}</span>
        <button type="button" className="loop-settings-remove" aria-label={translate('ui.close')} title={translate('ui.close')} onClick={props.onDone}>
          <CloseIcon size={12} />
        </button>
      </div>
      <label className="loop-bind-name">
        <span className="loop-settings-editor-label">{translate('props.loop.binding.name')}</span>
        <input
          value={name}
          spellCheck={false}
          autoFocus={true}
          aria-invalid={problem !== undefined}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              create();
            }
          }}
        />
      </label>
      {problem !== undefined && key !== '' && <div className="loop-bind-problem">{problem}</div>}
      <label className="loop-bind-name top">
        <span className="loop-settings-editor-label">{translate('props.loop.binding.tooltip')}</span>
        <AutoTextarea value={tooltip} placeholder={translate('props.loop.binding.tooltipPlaceholder')} onChange={(event) => setTooltip(event.target.value)} />
      </label>
      <div className="loop-property-default">
        <div className="loop-bind-title">{translate('props.loop.binding.default', { title })}</div>
        {props.draft.render(value, setValue)}
      </div>
      <div className="loop-bind-actions">
        <button type="button" className="loop-bind-button" onClick={props.onDone}>
          {translate('ui.cancel')}
        </button>
        <button type="button" className="loop-bind-button primary" disabled={problem !== undefined} onClick={create}>
          {translate('props.loop.binding.create')}
        </button>
      </div>
    </div>
  );
}

// A setting's value as the code a prop's default holds.
function defaultCodeOf(setting: LoopSetting, query: LoopQuery): string {
  switch (setting) {
    case 'filter':
      return filterValueText(query);
    case 'sort':
      return sortValueText(query.sorts);
    case 'limit':
      return String(query.limit ?? 0);
    case 'offset':
      return String(query.offset);
    case 'curated':
      return curatedText(query.selection ?? []);
    default: {
      const exhaustive: never = setting;
      return exhaustive;
    }
  }
}

/** `filters`, or `filters2` when the component already has a `filters`. */
export function freeKey(base: string, problemOf: (key: string) => string | undefined): string {
  assert(base !== '', 'A suggested name is not empty');
  for (let suffix = 1; suffix <= NAME_SUFFIX_MAX; suffix++) {
    const key = suffix === 1 ? base : `${base}${suffix}`;
    if (problemOf(key) === undefined) {
      return key;
    }
  }
  return base;
}
