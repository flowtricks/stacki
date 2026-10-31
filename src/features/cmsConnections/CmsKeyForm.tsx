// Adding a CMS by its key: a Sanity Editor key, a Payload API key, or any other
// CMS through a custom connector (an endpoint that takes drafts, and the header
// its key goes in). The key is sent once, encrypted where it is kept, and never
// shown again.
import { useState } from 'react';
import Popup from '../../ui/Popup';
import { ErrorToast } from '../../ui/ErrorToast';
import { saveCmsConnection } from '../../ipc/cmsConnectionsBridge';
import {
  parseCmsConnectionDraft,
  type CmsConnectionDraft,
} from '../../../shared/properties/cmsConnections';

export type CmsKeyKind = CmsConnectionDraft['kind'];

// The name a connection gets when none is typed, also shown as the placeholder.
const DEFAULT_NAMES: Readonly<Record<CmsKeyKind, string>> = {
  sanity: 'Sanity',
  payload: 'Payload',
  custom: 'Custom CMS',
};

const TITLES: Readonly<Record<CmsKeyKind, string>> = {
  sanity: 'Add a Sanity key',
  payload: 'Connect Payload',
  custom: 'Connect a custom CMS',
};

interface Fields {
  readonly label: string;
  readonly projectId: string;
  readonly dataset: string;
  readonly baseUrl: string;
  readonly collection: string;
  readonly header: string;
  readonly secret: string;
}
const EMPTY: Fields = {
  label: '',
  projectId: '',
  dataset: 'production',
  baseUrl: '',
  collection: 'users',
  header: 'Authorization',
  secret: '',
};

export function CmsKeyForm(props: {
  readonly projectPath: string;
  readonly cms: CmsKeyKind;
  readonly close: () => void;
}) {
  const [fields, setFields] = useState<Fields>(EMPTY);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const field = (name: keyof Fields) => ({
    value: fields[name],
    onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
      setFields({ ...fields, [name]: event.target.value }),
  });
  const save = async () => {
    let draft: CmsConnectionDraft;
    try {
      draft = parseCmsConnectionDraft(draftOf(props.cms, fields));
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return;
    }
    setBusy(true);
    const result = await saveCmsConnection(props.projectPath, draft);
    setBusy(false);
    if (result.ok) {
      props.close();
    } else {
      setError(result.message);
    }
  };
  return (
    <Popup
      className="modal publish-settings"
      label={TITLES[props.cms]}
      onClose={props.close}
      dismissible
    >
      {() => (
        <>
          <div className="modal-header">{TITLES[props.cms]}</div>
          <form
            className="modal-body publish-fields"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            {error && <ErrorToast message={error} />}
            <label>
              Name
              <input {...field('label')} placeholder={DEFAULT_NAMES[props.cms]} />
            </label>
            <KindFields cms={props.cms} field={field} />
            <label>
              {props.cms === 'custom' ? 'Key (the header’s value)' : 'API key'}
              <input {...field('secret')} type="password" autoComplete="off" spellCheck={false} />
            </label>
            <p className="hint-text">{KEY_HINTS[props.cms]}</p>
            <button type="submit" className="primary" disabled={busy}>
              {busy ? 'Saving…' : 'Save connection'}
            </button>
          </form>
        </>
      )}
    </Popup>
  );
}

const KEY_HINTS: Readonly<Record<CmsKeyKind, string>> = {
  sanity:
    'Create one in sanity.io/manage → your project → API → Tokens, with the Editor role. ' +
    'It reads drafts and writes them.',
  payload:
    'A Payload API key for a user who may edit this content (enable “useAPIKey” on the ' +
    'auth collection). Edits are saved with ?draft=true.',
  custom:
    'Stacki sends each canvas edit as JSON {document, field, value, draft: true} to this ' +
    'address with the header above.',
};

function KindFields(props: {
  readonly cms: CmsKeyKind;
  readonly field: (name: keyof Fields) => {
    readonly value: string;
    readonly onChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  };
}) {
  const { field } = props;
  switch (props.cms) {
    case 'sanity':
      return (
        <>
          <label>
            Project ID
            <input {...field('projectId')} spellCheck={false} />
          </label>
          <label>
            Dataset
            <input {...field('dataset')} spellCheck={false} />
          </label>
        </>
      );
    case 'payload':
      return (
        <>
          <label>
            Payload address
            <input {...field('baseUrl')} placeholder="https://cms.example.com" />
          </label>
          <label>
            Auth collection
            <input {...field('collection')} spellCheck={false} />
          </label>
        </>
      );
    case 'custom':
      return (
        <>
          <label>
            Draft endpoint
            <input {...field('baseUrl')} placeholder="https://cms.example.com/stacki/drafts" />
          </label>
          <label>
            Key header
            <input {...field('header')} spellCheck={false} />
          </label>
        </>
      );
    default: {
      const exhaustive: never = props.cms;
      return exhaustive;
    }
  }
}

function draftOf(cms: CmsKeyKind, fields: Fields): Record<string, string> {
  const label = fields.label.trim() || DEFAULT_NAMES[cms];
  switch (cms) {
    case 'sanity':
      return {
        kind: cms,
        label,
        projectId: fields.projectId.trim(),
        dataset: fields.dataset.trim(),
        secret: fields.secret,
      };
    case 'payload':
      return {
        kind: cms,
        label,
        baseUrl: fields.baseUrl.trim(),
        collection: fields.collection.trim(),
        secret: fields.secret,
      };
    case 'custom':
      return {
        kind: cms,
        label,
        baseUrl: fields.baseUrl.trim(),
        header: fields.header.trim(),
        secret: fields.secret,
      };
    default: {
      const exhaustive: never = cms;
      return exhaustive;
    }
  }
}
