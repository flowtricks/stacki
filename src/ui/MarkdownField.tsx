// A Markdown body in the rich text editor: shown as formatted text, written back as
// Markdown that keeps every block the person did not touch (markdownBlocks.ts reads
// it, markdownWrite.ts writes it). Blocks the editor cannot model are shown as their
// own source, labelled, and edited as text; the toolbar's Markdown view edits the
// whole body as it is written.
import { useMemo, useRef } from 'react';
import { assert } from '../../shared/core/assert';
import CodeEditor from './CodeEditor';
import HtmlField from './HtmlField';
import { markdownHTML, parseMarkdown, type MarkdownReadOptions } from './markdownBlocks';
import { markdownFromHTML } from './markdownWrite';

interface Props {
  readonly value: string;
  readonly label?: string | undefined;
  /** `gfm` shows tables and task list items (the Instructions panel); the CMS reads CommonMark. */
  readonly extensions?: MarkdownReadOptions['extensions'] | undefined;
  readonly onChange: (value: string) => void;
}

export default function MarkdownField({ value, label, extensions = 'commonmark', onChange }: Props) {
  const parsed = useMemo(() => parseMarkdown(value, { extensions }), [value, extensions]);
  // The Markdown this field last wrote and the HTML it came from: while the value is
  // still that Markdown, the editor keeps its own HTML, so writing never moves the caret.
  const emitted = useRef<{ readonly markdown: string; readonly html: string }>();
  const own = emitted.current?.markdown === value ? emitted.current.html : undefined;
  const html = own ?? markdownHTML(parsed);
  assert(value === '' || html !== '' || parsed.blocks.length === 0, 'A body with blocks shows them');
  return (
    <HtmlField
      value={html}
      label={label}
      sourceView={{
        label: 'Markdown',
        render: () => (
          <div className="html-source markdown-source">
            <CodeEditor language="markdown" value={value} onChange={(text: string) => onChange(text)} />
          </div>
        ),
      }}
      onChange={(next) => {
        const markdown = markdownFromHTML(next, parsed, document);
        emitted.current = { markdown, html: next };
        if (markdown !== value) {
          onChange(markdown);
        }
      }}
    />
  );
}
