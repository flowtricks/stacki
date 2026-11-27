// Words with chips as they read once written: the text, and each chip drawn as the composer draws it (the same
// label, colour and icon, with the card of its value), for places that show words rather than edit them: a comment
// pin's box once sent, its row in the list, its card in the transcript and a queued message. A click on a chip is
// the click of whatever the words sit in (a button that does something with the whole of them).
import { Fragment } from 'react';
import type { ComposerSegments } from '../../../../shared/properties/ai/mentions';
import { MentionChipView, type MentionChipViewProps } from './MentionChipView';

export function ChipWords({ segments, focus = 'none' }: { readonly segments: ComposerSegments; readonly focus?: MentionChipViewProps['focus'] }) {
  return segments.map((segment, index) =>
    segment.kind === 'text' ? <Fragment key={index}>{segment.text}</Fragment> : <MentionChipView key={index} chip={segment.chip} focus={focus} />,
  );
}
