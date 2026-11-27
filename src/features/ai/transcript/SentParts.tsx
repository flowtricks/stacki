// The line of a sent message when it had mentions: its text and each chip, in order. The chips are the same pills
// the composer draws (MentionChipView), each with the card of its value, so a message looks as it did when typed,
// in a reopened chat too: everything drawn comes from the parts the transcript stored.
// A message with no chip (or an old one stored without parts) returns undefined and is drawn as its plain text.
import { Fragment, type ReactNode } from 'react';
import type { SentPart } from '../../../../shared/properties/ai/chatModel';
import { chipOfSentPart } from '../../../../shared/properties/ai/sentMessage';
import { MentionChipView } from '../mentions/MentionChipView';

export function sentPartsView(parts: readonly SentPart[] | undefined): ReactNode | undefined {
  if (parts === undefined || !parts.some((part) => chipOfSentPart(part) !== undefined)) {
    return undefined;
  }
  return parts.map((part, index) => {
    if (part.kind === 'text') {
      return <Fragment key={index}>{part.text}</Fragment>;
    }
    // A message of comment pins is drawn whole by PinsMessage (pins/PinsMessage.tsx), never as a chip.
    const chip = chipOfSentPart(part);
    return chip === undefined ? undefined : <MentionChipView key={index} chip={chip} excerpt={part.kind === 'file' ? part.excerpt : undefined} />;
  });
}
