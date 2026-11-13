// Connecting a media host to the Assets panel: Cloudflare R2 and Bunny Storage
// from their accounts by default (one pasted key, shared/properties/mediaAccounts.ts
// says why it is not a sign-in), their keys by hand under Advanced, and any
// S3-compatible host by hand. The keys are sent once, tried against the host in the
// main process, kept there encrypted, and never shown again
// (electron/content/media/mediaConnectionStore.ts).
import { useState } from 'react';
import { useTranslate, useTranslateDescribed } from '../../lib/i18n/useTranslate';
import type { MessageKey } from '../../lib/i18n/localeContext';
import { useMediaErrorText } from './useMediaErrorText';
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

/** A host's name for people: product names stay, "S3-compatible" is a description and follows the language. */
function providerName(kind: MediaProviderKind, translate: (key: MessageKey) => string): string {
  return kind === 's3' ? translate('assets.provider.s3') : PROVIDER_NAMES[kind];
}

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

const HINTS: Readonly<Record<MediaProviderKind, MessageKey>> = {
  r2: 'assets.connect.hint.r2',
  bunny: 'assets.connect.hint.bunny',
  s3: 'assets.connect.hint.s3',
};

export function HostedMediaConnect(props: {
  readonly projectPath: string;
  /** A saved connection to edit: its public fields filled in, its keys typed again. */
  readonly editing: MediaConnection | undefined;
  readonly close: () => void;
  readonly onConnected: (list: MediaConnectionList) => void;
}) {
  const { editing } = props;
  const translate = useTranslate();
  const translateDescribed = useTranslateDescribed();
  const mediaErrorText = useMediaErrorText();
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
      setError(translateDescribed(result));
    }
  };
  const saveManual = async () => {
    let draft: MediaConnectionDraft;
    try {
      draft = parseMediaConnectionDraft(draftFields(kind, fields));
    } catch (reason: unknown) {
      setError(mediaErrorText(reason));
      return;
    }
    setBusy(true);
    setError(undefined);
    const result = await saveMediaConnection(props.projectPath, draft);
    setBusy(false);
    finish(result);
  };
  const title = editing === undefined ? translate('assets.connect.title') : translate('assets.connect.edit', { label: editing.label });
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
                {translate('assets.connect.host')}
                <Dropdown
                  value={kind}
                  options={(['r2', 'bunny', 's3'] as const).map((value) => ({
                    value,
                    label: providerName(value, translate),
                    icon: <ProviderIcon kind={value} />,
                  }))}
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
                {manual ? translate('assets.connect.useAccount') : translate('assets.connect.advanced')}
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
                  {translate('assets.connect.name')}
                  <input {...field('label')} placeholder={providerName(kind, translate)} />
                </label>
                <ProviderFields kind={kind} field={field} fields={fields} setFields={setFields} />
                <p className="hint-text">{translate(HINTS[kind])}</p>
                <button type="submit" className="primary" disabled={busy}>
                  {busy ? translate('assets.connect.checking') : editing === undefined ? translate('assets.connect.action') : translate('assets.connect.save')}
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
    button: 'assets.connect.r2.button',
    open: 'assets.connect.r2.open',
    openURL: CLOUDFLARE_TOKEN_TEMPLATE_URL,
    keyLabel: 'assets.connect.r2.keyLabel',
    find: 'assets.connect.r2.find',
    choose: 'assets.connect.r2.choose',
    publicLabel: 'assets.connect.r2.publicLabel',
    explain: 'assets.connect.r2.explain',
  },
  bunny: {
    button: 'assets.connect.bunny.button',
    open: 'assets.connect.bunny.open',
    openURL: BUNNY_API_KEY_URL,
    keyLabel: 'assets.connect.bunny.keyLabel',
    find: 'assets.connect.bunny.find',
    choose: 'assets.connect.bunny.choose',
    publicLabel: 'assets.connect.bunny.publicLabel',
    explain: 'assets.connect.bunny.explain',
  },
} as const satisfies Record<'r2' | 'bunny', Readonly<Record<string, MessageKey | string>>>;

