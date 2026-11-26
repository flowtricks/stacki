// What a full code editor gains when the app can read the project behind it: suggestions, squiggles, hover and
// signature help, all from code intelligence (shared/ipc/codeIntel.ts) about the text as it stands, saved or not.
// An editor takes it as one more CodeMirror extension, so an editor without it is unchanged.
import { linter, type Diagnostic } from '@codemirror/lint';
import type { Extension } from '@codemirror/state';
import { hoverTooltip, type HoverTooltipSource } from '@codemirror/view';
import { codeIntelCompletion, type CompletionWords } from './codeIntelCompletion';
import { codeIntelSession, type CodeIntelFile, type CodeIntelSession } from './codeIntelSession';
import { codeIntelSignature } from './codeIntelSignature';
import { describedElement } from './codeIntelText';
import { codeIntelTheme } from './codeIntelTheme';
import '../../ui/codeBlock.css';

/** How long typing rests before the file is checked again. */
const CHECK_DELAY_MS = 500;
const HOVER_DELAY_MS = 350;

export function codeIntelExtension(words: CompletionWords, file: () => CodeIntelFile | undefined): Extension {
  const session = codeIntelSession(file);
  return [
    codeIntelCompletion(session, words),
    linter((view) => diagnosticsFor(session, view.state.doc.toString()), { delay: CHECK_DELAY_MS }),
    hoverTooltip(
      async (view, position) => {
        const text = view.state.doc.toString();
        const reply = await session.ask(text, { kind: 'hover', position });
        if (reply.kind !== 'hover' || reply.hover === undefined || view.state.doc.toString() !== text) {
          return noTooltip();
        }
        const { from, to, signature, documentation } = reply.hover;
        const content = describedElement(signature, documentation);
        if (content === undefined) {
          return noTooltip();
        }
        content.classList.add('code-intel-hover');
        return { pos: from, end: to, above: true, create: () => ({ dom: content }) };
      },
      { hoverTime: HOVER_DELAY_MS, hideOnChange: true },
    ),
    codeIntelSignature(session),
    codeIntelTheme,
  ];
}

function noTooltip(): Awaited<ReturnType<HoverTooltipSource>> {
  // eslint-disable-next-line stacki/no-null -- CodeMirror's hover source answers null for nothing to show.
  return null;
}

async function diagnosticsFor(session: CodeIntelSession, text: string): Promise<Diagnostic[]> {
  const reply = await session.ask(text, { kind: 'diagnostics' });
  if (reply.kind !== 'diagnostics') {
    return [];
  }
  return reply.diagnostics.map((diagnostic) => {
    // A mistake at a point, as a missing token is, takes the character beside it so there is something to underline.
    const from = Math.min(diagnostic.from, Math.max(0, text.length - 1));
    const to = Math.min(text.length, Math.max(diagnostic.to, from + 1));
    return { from, to, severity: diagnostic.severity, message: diagnostic.message };
  });
}
