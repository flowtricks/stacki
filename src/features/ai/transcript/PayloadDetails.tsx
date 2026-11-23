// A tool's raw reply (JSON, an error with its stack) kept out of the transcript's default view: one
// small, labelled control, closed, that opens the payload as highlighted code for the person who wants
// it. The transcript itself says what happened in words (toolWords.ts); this is the way to the evidence.
// Styled as the rest of the cards: a background fill, never a border; the block scrolls and reserves its gutter.
import { useId, useState } from 'react';
import { useFormat, useTranslate } from '../../../lib/i18n/useTranslate';
import { CodeBlock } from '../../../ui/CodeBlock';
import { looksLikeJson, payloadText } from './toolWords';
import { clampOutput, OUTPUT_PREVIEW_CHARS } from './transcriptModel';

export function PayloadDetails({ text }: { readonly text: string }) {
  const translate = useTranslate();
  const { formatNumber } = useFormat();
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  const bodyId = useId();
  const shown = open ? (looksLikeJson(text) ? payloadText(text) : text) : '';
  const clamped = all ? { text: shown, hidden: 0 } : clampOutput(shown, { from: 'start', limit: OUTPUT_PREVIEW_CHARS });
  return (
    <>
      <button className="ai-tool-showall ai-tool-details" aria-expanded={open} aria-controls={open ? bodyId : undefined} onClick={() => setOpen(!open)}>
        {open ? translate('ai.tool.hideDetails') : translate('ai.tool.showDetails')}
      </button>
      {open && (
        <div id={bodyId} className="ai-tool-details-body">
          <CodeBlock className="ai-tool-output" text={clamped.text} language={looksLikeJson(text) ? 'json' : undefined} label={translate('ai.tool.output')} />
          {clamped.hidden > 0 && (
            <div className="ai-tool-more">{translate('ai.tool.hiddenMore', { count: clamped.hidden, total: formatNumber(clamped.hidden) })}</div>
          )}
          {clamped.hidden > 0 && (
            <button className="ai-tool-showall" onClick={() => setAll(true)}>
              {translate('ai.tool.showAll')}
            </button>
          )}
        </div>
      )}
    </>
  );
}
