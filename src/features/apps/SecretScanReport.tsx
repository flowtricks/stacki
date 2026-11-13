// The secret scan's report, shown before sharing, making public and submitting
// (docs/apps.md, "Secret scanning"). A finding blocks the next step: there is
// no override. Each one names its file and line with a masked excerpt, and the
// report shows how to move the key into an app setting, which every installer
// fills in with their own. "I've removed it, rescan" reads the files again.
import type { MessageRef } from '../../../shared/core/i18n/messageReference';
import { useState, type ReactNode } from 'react';
import { assert } from '../../../shared/core/assert';
import { secretRuleRef, type AppSecretScan } from '../../../shared/properties/appSecrets';
import type { Translator } from '../../../shared/properties/i18n/messageRef';
import { useTranslate, useTranslateDescribed, useTranslateRef, useTranslateRich } from '../../lib/i18n/useTranslate';
import { CodeBlock, CodeInline } from '../../ui/CodeBlock';
import { CheckIcon, ChevronDownIcon, RefreshIcon, WarningTriangleIcon } from '../../ui/Icons';

export type ScanLoad =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed'; readonly message: string; readonly messageRef?: MessageRef | undefined }
  | { readonly kind: 'ready'; readonly scan: AppSecretScan };

/** Whether a scan lets the next step run: only a clean one does. */
export function scanPassed(load: ScanLoad): boolean {
  return load.kind === 'ready' && load.scan.kind === 'clean';
}

const SETTING_EXAMPLE = `"settings": [
  { "id": "api-key", "label": "API key", "kind": "secret", "required": true }
]`;
const READ_EXAMPLE = `const settings = await stacki.settings.get();
fetch(url, { headers: { Authorization: \`Bearer \${settings['api-key']}\` } });`;

export function SecretScanReport({ load, onRescan }: { readonly load: ScanLoad; readonly onRescan: () => void }) {
  const translate = useTranslate();
  const translateDescribed = useTranslateDescribed();
  switch (load.kind) {
    case 'loading':
      return (
        <p className="apps-note apps-scan" role="status">
          {translate('apps.scan.scanning')}
        </p>
      );
    case 'failed':
      return (
        <ScanBlocked title={translate('apps.scan.couldNotRun')} onRescan={onRescan}>
          {translateDescribed(load)}
        </ScanBlocked>
      );
    case 'ready':
      return <ScanResult scan={load.scan} onRescan={onRescan} />;
    default: {
      const exhaustive: never = load;
      return exhaustive;
    }
  }
}

/** One line for a scan: its tone, what it says, and whether there is more to read. */
export interface ScanSummary {
  readonly tone: 'pending' | 'clean' | 'blocked';
  readonly text: string;
}

/** What the compact scan row says for each state; a blocked scan always has details to expand. */
export function scanSummary(load: ScanLoad, translate: Translator): ScanSummary {
  switch (load.kind) {
    case 'loading':
      return { tone: 'pending', text: translate('apps.scan.scanning') };
    case 'failed':
      return { tone: 'blocked', text: translate('apps.scan.couldNotRun') };
    case 'ready': {
      const { scan } = load;
      switch (scan.kind) {
        case 'clean':
          return { tone: 'clean', text: translate('apps.scan.noneFound', { count: scan.filesScanned }) };
        case 'too-large':
          return { tone: 'blocked', text: translate('apps.scan.tooLarge') };
        case 'found': {
          assert(scan.findings.length > 0, 'A scan that found something lists it');
          return {
            tone: 'blocked',
            text: translate('apps.scan.possibleFound', { count: scan.findings.length, total: `${scan.findings.length}${scan.truncated ? '+' : ''}` }),
          };
        }
        default: {
          const exhaustive: never = scan;
          return exhaustive;
        }
      }
    }
    default: {
      const exhaustive: never = load;
      return exhaustive;
    }
  }
}

/**
 * The share form's scan as one status row: a check when clean, a warning with
 * the count otherwise, which expands to the findings (or why the scan could not
 * finish) and offers a rescan. A blocked scan still blocks Share.
 */
export function SecretScanStatus({ load, onRescan }: { readonly load: ScanLoad; readonly onRescan: () => void }) {
  const translate = useTranslate();
  const [open, setOpen] = useState(false);
  const summary = scanSummary(load, translate);
  const blocked = summary.tone === 'blocked';
  return (
    <div className={`apps-share-scan ${summary.tone}`} role={blocked ? 'alert' : 'status'}>
      <div className="apps-share-scan-row">
        <span className="apps-share-scan-icon" aria-hidden="true">
          {summary.tone === 'clean' ? (
            <CheckIcon size={12} />
          ) : summary.tone === 'blocked' ? (
            <WarningTriangleIcon size={12} />
          ) : (
            <span className="apps-share-spinner" />
          )}
        </span>
        <span className="apps-share-scan-text">{summary.text}</span>
        {blocked && (
          <>
            <button type="button" className="apps-share-scan-action" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
              {open ? translate('apps.scan.hide') : translate('apps.scan.details')}
              <ChevronDownIcon size={10} className={open ? 'apps-share-scan-chevron open' : 'apps-share-scan-chevron'} />
            </button>
            <button type="button" className="apps-share-scan-action" onClick={onRescan}>
              <RefreshIcon size={10} /> {translate('apps.scan.rescan')}
            </button>
          </>
        )}
      </div>
      {blocked && open && (
        <div className="apps-share-scan-detail">
          <ScanDetail load={load} />
        </div>
      )}
    </div>
  );
}

