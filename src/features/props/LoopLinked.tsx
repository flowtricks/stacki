// A list setting linked to a component property, drawn as a builder draws
// one: the setting's label, then a purple bar with its icon and the
// property's name. The bar opens a menu:
//
//   Edit settings          the property's name and tooltip, and its default
//   Disconnect             the default goes back into the list, unlinked
//   New Filters property   link to a new property starting from the same value
//   Connect                the component's properties that could hold it
//
// The default is edited with the setting's own editor, passed in as `editor`,
// so it reads and writes exactly as the unlinked setting does.

import { useCallback, useState } from 'react';
import type { ReactNode, RefCallback } from 'react';
import { CheckIcon, ChevronDownIcon, CloseIcon, ComponentIcon, GearIcon, PlusIcon, UnlinkIcon } from '../../ui/Icons';
import { assert } from '../../../shared/core/assert';
import { SETTING_TITLES } from '../../editor/optionsBinding';
import type { LoopSetting } from '../../editor/optionsQuery';
import { titled } from './loopCatalog';
import { RowPopup } from './LoopRows';
import AutoTextarea from '../../ui/AutoTextarea';
import { NewProperty, settingIcon, type BindingContext, type DraftEditor } from './LoopBinding';

const SETTINGS_HEIGHT_PX_MAX = 560;

type Panel = 'menu' | 'settings' | 'new' | undefined;

/** The label and purple bar of a linked setting, with its menu and editors. */
export function LinkedSetting(props: {
  readonly setting: LoopSetting;
  readonly binding: BindingContext;
  /** The setting's editor, writing the property's default. */
  readonly editor: ReactNode;
  /** The same editor over a draft, for a new property's default. */
  readonly draft: DraftEditor;
}) {
  const { binding, setting } = props;
  const home = binding.settings[setting];
  assert(home.kind === 'prop', 'A linked setting names its property');
  const [panel, setPanel] = useState<Panel>(undefined);
  const [bar, setBar] = useState<HTMLButtonElement | undefined>(undefined);
  const attach = useCallback<RefCallback<HTMLButtonElement>>((element) => setBar(element ?? undefined), []);
  const title = SETTING_TITLES[setting];
  const close = (): void => setPanel(undefined);
  return (
    <div className="props-field loop-settings-row loop-linked-row">
      <label>
        <span className="prop-label">{title}</span>
      </label>
      <button
        ref={attach}
        type="button"
        className="loop-linked-bar"
        aria-haspopup="menu"
        aria-expanded={panel !== undefined}
        title={`${title} come from the ${home.key} property`}
        onClick={() => setPanel(panel === undefined ? 'menu' : undefined)}
      >
        <span className="loop-linked-icon">{settingIcon(setting)}</span>
        <span className="loop-linked-name">{titled(home.key)}</span>
        <ChevronDownIcon size={11} />
      </button>
      {panel === 'menu' && (
        <RowPopup anchor={bar} heightPxMax={SETTINGS_HEIGHT_PX_MAX} label={`${title} property`} onClose={close}>
          <LinkedMenu setting={setting} binding={binding} current={home.key} onPanel={setPanel} />
        </RowPopup>
      )}
      {panel === 'new' && (
        <RowPopup anchor={bar} label={`New ${title} property`} onClose={close}>
          <NewProperty setting={setting} binding={binding} draft={props.draft} onDone={close} />
        </RowPopup>
      )}
      {panel === 'settings' && (
        <RowPopup anchor={bar} heightPxMax={SETTINGS_HEIGHT_PX_MAX} label="Property settings" onClose={close}>
          <PropertySettings setting={setting} binding={binding} propKey={home.key} editor={props.editor} onClose={close} />
        </RowPopup>
      )}
    </div>
  );
}

