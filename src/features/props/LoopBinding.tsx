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
import { FieldNumberIcon, FilterIcon, PlusIcon, SortIcon } from '../../ui/Icons';
import { assert } from '../../../shared/core/assert';
import {
  SETTING_PROP_NAMES,
  SETTING_TITLES,
  type BindingChange,
} from '../../editor/optionsBinding';
import type { LoopSetting, SettingHome } from '../../editor/optionsQuery';
import { RowPopup } from './LoopRows';

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
  readonly onEditProperty?:
    | ((
        key: string,
        edit: { readonly name: string; readonly description: string },
      ) => Promise<string | undefined>)
    | undefined;
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
    default: {
      const exhaustive: never = setting;
      return exhaustive;
    }
  }
}

/** The dot offering to link an unlinked setting; nothing once it is linked. */
export function SettingDot(props: {
  readonly setting: LoopSetting;
  readonly binding: BindingContext | undefined;
}) {
  const { binding, setting } = props;
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLButtonElement | undefined>(undefined);
  const attach = useCallback<RefCallback<HTMLButtonElement>>(
    (element) => setAnchor(element ?? undefined),
    [],
  );
  if (binding === undefined || binding.settings[setting].kind === 'prop') {
    return undefined;
  }
  const title = SETTING_TITLES[setting];
  return (
    <>
      <button
        ref={attach}
        type="button"
        className={`loop-bind-dot${open ? ' on' : ''}`}
        title={`Link ${title} to a component property`}
        aria-label={`Link ${title} to a component property`}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen(!open)}
      >
        <span className="bind-dot" />
        <PlusIcon size={7} className="bind-plus" />
      </button>
      {open && (
        <RowPopup anchor={anchor} label={`New ${title} property`} onClose={() => setOpen(false)}>
          <NewProperty setting={setting} binding={binding} onDone={() => setOpen(false)} />
        </RowPopup>
      )}
    </>
  );
}

/** "New Filters property": the name pages pass it by, checked as it is typed. */
export function NewProperty(props: {
  readonly setting: LoopSetting;
  readonly binding: BindingContext;
  readonly onDone: () => void;
}) {
  const { binding, setting } = props;
  const title = SETTING_TITLES[setting];
  const [name, setName] = useState(() => freeKey(SETTING_PROP_NAMES[setting], binding.problemOf));
  const key = name.trim();
  const problem = key === '' ? 'Give the property a name.' : binding.problemOf(key);
  const create = (): void => {
    if (problem === undefined) {
      binding.onChange({ kind: 'bind', setting, key });
      props.onDone();
    }
  };
  return (
    <div className="loop-bind-dialog">
      <div className="loop-bind-title">New {title} property</div>
      <label className="loop-bind-name">
        <span className="loop-settings-editor-label">Name</span>
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
      <div className="loop-bind-note">
        The current {title.toLowerCase()} become its default. Each page using this component can set
        its own.
      </div>
      <div className="loop-bind-actions">
        <button type="button" className="loop-bind-button" onClick={props.onDone}>
          Cancel
        </button>
        <button
          type="button"
          className="loop-bind-button primary"
          disabled={problem !== undefined}
          onClick={create}
        >
          Create
        </button>
      </div>
    </div>
  );
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
