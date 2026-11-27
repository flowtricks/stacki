// A chat as Markdown, for "Copy chat as Markdown" (the composer's "+" menu and its `/export` command).
// What is exported is the conversation a person would paste into a note or an issue: what they asked
// and what the agent answered, in order. The agent's work (tool calls, thoughts, permission requests,
// changes) is left out: it is the agent's process, not the conversation, and a command's output can
// be megabytes. A subagent's words are left out too: the transcript itself draws them elsewhere.
import { assert } from '../../../../shared/core/assert';
import { sentMarkdownText } from '../../../../shared/properties/ai/sentMessage';
import type { TranscriptItem } from '../chatReducer';

export const EXPORT_LIMITS = {
  /** The most characters an export holds; past it the rest is cut, with a line that says so. Why: the clipboard is not a file store. */
  charsMax: 2_000_000,
} as const satisfies Record<string, number>;

/** The words an export is written with, from the caller's translator so it reads in the person's language. */
export interface ExportLabels {
  /** The chat's title, the export's first heading; undefined for a chat with none. */
  readonly title: string | undefined;
  /** The heading of the person's messages ("You"). */
  readonly you: string;
  /** The heading of the agent's replies ("Claude"). */
  readonly agent: string;
  /** The heading of a message's attachments, followed by their names ("Attachments"). */
  readonly attachments: string;
  /** The line that ends an export cut at `EXPORT_LIMITS.charsMax`. */
  readonly truncated: string;
}

/** The conversation of `items` as Markdown: a heading per message, the message's own Markdown under it. */
export function transcriptMarkdown(items: readonly TranscriptItem[], labels: ExportLabels): string {
  assert(labels.you.length > 0, 'transcriptMarkdown: the person has a heading');
  assert(labels.agent.length > 0, 'transcriptMarkdown: the agent has a heading');
  const sections: string[] = [];
  if (labels.title !== undefined && labels.title.trim() !== '') {
    sections.push(`# ${oneLine(labels.title)}`);
  }
  let size = 0;
  for (const item of items) {
    const section = sectionOf(item, labels);
    if (section === undefined) {
      continue;
    }
    if (size + section.length > EXPORT_LIMITS.charsMax) {
      sections.push(`_${labels.truncated}_`);
      break;
    }
    size += section.length;
    sections.push(section);
  }
  assert(size <= EXPORT_LIMITS.charsMax, 'transcriptMarkdown: the messages stay within the bound');
  return `${sections.join('\n\n')}\n`;
}

/** Whether a chat has anything to export: a message from either side. */
export function hasExportableMessages(items: readonly TranscriptItem[]): boolean {
  return items.some((item) => isConversation(item));
}

function sectionOf(item: TranscriptItem, labels: ExportLabels): string | undefined {
  if (!isConversation(item)) {
    return undefined;
  }
  if (item.kind === 'user') {
    const names = item.attachments.map((attachment) => attachment.name);
    const attached = names.length === 0 ? '' : `\n\n${labels.attachments}: ${names.join(', ')}`;
    // Selected code is fenced, so the export reads as Markdown and no code closes its own block.
    return `## ${labels.you}\n\n${sentMarkdownText(item.text, item.parts).trim()}${attached}`;
  }
  assert(item.kind === 'text', 'sectionOf: a conversation item is a message');
  return `## ${labels.agent}\n\n${item.text.trim()}`;
}

/** The person's messages and the agent's own replies: not thoughts, and not a subagent's words. */
function isConversation(item: TranscriptItem): item is Extract<TranscriptItem, { readonly kind: 'user' | 'text' }> {
  if (item.kind === 'user') {
    return item.text.trim() !== '' || item.attachments.length > 0;
  }
  if (item.kind === 'text') {
    return item.role === 'agent' && item.parent === undefined && item.text.trim() !== '';
  }
  return false;
}

/** A title on one line, so it stays one heading. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
