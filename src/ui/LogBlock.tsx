import './logBlock.css';

// Output a program wrote for a person to read: a dev server's log, a crash record. It is text, not code, so it is
// not syntax highlighted (the "Code display" rule's own exception for logs, test/renderer/ui/codeDisplayRule.test.js).
// What it adds over a bare <pre> is the bounds and the behaviour a log needs: it wraps instead of scrolling sideways,
// it scrolls inside its own box rather than growing the notice around it, and a log longer than `charsMax` shows
// its end, which is where the error is.

interface LogBlockProps {
  readonly text: string;
  /** Characters shown, counted from the end. */
  readonly charsMax: number;
  readonly label?: string | undefined;
}

export function LogBlock({ text, charsMax, label }: LogBlockProps) {
  const shown = text.length > charsMax ? text.slice(-charsMax) : text;
  const focus = label === undefined ? {} : { 'aria-label': label, tabIndex: 0 };
  return (
    <pre className="log-block" {...focus}>
      {shown}
    </pre>
  );
}
