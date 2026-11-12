// What a person sent, turned into the content blocks of an ACP prompt, and the
// parts the transcript keeps of it (docs/contracts.md, "Composer, mentions and
// chips"). Pure but for the file reads, which the caller injects: this file never
// touches the disk by itself, so a test hands it a map of files.
//
// Why the host builds the blocks and not the renderer: a chip names a file, and
// only main may read a file, check that it is inside the project and bound how
// much of it goes to an agent. The renderer sends parts; this file decides.
//
// The rules, in the order they apply to each part:
//   text      joins the running text block (a slash command must be the FIRST text
//             block of a Claude prompt, so text is never split without need);
//   file      reads `@path` into the text; the file's content rides as an embedded
//             `resource` when it is text within `mentionFileCharsMax` and the whole
//             prompt stays within `mentionTotalCharsMax`, else as a `resource_link`
//             the agent reads itself (and the transcript marks the part truncated);
//   skill     first in the message, for Claude, and a command the agent advertises:
//             the leading `/name `; otherwise "Use the `name` skill." and a link to
//             its SKILL.md;
//   builtin   a text block of its own, wrapped in a tag, where the chip stood.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { assert } from '../../../shared/core/assert';
import { err, ok, type Result } from '../../../shared/core/result';
import type { AiFailure, PromptAttachment } from '../../../shared/ipc/aiChat';
import type { AgentId } from '../../../shared/properties/ai/agentIds';
import { AI_LIMITS } from '../../../shared/properties/ai/aiLimits';
import type { SentPart } from '../../../shared/properties/ai/chatModel';
import { isProjectRelativePath, type PromptPart } from '../../../shared/properties/ai/mentions';

/** What building a prompt needs to know about the project, the person's home and the agent. */
export interface PromptSource {
  readonly root: string;
  readonly home: string;
  readonly agent: AgentId;
  /** The agent accepts embedded `resource` blocks (`promptCapabilities.embeddedContext`). */
  readonly embeddedContext: boolean;
  /** The slash commands the agent advertises, without the leading slash. */
  readonly commands: ReadonlySet<string>;
  /** The file's text; undefined when it does not exist; throws when it is not readable text. */
  readonly read: (file: string) => string | undefined;
}

export interface PromptContent {
  /** The plain-text fallback: what an agent without parts, and an old transcript, would read. */
  readonly text: string;
  readonly attachments: readonly PromptAttachment[];
  /** Absent: the message is just `text`. */
  readonly parts: readonly PromptPart[] | undefined;
}

export interface BuiltPrompt {
  readonly blocks: readonly unknown[];
  /** What the transcript keeps of the parts; absent when the message had none. */
  readonly sent: readonly SentPart[] | undefined;
}

/** Characters of a built-in's text hashed into its transcript part: enough to tell versions apart. */
const TEXT_HASH_CHARS = 16;

export function buildPrompt(source: PromptSource, content: PromptContent): Result<BuiltPrompt, AiFailure> {
  const attachmentBlocks = attachmentBlocksOf(source.root, content.attachments);
  const parts = content.parts;
  if (parts === undefined) {
    const blocks = content.text.trim() === '' ? attachmentBlocks : [{ type: 'text', text: content.text }, ...attachmentBlocks];
    return ok({ blocks, sent: undefined });
  }
  if (parts.length > AI_LIMITS.promptPartsMax) {
    return err(invalid('A message has too many parts.'));
  }
  const chips = parts.filter((part) => part.kind !== 'text').length;
  if (chips > AI_LIMITS.mentionsMax) {
    return err(invalid(`A message can mention at most ${AI_LIMITS.mentionsMax} things.`));
  }
  const blocks: unknown[] = [];
  const trailing: unknown[] = [];
  const sent: SentPart[] = [];
  const linked = new Set<string>();
  let buffer = '';
  let embeddedChars = 0;
  const flush = (): void => {
    if (buffer.trim() !== '') {
      blocks.push({ type: 'text', text: buffer });
    }
    buffer = '';
  };
  for (const part of parts) {
    switch (part.kind) {
      case 'text': {
        buffer += part.text;
        sent.push({ kind: 'text', text: part.text });
        break;
      }
      case 'file': {
        const file = resolveInside(source.root, part.path);
        if (file === undefined) {
          return err(invalid(`${part.path} is outside this project, so it cannot be mentioned.`));
        }
        buffer += `@${part.path}`;
        if (linked.has(part.path)) {
          sent.push({ kind: 'file', path: part.path, truncated: false, excerpt: undefined });
          break;
        }
        linked.add(part.path);
        const reference = fileReference(source, file, part.path, embeddedChars);
        embeddedChars += reference.embeddedChars;
        if (reference.block !== undefined) {
          trailing.push(reference.block);
        }
        sent.push(reference.sent);
        break;
      }
      case 'skill': {
        // A leading slash command is the one place a skill is invoked by name; anywhere else it is asked for in words.
        const leading = blocks.length === 0 && buffer.trim() === '';
        if (leading && source.agent === 'claude' && source.commands.has(part.name)) {
          buffer = `/${part.name} `;
        } else {
          buffer += `${buffer === '' || /\s$/.test(buffer) ? '' : ' '}Use the \`${part.name}\` skill. `;
          const link = skillLink(source, part);
          if (link !== undefined) {
            trailing.push(link);
          }
        }
        sent.push({ kind: 'skill', name: part.name, source: part.source, path: part.path });
        break;
      }
      case 'builtin': {
        flush();
        blocks.push({ type: 'text', text: `<app-builder-instructions>\n${part.text}\n</app-builder-instructions>` });
        sent.push({ kind: 'builtin', id: part.id, textHash: createHash('sha256').update(part.text).digest('hex').slice(0, TEXT_HASH_CHARS) });
        break;
      }
      default: {
        const exhaustive: never = part;
        return exhaustive;
      }
    }
  }
  flush();
  const all = [...blocks, ...trailing, ...attachmentBlocks];
  assert(
    all.length <= parts.length + content.attachments.length + AI_LIMITS.promptBlocksExtraMax,
    'buildPrompt: blocks stay within the parts, attachments and the extras',
  );
  assert(sent.length === parts.length, 'buildPrompt: one sent part per part');
  return ok({ blocks: all, sent });
}

