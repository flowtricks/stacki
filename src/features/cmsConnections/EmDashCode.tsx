// A command or snippet in the EmDash dialog: the app's highlighted CodeBlock, wrapped so a long command never scrolls the
// dialog sideways (cmsConnections.css), with a Copy button. Copying is the whole point of showing a command here, so the
// button is always visible, not a hover affordance; if the clipboard refuses (a locked-down host), nothing changes and the
// text can still be selected.
import { useEffect, useRef, useState } from 'react';
import { CodeBlock } from '../../ui/CodeBlock';
import { CheckIcon, CopyIcon } from '../../ui/Icons';
import type { CodeLanguage } from '../../ui/codeHighlight';
import { useTranslate } from '../../lib/i18n/useTranslate';

/** How long the check mark stays after a copy. */
const COPIED_MS = 1500;

/**
 * `words` (a command or a snippet) wraps at spaces and keeps each highlighted token whole, so `react-dom` and a flag are never
 * split; `anywhere` (install output, whose lines can have no space at all) breaks wherever it must so nothing scrolls sideways.
 */
export type EmDashCodeWrap = 'words' | 'anywhere';

export function EmDashCode({
  text,
  language,
  label,
  wrap = 'words',
}: {
  readonly text: string;
  readonly language: CodeLanguage;
  readonly label: string;
  readonly wrap?: EmDashCodeWrap;
}) {
  const translate = useTranslate();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(
    () => () => {
      clearTimeout(timer.current);
    },
    [],
  );
  const copy = (): void => {
    navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), COPIED_MS);
      },
      () => undefined,
    );
  };
  return (
    <div className="emdash-code" data-wrap={wrap}>
      <CodeBlock text={text} language={language} label={label} />
      <button
        type="button"
        className="ghost emdash-code-copy"
        aria-label={translate('emdash.install.copy')}
        title={translate('emdash.install.copy')}
        onClick={copy}
      >
        {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
      </button>
    </div>
  );
}
