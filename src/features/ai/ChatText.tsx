// An agent's reply as text: GitHub-flavoured Markdown (headings, nested and task lists, quotes, tables, rules,
// inline code, bold, italic, strike, links, fenced code) drawn from the tree `parseChatMarkdown` makes, so what
// the agent wrote can never become markup. Fenced code is syntax highlighted through CodeBlock, as all code in
// the app is, under a language label with a copy button. A table scrolls sideways inside its own box and
// never widens the panel. A numbered list the agent writes as its own code block is a question to answer: when
// the caller says it may be answered (`onQuickReply`), each option is a button that sends it.
//
// Ported from Studio's chat (studio/src/features/ai/ChatText.tsx), which keeps the earlier, smaller subset.
import { useMemo, type CSSProperties, type ReactNode } from 'react';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { openExternalURL } from '../../ipc/appBridge';
import { CodeBlock, CodeInline } from '../../ui/CodeBlock';
import { languageNamed } from '../../ui/codeHighlight';
import { CheckIcon, CopyIcon } from '../../ui/Icons';
import {
  MARKDOWN_LIMITS,
  parseChatMarkdown,
  parseQuickReplies,
  quickReplyText,
  type Block,
  type CellAlign,
  type Inline,
  type ListItem,
  type QuickReply,
} from './markdown/chatMarkdown';
import { useCopy } from './transcript/copyText';
import './markdown/markdown.css';

export function ChatText({ text, onQuickReply }: { readonly text: string; readonly onQuickReply?: ((reply: string) => void) | undefined }) {
  const blocks = useMemo(() => parseChatMarkdown(text), [text]);
  return (
    <div className="ai-markdown">
      {blocks.map((block, index) => (
        <BlockView key={index} block={block} depth={0} onQuickReply={onQuickReply} />
      ))}
    </div>
  );
}

function BlockView({
  block,
  depth,
  onQuickReply,
}: {
  readonly block: Block;
  readonly depth: number;
  readonly onQuickReply: ((reply: string) => void) | undefined;
}) {
  if (depth > MARKDOWN_LIMITS.depthMax) {
    return undefined; // The parser never builds this deep; a hand-made tree stops here.
  }
  switch (block.kind) {
    case 'paragraph':
      return <p>{inline(block.inline, 0)}</p>;
    case 'heading': {
      const Tag = `h${block.level}` as const;
      return <Tag>{inline(block.inline, 0)}</Tag>;
    }
    case 'code':
      return <FencedCode language={block.language} text={block.text} onQuickReply={depth === 0 ? onQuickReply : undefined} />;
    case 'list':
      return <ListView ordered={block.ordered} start={block.start} items={block.items} depth={depth} />;
    case 'quote':
      return (
        <blockquote className="ai-md-quote">
          {block.blocks.map((child, index) => (
            <BlockView key={index} block={child} depth={depth + 1} onQuickReply={undefined} />
          ))}
        </blockquote>
      );
    case 'table':
      return <TableView align={block.align} header={block.header} rows={block.rows} />;
    case 'rule':
      return <hr className="ai-md-rule" />;
    default: {
      const exhaustive: never = block;
      return exhaustive;
    }
  }
}

function ListView({
  ordered,
  start,
  items,
  depth,
}: {
  readonly ordered: boolean;
  readonly start: number;
  readonly items: readonly ListItem[];
  readonly depth: number;
}) {
  const hasTasks = items.some((item) => item.task !== undefined);
  const Tag = ordered ? 'ol' : 'ul';
  return (
    <Tag className={hasTasks ? 'ai-md-tasks' : undefined} {...(ordered && start !== 1 ? { start } : {})}>
      {items.map((item, index) => (
        <li key={index} className={item.task === undefined ? undefined : 'ai-md-task'}>
          {item.task !== undefined && <TaskBox checked={item.task === 'checked'} />}
          <div className="ai-md-item">
            {item.blocks.map((child, position) => (
              <BlockView key={position} block={child} depth={depth + 1} onQuickReply={undefined} />
            ))}
          </div>
        </li>
      ))}
    </Tag>
  );
}

function TaskBox({ checked }: { readonly checked: boolean }) {
  const translate = useTranslate();
  return (
    <span
      className={`ai-md-box${checked ? ' is-checked' : ''}`}
      role="checkbox"
      aria-checked={checked}
      aria-readonly="true"
      aria-label={checked ? translate('ai.markdown.taskDone') : translate('ai.markdown.taskOpen')}
    >
      {checked && <CheckIcon size={10} />}
    </span>
  );
}