/** True when `file` is strictly inside `root`. */
export function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

// The text of a prompt with attachments: each image inline, each project file as a link the agent reads itself.
function attachmentBlocksOf(root: string, attachments: readonly PromptAttachment[]): unknown[] {
  const blocks: unknown[] = [];
  for (const attachment of attachments) {
    if (attachment.kind === 'image') {
      blocks.push({ type: 'image', mimeType: attachment.mimeType, data: attachment.data });
    } else {
      const file = path.resolve(root, attachment.path);
      if (inside(root, file) && fs.existsSync(file)) {
        blocks.push({ type: 'resource_link', name: path.basename(file), uri: pathToFileURL(file).href });
      }
    }
  }
  assert(blocks.length <= attachments.length, 'attachmentBlocksOf: never more blocks than attachments');
  return blocks;
}

interface FileReference {
  readonly block: unknown | undefined;
  readonly sent: SentPart;
  /** Characters embedded by this file, to count against the prompt's total. */
  readonly embeddedChars: number;
}

// One mentioned file: embedded when it is text that fits, else linked. A file that does not exist is only named.
function fileReference(source: PromptSource, file: string, relative: string, embeddedSoFar: number): FileReference {
  let text: string | undefined;
  let readable = true;
  try {
    text = source.read(file);
  } catch {
    readable = false; // Binary, or past the file bound: the agent may still open it itself.
  }
  const uri = pathToFileURL(file).href;
  if (text === undefined && readable) {
    return { block: undefined, sent: { kind: 'file', path: relative, truncated: false, excerpt: undefined }, embeddedChars: 0 };
  }
  if (
    text !== undefined &&
    source.embeddedContext &&
    text.length <= AI_LIMITS.mentionFileCharsMax &&
    embeddedSoFar + text.length <= AI_LIMITS.mentionTotalCharsMax
  ) {
    return {
      block: { type: 'resource', resource: { uri, mimeType: 'text/plain', text } },
      sent: { kind: 'file', path: relative, truncated: false, excerpt: text.slice(0, AI_LIMITS.mentionPreviewCharsMax) },
      embeddedChars: text.length,
    };
  }
  return {
    block: { type: 'resource_link', name: path.basename(file), uri },
    sent: { kind: 'file', path: relative, truncated: true, excerpt: text?.slice(0, AI_LIMITS.mentionPreviewCharsMax) },
    embeddedChars: 0,
  };
}

// A link to the skill's SKILL.md, when it is where its source says and exists. A project skill lives in the
// project; a user skill is `~/`-relative and lives under the person's home. Nothing else is linked.
function skillLink(source: PromptSource, part: Extract<PromptPart, { readonly kind: 'skill' }>): unknown | undefined {
  if (path.posix.basename(part.path) !== 'SKILL.md') {
    return undefined;
  }
  let file: string | undefined;
  if (part.source === 'user') {
    file = part.path.startsWith('~/') && isProjectRelativePath(part.path.slice(2)) ? resolveInside(source.home, part.path.slice(2)) : undefined;
  } else {
    file = isProjectRelativePath(part.path) ? resolveInside(source.root, part.path) : undefined;
  }
  if (file === undefined || !fs.existsSync(file)) {
    return undefined;
  }
  return { type: 'resource_link', name: 'SKILL.md', uri: pathToFileURL(file).href };
}

// The absolute path of `relative` under `base`, only when both its text and, if it exists, its real path stay inside
// `base`: a link inside the project that points elsewhere must not carry a file out.
function resolveInside(base: string, relative: string): string | undefined {
  if (!isProjectRelativePath(relative)) {
    return undefined;
  }
  const file = path.resolve(base, relative);
  if (!inside(base, file)) {
    return undefined;
  }
  try {
    return inside(fs.realpathSync(base), fs.realpathSync(file)) ? file : undefined;
  } catch {
    return file; // Not on disk: lexically inside is all there is to check, and nothing will be read.
  }
}

function invalid(message: string): AiFailure {
  return { code: 'invalid', message };
}
