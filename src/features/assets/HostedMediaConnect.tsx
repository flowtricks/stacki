// Connecting a media host to the Assets panel: Cloudflare R2 and Bunny Storage
// from their accounts by default (one pasted key, shared/properties/mediaAccounts.ts
// says why it is not a sign-in), their keys by hand under Advanced, and any
// S3-compatible host by hand. The keys are sent once, tried against the host in the
// main process, kept there encrypted, and never shown again
// (electron/content/media/mediaConnectionStore.ts).
import { useState } from 'react';
import Popup from '../../ui/Popup';
import Dropdown from '../../ui/Dropdown';
import { ErrorToast } from '../../ui/ErrorToast';
import { BucketIcon, BunnyIcon, CloudflareIcon } from '../../ui/Icons';
import { connectMediaAccount, discoverMediaAccounts, openHostedLink, saveMediaConnection } from '../../ipc/mediaHostingBridge';
import {
  BUNNY_REGIONS,
  parseMediaConnectionDraft,
  type MediaConnection,
  type MediaConnectionDraft,
  type MediaConnectionList,
  type MediaProviderKind,
  type MediaSaveResult,
} from '../../../shared/properties/mediaHosting';
import {
  BUNNY_API_KEY_URL,
  CLOUDFLARE_TOKEN_TEMPLATE_URL,
  parseMediaAccountConnect,
  parseMediaAccountKey,
  type MediaAccountChoices,
  type MediaAccountConnect,
  type MediaAccountKey,
} from '../../../shared/properties/mediaAccounts';
import { EMPTY_CONNECT_FIELDS, PROVIDER_NAMES, draftFields, fieldsOf, type ConnectFields } from './hostedMediaModel';

export function ProviderIcon({ kind, size = 14 }: { readonly kind: MediaProviderKind; readonly size?: number }) {
  switch (kind) {
    case 'r2':
      return <CloudflareIcon size={size} className="hosted-logo is-r2" />;
    case 'bunny':
      return <BunnyIcon size={size} className="hosted-logo is-bunny" />;
    case 's3':
      return <BucketIcon size={size} className="hosted-logo" />;
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

const HINTS: Readonly<Record<MediaProviderKind, string>> = {
  r2:
    'Create an R2 API token with Object Read & Write for this bucket (R2 → Manage API tokens). ' +
    'The public URL is the bucket’s public development URL or its custom domain (R2 → bucket → Settings).',
  bunny:
    'The storage zone’s password is under Storage → your zone → FTP & API Access. ' +
    'The pull zone URL is the CDN address connected to the zone (Pull zones → your zone → Hostnames).',
  s3:
    'Any host that speaks the S3 API: AWS S3, Backblaze B2, DigitalOcean Spaces, Wasabi, MinIO. ' +
    'The public URL is where the bucket’s files are served from.',
};

export function HostedMediaConnect(props: {
  readonly projectPath: string;
  /** A saved connection to edit: its public fields filled in, its keys typed again. */
  readonly editing: MediaConnection | undefined;
  readonly close: () => void;
  readonly onConnected: (list: MediaConnectionList) => void;
}) {
  const { editing } = props;
  const [kind, setKind] = useState<MediaProviderKind>(editing?.kind ?? 'r2');
  const [fields, setFields] = useState<ConnectFields>(editing === undefined ? EMPTY_CONNECT_FIELDS : fieldsOf(editing));
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  // The account route is the default where a host has one; editing changes keys by hand.
  const [manual, setManual] = useState(editing !== undefined);
  const field = (name: keyof ConnectFields, extra: { readonly secret?: boolean } = {}) => ({
    value: fields[name],
    spellCheck: false,
    autoComplete: 'off',
    ...(extra.secret === true ? { type: 'password' } : {}),
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => setFields({ ...fields, [name]: event.target.value }),
  });
  const finish = (result: MediaSaveResult) => {
    if (result.ok) {
      props.onConnected(result.list);
      props.close();
    } else {
      setError(result.message);
    }
  };
  const saveManual = async () => {
    let draft: MediaConnectionDraft;
    try {
      draft = parseMediaConnectionDraft(draftFields(kind, fields));
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return;
    }
    setBusy(true);
    setError(undefined);
    const result = await saveMediaConnection(props.projectPath, draft);
    setBusy(false);
    finish(result);
  };
  const title = editing === undefined ? 'Connect media storage' : `Edit ${editing.label}`;
  const accountRoute = kind !== 's3';
  return (
    <Popup className="modal publish-settings" label={title} onClose={props.close} dismissible>
      {() => (
        <>
          <div className="modal-header">{title}</div>
          <div className="modal-body publish-fields">
            {error && <ErrorToast message={error} />}
            {editing === undefined && (
              <div className="publish-field">
                Host
                <Dropdown
                  value={kind}
                  options={(['r2', 'bunny', 's3'] as const).map((value) => ({ value, label: PROVIDER_NAMES[value], icon: <ProviderIcon kind={value} /> }))}
                  onChange={(next) => {
                    setKind(next);
                    setError(undefined);
                  }}
                />
              </div>
            )}
            {accountRoute && !manual && (
              <AccountConnect key={kind} provider={kind === 'bunny' ? 'bunny' : 'r2'} projectPath={props.projectPath} onError={setError} onConnected={finish} />
            )}
            {accountRoute && (
              <button type="button" className="ghost hosted-advanced-toggle" aria-expanded={manual} onClick={() => setManual(!manual)}>
                {manual ? 'Use the account instead' : 'Advanced: enter keys manually'}
              </button>
            )}
            {(manual || !accountRoute) && (
              <form
                className="publish-fields hosted-manual"
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveManual();
                }}
              >
                <label>
                  Name
                  <input {...field('label')} placeholder={PROVIDER_NAMES[kind]} />
                </label>
                <ProviderFields kind={kind} field={field} fields={fields} setFields={setFields} />
                <p className="hint-text">{HINTS[kind]}</p>
                <button type="submit" className="primary" disabled={busy}>
                  {busy ? 'Checking the connection…' : editing === undefined ? 'Connect' : 'Save connection'}
                </button>
              </form>
            )}
          </div>
        </>
      )}
    </Popup>
  );
}

