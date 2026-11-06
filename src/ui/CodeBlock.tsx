import React, { useEffect, useMemo, useState } from 'react';
import { astroCodeLines } from './astroHighlight';
import { codeTokenLines, languageFor, plainCodeLines, type CodeLanguage, type CodeLine } from './codeHighlight';
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
 * The text as coloured lines. Astro's grammar loads on demand, so its text is
 * plain until the lines arrive, as the editor keeps it neutral while it loads.
 */
export function useCodeLines(text: string, language: CodeLanguage | undefined): readonly CodeLine[] {
  const [astro, setAstro] = useState<{ readonly text: string; readonly lines: readonly CodeLine[] }>();
  const immediate = useMemo(() => (language === 'astro' ? plainCodeLines(text) : codeTokenLines(text, language)), [text, language]);
  useEffect(() => {
    if (language !== 'astro') {
      return;
    }
    let active = true;
    astroCodeLines(text)
      .then((lines) => {
        if (active) {
          setAstro({ text, lines });
        }
      })
      .catch((error: unknown) => {
        // Highlighting is presentation, so a grammar failure must not take the
        // code down with it: the plain lines stay on screen.
        console.error('Astro syntax highlighting failed', error);
      });
    return () => {
      active = false;
    };
  }, [text, language]);
  return language === 'astro' && astro?.text === text ? astro.lines : immediate;
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
