// A sent message as it is read again: its text and chips in the order they were typed (from the parts the
// transcript keeps, chatModel.ts `SentPart`), and the three things made from them: the draft that Edit and Resend
// put back, the plain text Copy gives, and the words a chat's title is made from.
//
// A chip's readable text is what a person would write, never the compact reference the agent gets (an element's
// reference holds its place in the tree, which means nothing to a reader). Messages stored before a chip kind was
// kept hold that chip as words inside a text part; they read as those words, as they did.
import { assert } from '../../core/assert';
import { AI_LIMITS } from './aiLimits';
import type { SentPart } from './chatModel';
import {
  BUILTIN_CHIP_TITLES,
  codeReadableText,
  fencedCode,
  fenceLanguage,
  joinReadable,
  linesText,
  pageReadableText,
  type ComponentMemberChip,
  type ComposerSegment,
  type ComposerSegments,
  type MentionChip,
  type ReadablePiece,
} from './mentions';

/** The chip a stored part stands for, or undefined for text and for comment pins (drawn whole, never as a chip). */
export function chipOfSentPart(part: SentPart): MentionChip | undefined {
  switch (part.kind) {
    case 'text':
    case 'pins':
      return undefined;
    case 'file':
      return { kind: 'file', path: part.path, name: baseNameOf(part.path) };
    case 'skill':
      return { kind: 'skill', name: part.name, source: part.source, path: part.path };
    case 'builtin':
      return { kind: 'builtin', id: part.id, title: BUILTIN_CHIP_TITLES[part.id] };
    case 'chip':
      return part.chip;
    default: {
      const exhaustive: never = part;
      return exhaustive;
    }
  }
}

/** The draft a sent message was: what Edit puts back in the box and what Resend and Retry send. */
export function segmentsOfSent(text: string, parts: readonly SentPart[] | undefined): ComposerSegments {
  if (parts === undefined || !parts.some((part) => chipOfSentPart(part) !== undefined)) {
    return text === '' ? [] : [{ kind: 'text', text }];
  }
  const segments: ComposerSegment[] = [];
  for (const part of parts) {
    if (part.kind === 'text') {
      segments.push({ kind: 'text', text: part.text });
      continue;
    }
    const chip = chipOfSentPart(part);
    if (chip !== undefined) {
      segments.push({ kind: 'chip', chip });
    }
  }
  assert(segments.length <= parts.length, 'segmentsOfSent: at most one segment per part');
  return segments;
}

/** A chip as a person reads it. */
export function chipReadableText(chip: MentionChip): string {
  assert(chip.kind.length > 0, 'chipReadableText: a chip has a kind');
  switch (chip.kind) {
    case 'file':
      return `@${chip.path}`;
    case 'skill':
      return `/${chip.name}`;
    case 'builtin':
      return chip.title;
    case 'component':
      return `${chip.name} (${chip.path})`;
    case 'element':
      return `<${chip.tag}> (${chip.path})`;
    case 'member':
      return memberReadableText(chip);
    case 'css':
      return chip.target === 'variable' ? chip.name : `.${chip.name}`;
    case 'asset':
      return chip.path;
    case 'code':
      return codeReadableText(chip);
    case 'page':
      return pageReadableText(chip);
    default: {
      const exhaustive: never = chip;
      return exhaustive;
    }
  }
}

function memberReadableText(chip: ComponentMemberChip): string {
  assert(chip.name.length > 0, 'memberReadableText: a member is named');
  if (chip.role === 'text') {
    return JSON.stringify(chip.value);
  }
  if (chip.role === 'slot') {
    // i18n-ignore: part of a message's plain text.
    return `${chip.name} slot`;
  }
  return chip.value === undefined ? chip.name : `${chip.name}="${chip.value}"`;
}

/** A sent message as plain text, each chip written out where it stood; code under a line that says where it is from. */
export function sentReadableText(text: string, parts: readonly SentPart[] | undefined): string {
  const segments = segmentsOfSent(text, parts);
  assert(segments.length <= AI_LIMITS.composerSegmentsMax, 'sentReadableText: a message is bounded');
  return joinReadable(
    segments.map((segment): ReadablePiece =>
      segment.kind === 'text' ? { text: segment.text, block: false } : { text: chipReadableText(segment.chip), block: segment.chip.kind === 'code' },
    ),
  );
}

/** The same message as Markdown (the chat export): code in fenced blocks nothing inside can close. */
export function sentMarkdownText(text: string, parts: readonly SentPart[] | undefined): string {
  return joinReadable(
    segmentsOfSent(text, parts).map((segment): ReadablePiece => {
      if (segment.kind === 'text') {
        return { text: segment.text, block: false };
      }
      const chip = segment.chip;
      return chip.kind === 'code'
        ? { text: `${chip.path}, ${linesText(chip)}\n\n${fencedCode(chip.code, fenceLanguage(chip.path))}`, block: true }
        : { text: chipReadableText(chip), block: false };
    }),
  );
}

/** The words of a message without its chips' contents: its text, and each short chip's name. Code and places are left out. */
export function sentTypedText(segments: ComposerSegments): string {
  assert(segments.length <= AI_LIMITS.composerSegmentsMax, 'sentTypedText: a message is bounded');
  return segments
    .map((segment) => {
      if (segment.kind === 'text') {
        return segment.text;
      }
      return segment.chip.kind === 'code' || segment.chip.kind === 'page' ? '' : chipReadableText(segment.chip);
    })
    .join('');
}

function baseNameOf(path: string): string {
  assert(path.length > 0, 'baseNameOf: a file is named');
  return path.slice(path.lastIndexOf('/') + 1);
}