const ACCOUNT_TEXT = {
  r2: {
    button: 'Connect with Cloudflare',
    open: 'Create token in Cloudflare',
    openURL: CLOUDFLARE_TOKEN_TEMPLATE_URL,
    keyLabel: 'Cloudflare API token',
    find: 'Find buckets',
    choose: 'Bucket',
    publicLabel: 'Public bucket URL',
    explain:
      'Cloudflare opens with an R2 read & write token filled in. Create it, then paste it here: Stacki finds your buckets with it and keeps only that bucket’s keys, encrypted.',
  },
  bunny: {
    button: 'Connect with Bunny',
    open: 'Open my Bunny API key',
    openURL: BUNNY_API_KEY_URL,
    keyLabel: 'Bunny account API key',
    find: 'Find storage zones',
    choose: 'Storage zone',
    publicLabel: 'Pull zone URL',
    explain:
      'Paste your account API key: Stacki finds your storage zones with it, then keeps only the chosen zone’s storage password, encrypted. The account key is not kept.',
  },
} as const;

// One pasted key, a choice of what it reaches, and a connect: the main process
// (or the Studio server) does every lookup and keeps no copy of the pasted key.
function AccountConnect(props: {
  readonly provider: 'r2' | 'bunny';
  readonly projectPath: string;
  readonly onError: (message: string | undefined) => void;
  readonly onConnected: (result: MediaSaveResult) => void;
}) {
  const text = ACCOUNT_TEXT[props.provider];
  const [key, setKey] = useState('');
  const [choices, setChoices] = useState<MediaAccountChoices | undefined>(undefined);
  const [choice, setChoice] = useState('');
  const [publicBaseUrl, setPublicBaseUrl] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const options = choiceOptions(choices);
  const choose = (value: string) => {
    setChoice(value);
    setPublicBaseUrl(options.find((option) => option.value === value)?.publicBaseUrl ?? '');
  };
  const find = async () => {
    let accountKey: MediaAccountKey;
    try {
      accountKey = parseMediaAccountKey(props.provider === 'r2' ? { provider: 'r2', token: key } : { provider: 'bunny', apiKey: key });
    } catch (reason: unknown) {
      props.onError(reason instanceof Error ? reason.message : String(reason));
      return;
    }
    setBusy(true);
    props.onError(undefined);
    const found = await discoverMediaAccounts(props.projectPath, accountKey);
    setBusy(false);
    if (!found.ok) {
      props.onError(found.message);
      return;
    }
    setChoices(found.value);
    const first = choiceOptions(found.value)[0];
    setChoice(first?.value ?? '');
    setPublicBaseUrl(first?.publicBaseUrl ?? '');
    if (first === undefined) {
      props.onError(
        props.provider === 'r2'
          ? 'This token reaches no R2 buckets. Create a bucket first, or check the token’s accounts.'
          : 'This account has no storage zones yet.',
      );
    }
  };
  const connect = async () => {
    const [accountId = '', name = ''] = choice.split('/');
    let request: MediaAccountConnect;
    try {
      request = parseMediaAccountConnect(
        props.provider === 'r2'
          ? { provider: 'r2', token: key, label: label.trim() || PROVIDER_NAMES.r2, accountId, bucket: name, publicBaseUrl }
          : { provider: 'bunny', apiKey: key, label: label.trim() || PROVIDER_NAMES.bunny, storageZone: name, publicBaseUrl },
      );
    } catch (reason: unknown) {
      props.onError(reason instanceof Error ? reason.message : String(reason));
      return;
    }
    setBusy(true);
    props.onError(undefined);
    const result = await connectMediaAccount(props.projectPath, request);
    setBusy(false);
    props.onConnected(result);
  };
  return (
    <div className="publish-fields hosted-account">
      <p className="hint-text">{text.explain}</p>
      <button type="button" onClick={() => void openHostedLink(text.openURL)}>
        <ProviderIcon kind={props.provider} />
        {text.open}
      </button>
      <label>
        {text.keyLabel}
        <input value={key} type="password" autoComplete="off" spellCheck={false} onChange={(event) => setKey(event.target.value)} />
      </label>
      {choices === undefined ? (
        <button type="button" className="primary" disabled={busy || key.trim() === ''} onClick={() => void find()}>
          {busy ? 'Looking…' : text.find}
        </button>
      ) : (
        <>
          <div className="publish-field">
            {text.choose}
            <Dropdown value={choice} options={options} onChange={choose} />
          </div>
          <label>
            {text.publicLabel}
            <input value={publicBaseUrl} spellCheck={false} placeholder="https://…" onChange={(event) => setPublicBaseUrl(event.target.value)} />
          </label>
          <label>
            Name
            <input value={label} placeholder={PROVIDER_NAMES[props.provider]} onChange={(event) => setLabel(event.target.value)} />
          </label>
          <button type="button" className="primary" disabled={busy || choice === ''} onClick={() => void connect()}>
            {busy ? 'Connecting…' : text.button}
          </button>
        </>
      )}
    </div>
  );
}

