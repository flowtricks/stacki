import React, { useEffect, useMemo, useState } from 'react';
import { assert } from '../../shared/core/assert';
import { LIMITS } from '../../shared/core/limits';
import { astroCodeLineBatches, astroCodeLinesNow } from './astroHighlight';
import { codeLineBatches, codeTokenLines, languageFor, plainCodeLines, type CodeLanguage, type CodeLine } from './codeHighlight';
import './codeBlock.css';

// Code, shown rather than edited.
//
// Every place the app puts code in front of someone draws it with these
// components, or with an editor (AGENTS.md, "Code display"). Plain grey text in
// a <pre> is harder to read for exactly the reason highlighting exists, and next
// to the editor's panes it reads as a different program's output.
//
// The elements are a plain <pre> and <code> holding coloured spans, so a call
// site's own class sets size, scroll and wrap as it would for any other text.
// `test/renderer/ui/codeDisplayRule.test.js` holds the rule.

interface CodeProps {
  readonly text: string;
  /** Given directly, or worked out from `filename`. Text in neither still shows, uncoloured. */
  readonly language?: CodeLanguage | undefined;
  readonly filename?: string | undefined;
  readonly className?: string | undefined;
}

/**
 * A highlighted, read-only block of code. A block with a `label` is a named
 * stop in the tab order, so a keyboard can scroll it.
 */
export function CodeBlock({ text, language, filename, className, label }: CodeProps & { readonly label?: string | undefined }) {
  const lines = useCodeLines(text, language ?? languageFor(filename));
  const focus = label === undefined ? {} : { 'aria-label': label, tabIndex: 0 };
  return (
    <pre className={codeClassName('code-block', className)} {...focus}>
      <code>
        <CodeLines lines={lines} />
      </code>
    </pre>
  );
}

/** Highlighted code inside a sentence or a row: a shell command, a type, a value. */
export function CodeInline({ text, language, filename, className }: CodeProps) {
  const lines = useCodeLines(text, language ?? languageFor(filename));
  return (
    <code className={codeClassName('code-inline', className)}>
      <CodeLines lines={lines} />
    </code>
  );
}

/** The tokens of one line, for a host that lays its lines out itself, as a diff does. */
export function CodeTokens({ line }: { readonly line: CodeLine | undefined }) {
  return line?.map((token, index) =>
    token.style === undefined ? (
      <React.Fragment key={index}>{token.text}</React.Fragment>
    ) : (
      <span key={index} className="code-token" style={token.style}>
        {token.text}
      </span>
    ),
  );
}

/**
 * The text as coloured lines. Astro's grammar loads on demand: once loaded (the
 * app fetches it when a project opens) the first paint is coloured; before
 * that the text is plain until the lines arrive. Text longer than one slice is
 * coloured the same way, top first: it shows plain at once, then the coloured
 * top grows over it in batches, each of bounded work, so text of any length
 * paints instantly and never blocks input.
 */
export function useCodeLines(text: string, language: CodeLanguage | undefined): readonly CodeLine[] {
  const [grown, setGrown] = useState<{ readonly text: string; readonly language: CodeLanguage | undefined; readonly lines: readonly CodeLine[] }>();
  // Undefined only for Astro text whose grammar is still loading, and for text longer than a slice.
  const now = useMemo(() => {
    if (text.length > LIMITS.syntaxHighlightSliceCharsMax) {
      return undefined;
    }
    return language === 'astro' ? astroCodeLinesNow(text) : codeTokenLines(text, language);
  }, [text, language]);
  const plain = useMemo(() => plainCodeLines(text), [text]);
  useEffect(() => {
    if (now !== undefined || language === undefined) {
      return;
    }
    const stopper = new AbortController();
    colourInBatches(text, language, { plain, signal: stopper.signal }, (lines) => {
      setGrown({ text, language, lines });
    }).catch((error: unknown) => {
      // Highlighting is presentation, so a grammar failure must not take the
      // code down with it: the plain lines stay on screen.
      console.error('Syntax highlighting failed', error);
    });
    return () => {
      // The pass ends at its next batch: a block that changed or went away is not coloured on.
      stopper.abort();
    };
  }, [text, language, now, plain]);
  if (now !== undefined) {
    return now;
  }
  return grown?.text === text && grown.language === language ? grown.lines : plain;
}

// Hands `publish` the coloured lines grown so far, laid over the plain rest, each
// time the coloured part has doubled and once at the end: React redraws the
// block a logarithmic number of times, and the joins cost the text's length in all.
async function colourInBatches(
  text: string,
  language: CodeLanguage,
  context: { readonly plain: readonly CodeLine[]; readonly signal: AbortSignal },
  publish: (lines: readonly CodeLine[]) => void,
): Promise<void> {
  const { plain, signal } = context;
  const batches = language === 'astro' ? astroCodeLineBatches(text) : codeLineBatches(text, language);
  const coloured: CodeLine[] = [];
  let publishAt = 1;
  for await (const batch of batches) {
    if (signal.aborted) {
      return;
    }
    for (const line of batch) {
      coloured.push(line);
    }
    if (coloured.length >= publishAt) {
      publish([...coloured, ...plain.slice(coloured.length)]);
      publishAt = coloured.length * 2;
    }
  }
  assert(coloured.length === plain.length, 'colourInBatches: the coloured lines are the lines of the text');
  publish(coloured);
}

function CodeLines({ lines }: { readonly lines: readonly CodeLine[] }) {
  return lines.map((line, index) => (
    <React.Fragment key={index}>
      {index > 0 && '\n'}
      <CodeTokens line={line} />
    </React.Fragment>
  ));
}

function codeClassName(base: string, className: string | undefined): string {
  return className === undefined ? base : `${base} ${className}`;
}