// One pasted key, a choice of what it reaches, and a connect: the main process
// (or the Studio server) does every lookup and keeps no copy of the pasted key.
function AccountConnect(props: {
  readonly provider: 'r2' | 'bunny';
  readonly projectPath: string;
  readonly onError: (message: string | undefined) => void;
  readonly onConnected: (result: MediaSaveResult) => void;
}) {
  const text = ACCOUNT_TEXT[props.provider];
  const translate = useTranslate();
  const mediaErrorText = useMediaErrorText();
  const translateDescribed = useTranslateDescribed();
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
      props.onError(mediaErrorText(reason));
      return;
    }
    setBusy(true);
    props.onError(undefined);
    const found = await discoverMediaAccounts(props.projectPath, accountKey);
    setBusy(false);
    if (!found.ok) {
      props.onError(translateDescribed(found));
      return;
    }
    setChoices(found.value);
    const first = choiceOptions(found.value)[0];
    setChoice(first?.value ?? '');
    setPublicBaseUrl(first?.publicBaseUrl ?? '');
    if (first === undefined) {
      props.onError(props.provider === 'r2' ? translate('assets.connect.r2.noBuckets') : translate('assets.connect.bunny.noZones'));
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
      props.onError(mediaErrorText(reason));
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
      <p className="hint-text">{translate(text.explain)}</p>
      <button type="button" onClick={() => void openHostedLink(text.openURL)}>
        <ProviderIcon kind={props.provider} />
        {translate(text.open)}
      </button>
      <label>
        {translate(text.keyLabel)}
        <input value={key} type="password" autoComplete="off" spellCheck={false} onChange={(event) => setKey(event.target.value)} />
      </label>
      {choices === undefined ? (
        <button type="button" className="primary" disabled={busy || key.trim() === ''} onClick={() => void find()}>
          {busy ? translate('assets.connect.looking') : translate(text.find)}
        </button>
      ) : (
        <>
          <div className="publish-field">
            {translate(text.choose)}
            <Dropdown value={choice} options={options} onChange={choose} />
          </div>
          <label>
            {translate(text.publicLabel)}
            <input value={publicBaseUrl} spellCheck={false} placeholder="https://…" onChange={(event) => setPublicBaseUrl(event.target.value)} />
          </label>
          <label>
            {translate('assets.connect.name')}
            <input value={label} placeholder={providerName(props.provider, translate)} onChange={(event) => setLabel(event.target.value)} />
          </label>
          <button type="button" className="primary" disabled={busy || choice === ''} onClick={() => void connect()}>
            {busy ? translate('assets.connect.connecting') : translate(text.button)}
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
  const translate = useTranslate();
  switch (props.kind) {
    case 'r2':
      return (
        <>
          <label>
            {translate('assets.connect.accountId')}
            <input {...field('accountId')} placeholder={translate('assets.connect.accountIdPlaceholder')} />
          </label>
          <label>
            {translate('assets.connect.bucket')}
            <input {...field('bucket')} />
          </label>
          <label>
            {translate('assets.connect.r2.publicLabel')}
            <input {...field('publicBaseUrl')} placeholder={translate('assets.connect.bucketUrlPlaceholder')} />
          </label>
          <KeyPairFields field={field} />
        </>
      );
    case 'bunny':
      return (
        <>
          <label>
            {translate('assets.connect.bunny.choose')}
            <input {...field('storageZone')} />
          </label>
          <div className="publish-field">
            {translate('assets.connect.region')}
            <Dropdown
              value={fields.region || 'de'}
              options={BUNNY_REGIONS.map((value) => ({ value, label: value === 'de' ? translate('assets.connect.falkenstein') : value }))}
              onChange={(region) => setFields({ ...fields, region })}
            />
          </div>
          <label>
            {translate('assets.connect.bunny.publicLabel')}
            <input {...field('publicBaseUrl')} placeholder={translate('assets.connect.pullZonePlaceholder')} />
          </label>
          <label>
            {translate('assets.connect.zonePassword')}
            <input {...field('accessKey', { secret: true })} />
          </label>
        </>
      );
    case 's3':
      return (
        <>
          <label>
            {translate('assets.connect.endpoint')}
            <input {...field('endpoint')} placeholder={translate('assets.connect.endpointPlaceholder')} />
          </label>
          <label>
            {translate('assets.connect.region')}
            <input {...field('region')} placeholder="us-east-1" />
          </label>
          <label>
            {translate('assets.connect.bucket')}
            <input {...field('bucket')} />
          </label>
          <div className="publish-field">
            {translate('assets.connect.bucketAddress')}
            <Dropdown
              value={fields.addressing}
              options={[
                { value: 'path', label: translate('assets.connect.addressing.path') },
                { value: 'virtual', label: translate('assets.connect.addressing.virtual') },
              ]}
              onChange={(addressing) => setFields({ ...fields, addressing })}
            />
          </div>
          <label>
            {translate('assets.connect.publicUrl')}
            <input {...field('publicBaseUrl')} placeholder={translate('assets.connect.bucketUrlPlaceholder')} />
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
  const translate = useTranslate();
  return (
    <>
      <label>
        {translate('assets.connect.accessKeyId')}
        <input {...field('accessKeyId')} />
      </label>
      <label>
        {translate('assets.connect.secretAccessKey')}
        <input {...field('secretAccessKey', { secret: true })} />
      </label>
    </>
  );
}
