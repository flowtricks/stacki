// What an agent hands back as a subagent's result, made fit to show a designer. The agents wrap bookkeeping of their
// own into a report (Claude Code's `<tools-used-before-summary>`, `<usage>`, `<system-reminder>`, the "Async agent
// launched successfully" note its background launch returns): none of it is the agent's words, so it goes, tags and
// content, before the report is drawn or summarised. Only those known wrappers are taken out: a tag the agent writes
// in its own prose (`<Eyebrow>` in "the <Eyebrow> component") is the agent's, and stays.
//
// The one-line preview under a finished subagent is plain text: Markdown marks (backticks, emphasis, links, headings,
// list bullets) are taken off so it reads as a sentence; the opened card renders the report as Markdown.
import { assert } from '../../../shared/core/assert';

/** The wrappers removed with their content: bookkeeping the agents add, never the agent's own words. */
const INTERNAL_TAGS = [
  'tools-used-before-summary',
  'usage',
  'system-reminder',
  'task-notification',
  'local-command-stdout',
  'local-command-stderr',
  'local-command-caveat',
  'command-name',
  'command-message',
  'command-args',
] as const;

/** Characters of a report read; a longer one is cut first (reports are bounded upstream, this keeps the regexes cheap). */
const REPORT_CHARS_READ = 200_000;

const WRAPPED = new RegExp(`<(${INTERNAL_TAGS.join('|')})(?:\\s[^>]*)?>[\\s\\S]*?</\\1>`, 'gu');
/** An opening or closing wrapper left alone (a report cut in the middle of one). */
const STRAY = new RegExp(`</?(?:${INTERNAL_TAGS.join('|')})(?:\\s[^>]*)?>`, 'gu');
/** The note a background launch returns, with the id and the "internal" aside that follow it. */
const LAUNCH_NOTE = /^\s*Async agent launched successfully[\s\S]*?(?:\n\s*\n|$)/iu; // i18n-ignore: the agent's own words, matched, never shown.
/** Lines of ids the agents append: `agentId: …`, `output_file: …`. */
const ID_LINE = /^\s*(?:agentId|agent_id|output_file|outputFile)\s*:/iu;

/** `text` without the agents' bookkeeping; undefined when nothing of the agent's own words is left. */
export function withoutInternalMarkup(text: string): string | undefined {
  const read = text.slice(0, REPORT_CHARS_READ);
  const kept = read
    .replace(WRAPPED, '')
    .replace(STRAY, '')
    .replace(LAUNCH_NOTE, '')
    .split('\n')
    .filter((line) => !ID_LINE.test(line))
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
  assert(kept.length <= read.length, 'withoutInternalMarkup: only removes');
  assert(!WRAPPED.test(kept), 'withoutInternalMarkup: no known wrapper is left');
  WRAPPED.lastIndex = 0;
  return kept === '' ? undefined : kept;
}

/** Markdown read as plain words: code marks, emphasis, links (their words kept), heading and list marks taken off. */
export function plainWords(markdown: string): string {
  const words = markdown
    .replace(/```[\s\S]*?```/gu, ' ')
    .replace(/`([^`\n]*)`/gu, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/(\*\*|__)(\S(?:[\s\S]*?\S)?)\1/gu, '$2')
    .replace(/(^|[\s(])[*_](\S(?:[^*_\n]*?\S)?)[*_](?=[\s).,;:!?]|$)/gu, '$1$2')
    .replace(/^\s{0,3}#{1,6}\s+/gmu, '')
    .replace(/^\s{0,3}>\s?/gmu, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gmu, '');
  assert(words.length <= markdown.length + 1, 'plainWords: only removes marks');
  return words;
}
