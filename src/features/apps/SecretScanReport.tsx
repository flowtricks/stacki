// The secret scan's report, shown before sharing, making public and submitting
// (docs/apps.md, "Secret scanning"). A finding blocks the next step: there is
// no override. Each one names its file and line with a masked excerpt, and the
// report shows how to move the key into an app setting, which every installer
// fills in with their own. "I've removed it, rescan" reads the files again.
import { useState, type ReactNode } from 'react';
import { assert } from '../../../shared/core/assert';
import { secretRuleLabel, type AppSecretScan } from '../../../shared/properties/appSecrets';
import { CodeBlock, CodeInline } from '../../ui/CodeBlock';
import { CheckIcon, ChevronDownIcon, RefreshIcon, WarningTriangleIcon } from '../../ui/Icons';

export type ScanLoad =
  { readonly kind: 'loading' } | { readonly kind: 'failed'; readonly message: string } | { readonly kind: 'ready'; readonly scan: AppSecretScan };

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
  switch (load.kind) {
    case 'loading':
      return (
        <p className="apps-note apps-scan" role="status">
          Scanning the app’s files for secrets…
        </p>
      );
    case 'failed':
      return (
        <ScanBlocked title="The secret scan could not run" onRescan={onRescan}>
          {load.message}
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
export function scanSummary(load: ScanLoad): ScanSummary {
  switch (load.kind) {
    case 'loading':
      return { tone: 'pending', text: 'Scanning the app’s files for secrets…' };
    case 'failed':
      return { tone: 'blocked', text: 'The secret scan could not run' };
    case 'ready': {
      const { scan } = load;
      switch (scan.kind) {
        case 'clean':
          return { tone: 'clean', text: `No secrets found in ${scan.filesScanned} ${scan.filesScanned === 1 ? 'file' : 'files'}` };
        case 'too-large':
          return { tone: 'blocked', text: 'The app is too large to scan' };
        case 'found': {
          assert(scan.findings.length > 0, 'A scan that found something lists it');
          const one = scan.findings.length === 1 && !scan.truncated;
          return { tone: 'blocked', text: `${scan.findings.length}${scan.truncated ? '+' : ''} possible ${one ? 'secret' : 'secrets'} found` };
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
  const [open, setOpen] = useState(false);
  const summary = scanSummary(load);
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
              {open ? 'Hide' : 'Details'}
              <ChevronDownIcon size={10} className={open ? 'apps-share-scan-chevron open' : 'apps-share-scan-chevron'} />
            </button>
            <button type="button" className="apps-share-scan-action" onClick={onRescan}>
              <RefreshIcon size={10} /> Rescan
            </button>
          </>
        )}
      </div>
      {blocked && open && <div className="apps-share-scan-detail">{scanDetail(load)}</div>}
    </div>
  );
}

function scanDetail(load: ScanLoad): ReactNode {
  if (load.kind === 'failed') {
    return <p className="apps-note">{load.message}</p>;
  }
  assert(load.kind === 'ready', 'Only a finished scan has details');
  const { scan } = load;
  if (scan.kind === 'too-large') {
    return <p className="apps-note">{scan.reason}. A scan that cannot finish does not pass.</p>;
  }
  assert(scan.kind === 'found', 'A clean scan has no details');
  return <ScanFindings scan={scan} />;
}

function ScanResult({ scan, onRescan }: { readonly scan: AppSecretScan; readonly onRescan: () => void }) {
  switch (scan.kind) {
    case 'clean':
      return (
        <p className="apps-scan apps-scan-clean" role="status">
          <CheckIcon size={13} /> No secrets found in {scan.filesScanned} {scan.filesScanned === 1 ? 'file' : 'files'}.
        </p>
      );
    case 'too-large':
      return (
        <ScanBlocked title="The app is too large to scan" onRescan={onRescan}>
          {scan.reason}. A scan that cannot finish does not pass.
        </ScanBlocked>
      );
    case 'found': {
      assert(scan.findings.length > 0, 'A scan that found something lists it');
      const count = `${scan.findings.length}${scan.truncated ? '+' : ''}`;
      return (
        <div className="apps-scan apps-scan-found" role="alert">
          <p className="apps-scan-title">
            <WarningTriangleIcon size={14} /> Found {count} possible {scan.findings.length === 1 && !scan.truncated ? 'secret' : 'secrets'}
          </p>
          <ScanFindings scan={scan} />
          <button type="button" className="apps-button" onClick={onRescan}>
            <RefreshIcon size={12} /> I’ve removed it, rescan
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
  return (
    <>
      <p className="apps-note">Everyone who installs the app would get these keys. Remove each one before it leaves this computer.</p>
      <ul className="apps-scan-findings">
        {scan.findings.map((finding) => (
          <li key={`${finding.file}:${finding.line}:${finding.excerpt}`} className="apps-scan-finding">
            <span className="apps-scan-where">
              <CodeInline text={`${finding.file}:${finding.line}`} />
              <span className="apps-note">{secretRuleLabel(finding.rule)}</span>
            </span>
            <CodeInline text={finding.excerpt} filename={finding.file} />
            <span className="apps-note">
              Line hash <CodeInline text={finding.lineSha256} />
            </span>
          </li>
        ))}
      </ul>
      <p className="apps-note">
        Move each key into an app setting: declare it in <CodeInline text="stacki-app.json" />, and each person fills in their own in the app’s details.
      </p>
      <CodeBlock text={SETTING_EXAMPLE} language="json" label="Declare a secret setting" />
      <p className="apps-note">Then read it in the app:</p>
      <CodeBlock text={READ_EXAMPLE} language="javascript" label="Read the setting" />
      <p className="apps-note">
        A line that only looks like a key, such as a test fixture, can be listed in the manifest’s <CodeInline text="secretsAllowlist" /> by its file and{' '}
        <CodeInline text="lineSha256" />, where reviewers see it.
      </p>
    </>
  );
}

function ScanBlocked(props: { readonly title: string; readonly onRescan: () => void; readonly children: ReactNode }) {
  return (
    <div className="apps-scan apps-scan-found" role="alert">
      <p className="apps-scan-title">
        <WarningTriangleIcon size={14} /> {props.title}
      </p>
      <p className="apps-note">{props.children}</p>
      <button type="button" className="apps-button" onClick={props.onRescan}>
        <RefreshIcon size={12} /> Scan again
      </button>
    </div>
  );
}