function TableView({
  align,
  header,
  rows,
}: {
  readonly align: readonly CellAlign[];
  readonly header: readonly (readonly Inline[])[];
  readonly rows: readonly (readonly (readonly Inline[])[])[];
}) {
  const translate = useTranslate();
  const cell = (column: number): CSSProperties | undefined => {
    const side = align[column];
    return side === undefined || side === 'default' ? undefined : { textAlign: side };
  };
  return (
    // A focusable, named region: a keyboard scrolls a wide table sideways, and a screen reader says what it is.
    <div className="ai-md-table-wrap" role="region" aria-label={translate('ai.markdown.table')} tabIndex={0}>
      <table className="ai-md-table">
        <thead>
          <tr>
            {header.map((content, column) => (
              <th key={column} style={cell(column)}>
                {inline(content, 0)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {row.map((content, column) => (
                <td key={column} style={cell(column)}>
                  {inline(content, 0)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A fenced block. Options an agent offers as a numbered block become buttons when they can be answered. */
function FencedCode({
  language,
  text,
  onQuickReply,
}: {
  readonly language: string;
  readonly text: string;
  readonly onQuickReply: ((reply: string) => void) | undefined;
}) {
  const replies = onQuickReply === undefined || (language !== '' && language !== 'text') ? undefined : parseQuickReplies(text);
  if (replies !== undefined && onQuickReply !== undefined) {
    return <QuickReplies replies={replies} onPick={onQuickReply} />;
  }
  return <CodeWithCopy language={language} text={text} />;
}

function CodeWithCopy({ language, text }: { readonly language: string; readonly text: string }) {
  const translate = useTranslate();
  const { state, copy } = useCopy();
  return (
    <div className="ai-md-code">
      {language !== '' && <span className="ai-md-code-lang">{language}</span>}
      <button
        className="ai-md-code-copy"
        title={state === 'failed' ? translate('ai.common.copyFailed') : state === 'copied' ? translate('ai.common.copied') : translate('ai.code.copy')}
        aria-label={translate('ai.code.copy')}
        onClick={() => copy(text)}
      >
        {state === 'copied' ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
      </button>
      <CodeBlock text={text} language={languageNamed(language)} />
    </div>
  );
}

/**
 * The agent's numbered options as buttons. The text stays real text (selectable here, and in the message's own
 * Copy), so a person can still copy the question as it was written.
 */
function QuickReplies({ replies, onPick }: { readonly replies: readonly QuickReply[]; readonly onPick: (reply: string) => void }) {
  const translate = useTranslate();
  return (
    <div className="ai-quick" role="group" aria-label={translate('ai.quick.label')}>
      {replies.map((reply) => (
        <button
          key={reply.number}
          className="ai-quick-option"
          title={translate('ai.quick.send', { option: reply.label })}
          onClick={() => onPick(quickReplyText(reply))}
        >
          <span className="ai-quick-number">{reply.number}</span>
          <span className="ai-quick-label">{reply.label}</span>
        </button>
      ))}
    </div>
  );
}

function inline(nodes: readonly Inline[], depth: number): ReactNode {
  if (depth - 1 > MARKDOWN_LIMITS.inlineDepthMax) {
    return undefined; // The parser stops structuring before this; a hand-made tree stops here.
  }
  return nodes.map((node, index) => {
    switch (node.kind) {
      case 'text':
        return node.text;
      case 'code':
        return <CodeInline key={index} text={node.text} />;
      case 'strong':
        return <strong key={index}>{inline(node.children, depth + 1)}</strong>;
      case 'emphasis':
        return <em key={index}>{inline(node.children, depth + 1)}</em>;
      case 'strike':
        return <s key={index}>{inline(node.children, depth + 1)}</s>;
      case 'link':
        return (
          <ChatLink key={index} href={node.href}>
            {inline(node.children, depth + 1)}
          </ChatLink>
        );
      default: {
        const exhaustive: never = node;
        return exhaustive;
      }
    }
  });
}

/** A link the parser already vouched for (web or mail only); it opens in the person's browser, never inside the app. */
function ChatLink({ href, children }: { readonly href: string; readonly children: ReactNode }) {
  const translate = useTranslate();
  return (
    <a
      className="ai-md-link"
      href={href}
      title={translate('ai.markdown.openLink', { url: href })}
      onClick={(event) => {
        event.preventDefault();
        openExternalURL(href).catch((error: unknown) => console.error('Opening a link from the AI panel failed', error));
      }}
    >
      {children}
    </a>
  );
}