function ScanDetail({ load }: { readonly load: ScanLoad }): ReactNode {
  const translate = useTranslate();
  const translateDescribed = useTranslateDescribed();
  if (load.kind === 'failed') {
    return <p className="apps-note">{translateDescribed(load)}</p>;
  }
  assert(load.kind === 'ready', 'Only a finished scan has details');
  const { scan } = load;
  if (scan.kind === 'too-large') {
    return (
      <p className="apps-note">{translate('apps.scan.cannotFinish', { reason: translateDescribed({ message: scan.reason, messageRef: scan.reasonRef }) })}</p>
    );
  }
  assert(scan.kind === 'found', 'A clean scan has no details');
  return <ScanFindings scan={scan} />;
}

function ScanResult({ scan, onRescan }: { readonly scan: AppSecretScan; readonly onRescan: () => void }) {
  const translate = useTranslate();
  const translateDescribed = useTranslateDescribed();
  switch (scan.kind) {
    case 'clean':
      return (
        <p className="apps-scan apps-scan-clean" role="status">
          <CheckIcon size={13} /> {translate('apps.scan.noneFoundSentence', { count: scan.filesScanned })}
        </p>
      );
    case 'too-large':
      return (
        <ScanBlocked title={translate('apps.scan.tooLarge')} onRescan={onRescan}>
          {translate('apps.scan.cannotFinish', { reason: translateDescribed({ message: scan.reason, messageRef: scan.reasonRef }) })}
        </ScanBlocked>
      );
    case 'found': {
      assert(scan.findings.length > 0, 'A scan that found something lists it');
      return (
        <div className="apps-scan apps-scan-found" role="alert">
          <p className="apps-scan-title">
            <WarningTriangleIcon size={14} />{' '}
            {translate('apps.scan.foundTitle', { count: scan.findings.length, total: `${scan.findings.length}${scan.truncated ? '+' : ''}` })}
          </p>
          <ScanFindings scan={scan} />
          <button type="button" className="apps-button" onClick={onRescan}>
            <RefreshIcon size={12} /> {translate('apps.scan.removedRescan')}
          </button>
        </div>
      );
    }
    default: {
      const exhaustive: never = scan;
      return exhaustive;
    }
  }
}

/** What a scan found and how to fix it: each finding, then how to move a key into an app setting. */
function ScanFindings({ scan }: { readonly scan: Extract<AppSecretScan, { readonly kind: 'found' }> }) {
  assert(scan.findings.length > 0, 'A scan that found something lists it');
  const translate = useTranslate();
  const translateRef = useTranslateRef();
  const translateRich = useTranslateRich();
  return (
    <>
      <p className="apps-note">{translate('apps.scan.everyone')}</p>
      <ul className="apps-scan-findings">
        {scan.findings.map((finding) => (
          <li key={`${finding.file}:${finding.line}:${finding.excerpt}`} className="apps-scan-finding">
            <span className="apps-scan-where">
              <CodeInline text={`${finding.file}:${finding.line}`} />
              <span className="apps-note">{translateRef(secretRuleRef(finding.rule))}</span>
            </span>
            <CodeInline text={finding.excerpt} filename={finding.file} />
            <span className="apps-note">{translateRich('apps.scan.lineHash', { hash: <CodeInline text={finding.lineSha256} /> })}</span>
          </li>
        ))}
      </ul>
      <p className="apps-note">{translateRich('apps.scan.moveKey', { file: <CodeInline text="stacki-app.json" /> })}</p>
      <CodeBlock text={SETTING_EXAMPLE} language="json" label={translate('apps.scan.declare')} />
      <p className="apps-note">{translate('apps.scan.thenRead')}</p>
      <CodeBlock text={READ_EXAMPLE} language="javascript" label={translate('apps.scan.readSetting')} />
      <p className="apps-note">
        {translateRich('apps.scan.allowlist', { field: <CodeInline text="secretsAllowlist" />, hash: <CodeInline text="lineSha256" /> })}
      </p>
    </>
  );
}

function ScanBlocked(props: { readonly title: string; readonly onRescan: () => void; readonly children: ReactNode }) {
  const translate = useTranslate();
  return (
    <div className="apps-scan apps-scan-found" role="alert">
      <p className="apps-scan-title">
        <WarningTriangleIcon size={14} /> {props.title}
      </p>
      <p className="apps-note">{props.children}</p>
      <button type="button" className="apps-button" onClick={props.onRescan}>
        <RefreshIcon size={12} /> {translate('apps.scan.again')}
      </button>
    </div>
  );
}
