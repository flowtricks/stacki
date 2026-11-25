// The line of a sent message when it had mentions: its text and each chip, in order. The chips are
// the same purple pills the composer draws (MentionChipView), so a message looks as it did when typed.
// A message with no mention (or an old one stored without parts) returns undefined and is drawn as its plain text.
import type { ReactNode } from 'react';
import type { SentPart } from '../../../../shared/properties/ai/chatModel';
import { MentionChipView } from '../mentions/MentionChipView';

export function sentPartsView(parts: readonly SentPart[] | undefined): ReactNode | undefined {
  if (parts === undefined || !parts.some((part) => part.kind !== 'text')) {
    return undefined;
  }
  return parts.map((part, index) => {
    switch (part.kind) {
      case 'text':
        return part.text;
      case 'file':
        return <MentionChipView key={index} chip={{ kind: 'file', path: part.path }} />;
      case 'skill':
        return <MentionChipView key={index} chip={{ kind: 'skill', name: part.name, path: part.path }} />;
      case 'builtin':
        return <MentionChipView key={index} chip={{ kind: 'builtin', id: part.id }} />;
      default: {
        const exhaustive: never = part;
        return exhaustive;
      }
    }
  });
}