function LinkedMenu(props: {
  readonly setting: LoopSetting;
  readonly binding: BindingContext;
  readonly current: string;
  readonly onPanel: (panel: Panel) => void;
}) {
  const { binding, setting } = props;
  const title = SETTING_TITLES[setting];
  const choose = (action: () => void): void => {
    props.onPanel(undefined);
    action();
  };
  return (
    <div className="loop-linked-menu" role="menu">
      <button type="button" role="menuitem" className="loop-linked-item" onClick={() => props.onPanel('settings')}>
        <GearIcon size={14} />
        Edit settings
      </button>
      <button type="button" role="menuitem" className="loop-linked-item" onClick={() => choose(() => binding.onChange({ kind: 'unbind', setting }))}>
        <UnlinkIcon size={14} />
        Disconnect
      </button>
      <button type="button" role="menuitem" className="loop-linked-item accent" onClick={() => props.onPanel('new')}>
        <PlusIcon size={14} />
        New {title} property
      </button>
      <div className="loop-linked-heading">Connect</div>
      <div className="loop-linked-component">
        <ComponentIcon size={13} />
        {binding.componentName}
      </div>
      {binding.connectable(setting).map((key) => (
        <button
          key={key}
          type="button"
          role="menuitemradio"
          aria-checked={key === props.current}
          className="loop-linked-item loop-linked-prop"
          onClick={() => choose(() => (key === props.current ? undefined : binding.onChange({ kind: 'connect', setting, key })))}
        >
          {settingIcon(setting)}
          <span className="loop-linked-name">{titled(key)}</span>
          {key === props.current && <CheckIcon size={13} className="loop-linked-check" />}
        </button>
      ))}
    </div>
  );
}

// "Property settings": the name pages pass it by and its tooltip, saved as the
// Properties panel saves them (a rename updates every page passing it), and
// below, the default, with the setting's own editor.
function PropertySettings(props: {
  readonly setting: LoopSetting;
  readonly binding: BindingContext;
  readonly propKey: string;
  readonly editor: ReactNode;
  readonly onClose: () => void;
}) {
  const identity = usePropertyIdentity(props.binding, props.propKey);
  const { name, tooltip, state, save } = identity;
  const locked = props.binding.onEditProperty === undefined || state.kind === 'saving';
  return (
    <div className="loop-bind-dialog loop-property-settings">
      <div className="loop-property-head">
        <span className="loop-bind-title">Property settings</span>
        <button type="button" className="loop-settings-remove" aria-label="Close property settings" title="Close" onClick={props.onClose}>
          <CloseIcon size={12} />
        </button>
      </div>
      <label className="loop-bind-name">
        <span className="loop-settings-editor-label">Name</span>
        <input
          value={name}
          spellCheck={false}
          disabled={locked}
          onChange={(event) => identity.setName(event.target.value)}
          onBlur={save}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              save();
            }
          }}
        />
      </label>
      <label className="loop-bind-name top">
        <span className="loop-settings-editor-label">Tooltip</span>
        <AutoTextarea
          value={tooltip}
          placeholder="Describe how to use this property…"
          disabled={locked}
          onChange={(event) => identity.setTooltip(event.target.value)}
          onBlur={save}
        />
      </label>
      {state.kind === 'error' && <div className="loop-bind-problem">{state.message}</div>}
      {name.trim() !== props.propKey && state.kind !== 'error' && <div className="loop-bind-note">Renaming updates every page that sets this property.</div>}
      <div className="loop-property-default">
        <div className="loop-bind-title">Default {SETTING_TITLES[props.setting]}</div>
        {props.editor}
      </div>
    </div>
  );
}

type SaveState = { readonly kind: 'idle' } | { readonly kind: 'saving' } | { readonly kind: 'error'; readonly message: string };

// The name and tooltip being edited, saved together when a field is left and
// either differs from what the file says.
function usePropertyIdentity(binding: BindingContext, propKey: string) {
  const savedTooltip = binding.tooltipOf(propKey);
  const [name, setName] = useState(propKey);
  const [tooltip, setTooltip] = useState(savedTooltip);
  const [state, setState] = useState<SaveState>({ kind: 'idle' });
  const save = (): void => {
    const edit = binding.onEditProperty;
    const next = { name: name.trim(), description: tooltip.trim() };
    if (edit === undefined || state.kind === 'saving') {
      return;
    }
    if (next.name === propKey && next.description === savedTooltip.trim()) {
      return;
    }
    setState({ kind: 'saving' });
    void edit(propKey, next).then((message) => setState(message === undefined ? { kind: 'idle' } : { kind: 'error', message }));
  };
  return { name, setName, tooltip, setTooltip, state, save };
}