/** Each bucket (as `accountId/bucket`) or zone a key reaches, grouped by account. */
function choiceOptions(choices: MediaAccountChoices | undefined) {
  if (choices === undefined) {
    return [];
  }
  if (choices.provider === 'r2') {
    return choices.accounts.flatMap((account) =>
      account.buckets.map((bucket) => ({
        value: `${account.id}/${bucket.name}`,
        label: bucket.name,
        group: account.name,
        publicBaseUrl: bucket.publicBaseUrl,
      })),
    );
  }
  return choices.zones.map((zone) => ({ value: `-/${zone.name}`, label: zone.name, hint: zone.region, publicBaseUrl: zone.publicBaseUrl }));
}

type FieldProps = (
  name: keyof ConnectFields,
  extra?: { readonly secret?: boolean },
) => {
  readonly value: string;
  readonly onChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
};

function ProviderFields(props: {
  readonly kind: MediaProviderKind;
  readonly field: FieldProps;
  readonly fields: ConnectFields;
  readonly setFields: (fields: ConnectFields) => void;
}) {
  const { field, fields, setFields } = props;
  switch (props.kind) {
    case 'r2':
      return (
        <>
          <label>
            Account ID
            <input {...field('accountId')} placeholder="32 characters, from the R2 overview" />
          </label>
          <label>
            Bucket
            <input {...field('bucket')} />
          </label>
          <label>
            Public bucket URL
            <input {...field('publicBaseUrl')} placeholder="Your bucket’s public URL" />
          </label>
          <KeyPairFields field={field} />
        </>
      );
    case 'bunny':
      return (
        <>
          <label>
            Storage zone
            <input {...field('storageZone')} />
          </label>
          <div className="publish-field">
            Region
            <Dropdown
              value={fields.region || 'de'}
              options={BUNNY_REGIONS.map((value) => ({ value, label: value === 'de' ? 'Falkenstein (de, primary)' : value }))}
              onChange={(region) => setFields({ ...fields, region })}
            />
          </div>
          <label>
            Pull zone URL
            <input {...field('publicBaseUrl')} placeholder="Your pull zone’s URL" />
          </label>
          <label>
            Storage zone password
            <input {...field('accessKey', { secret: true })} />
          </label>
        </>
      );
    case 's3':
      return (
        <>
          <label>
            Endpoint
            <input {...field('endpoint')} placeholder="Endpoint URL" />
          </label>
          <label>
            Region
            <input {...field('region')} placeholder="us-east-1" />
          </label>
          <label>
            Bucket
            <input {...field('bucket')} />
          </label>
          <div className="publish-field">
            Bucket address
            <Dropdown
              value={fields.addressing}
              options={[
                { value: 'path', label: 'In the path (endpoint/bucket)' },
                { value: 'virtual', label: 'As a subdomain (bucket.endpoint)' },
              ]}
              onChange={(addressing) => setFields({ ...fields, addressing })}
            />
          </div>
          <label>
            Public URL
            <input {...field('publicBaseUrl')} placeholder="Your bucket’s public URL" />
          </label>
          <KeyPairFields field={field} />
        </>
      );
    default: {
      const exhaustive: never = props.kind;
      return exhaustive;
    }
  }
}

function KeyPairFields({ field }: { readonly field: FieldProps }) {
  return (
    <>
      <label>
        Access key ID
        <input {...field('accessKeyId')} />
      </label>
      <label>
        Secret access key
        <input {...field('secretAccessKey', { secret: true })} />
      </label>
    </>
  );
}
