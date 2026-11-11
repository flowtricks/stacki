// "Property settings" for an existing prop, opened from its row in a data
// picker. It draws the Properties panel's own fields (PropertyEditor.tsx) in the
// picker's place, so every option a prop has is here. Each change saves itself
// (propertyAutosave.ts) through the panel's transaction (propertySave.ts), and
// closing the form saves whatever is still pending.
//
// The fields live in this feature because Kind and the tag settings do, and the
// props feature may not import them; the app hands this form to the picker
// (NewPropHost.propSettings).

import { useEffect, useRef, useState } from 'react';
import { CloseIcon } from '../../ui/Icons';
import { ok } from '../../../shared/core/result';
import { PropertyConditions } from './PropertyDeclarationInfo';
import { PropertyShareNotice } from './PropertyShareNotice';
import { PropertySettingsFields } from './PropertyEditor';
import PropertyReadOnlyFields from './PropertyReadOnlyFields';
import type { PropertySaveHost } from './propertyAutosave';
import { loadProperty, saveProperty, type LoadedProperty, type PropertySaver } from './propertySave';
import './componentProperties.css';

type DialogState =
  { readonly kind: 'loading' } | { readonly kind: 'failed'; readonly message: string } | { readonly kind: 'ready'; readonly loaded: LoadedProperty };

export default function PropertySettingsDialog(props: { readonly propertyKey: string; readonly saver: PropertySaver; readonly onClose: () => void }) {
  const { propertyKey, saver, onClose } = props;
  const [state, setState] = useState<DialogState>({ kind: 'loading' });
  // The app builds a new saver on every render; the form reads once, on opening.
  const saverRef = useRef(saver);
  saverRef.current = saver;
  useEffect(() => {
    let active = true;
    const read = async (): Promise<DialogState> => {
      try {
        const loaded = await loadProperty(saverRef.current, propertyKey);
        return loaded.ok ? { kind: 'ready', loaded: loaded.value } : { kind: 'failed', message: loaded.error };
      } catch (caught: unknown) {
        return { kind: 'failed', message: String(caught) };
      }
    };
    void read().then((next) => {
      if (active) {
        setState(next);
      }
    });
    return () => {
      active = false;
    };
  }, [propertyKey]);
  return (
    <div className="property-editor property-settings-dialog" role="dialog" aria-label="Property settings">
      <header>
        <strong>Property settings</strong>
        <button type="button" aria-label="Close property settings" title="Close" onClick={onClose}>
          <CloseIcon size={12} />
        </button>
      </header>
      <DialogBody state={state} saverRef={saverRef} />
    </div>
  );
}

function DialogBody({ state, saverRef }: { readonly state: DialogState; readonly saverRef: { readonly current: PropertySaver } }) {
  switch (state.kind) {
    case 'loading':
      return <p className="property-help">Loading property…</p>;
    case 'failed':
      // Nothing else is in the form, so the reason is said here rather than in a toast.
      return <p className="property-error">{state.message}</p>;
    case 'ready':
      return state.loaded.editable ? <EditableBody loaded={state.loaded} saverRef={saverRef} /> : <PropertyReadOnlyFields property={state.loaded.property} />;
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

function EditableBody({ loaded, saverRef }: { readonly loaded: LoadedProperty; readonly saverRef: { readonly current: PropertySaver } }) {
  // Each save is checked against the source the one before left.
  const source = useRef(loaded.source);
  const saveHost: PropertySaveHost = {
    save: async (change) => {
      const outcome = await saveProperty(saverRef.current, source.current, change).catch((caught: unknown) => ({
        kind: 'refused' as const,
        message: String(caught),
      }));
      if (outcome.kind === 'saved') {
        source.current = outcome.source;
      }
      return outcome;
    },
    reload: async (name) => {
      const fresh = await loadProperty(saverRef.current, name);
      if (!fresh.ok) {
        return fresh;
      }
      source.current = fresh.value.source;
      return ok(fresh.value.property);
    },
  };
  return (
    <>
      <PropertyConditions property={loaded.property} />
      <PropertyShareNotice property={loaded.property} onOpenFile={saverRef.current.openFile} />
      {loaded.property.editing?.kind === 'override' && <p className="property-help">{loaded.property.editing.reason}</p>}
      <PropertySettingsFields property={loaded.property} frontmatter={loaded.frontmatter} projectPath={saverRef.current.projectPath} saveHost={saveHost} />
    </>
  );
}
