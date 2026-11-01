// Inherited chips are a visual hint beside the editable field, never content
// inside it. Token serialization therefore cannot turn inheritance into a write.
import { tokenGlyph, type Chip } from './TokenField';

type HintPart = { readonly kind: 'text'; readonly text: string } | { readonly kind: 'chip'; readonly chip: Chip };

export default function VariableHint({
  value,
  chips,
  className,
  disabled,
  onPick,
}: {
  readonly value: string;
  readonly chips: readonly Chip[];
  readonly className: string;
  readonly disabled: boolean;
  readonly onPick: () => void;
}) {
  return (
    <span className={`${className} embed-editor_varconnect-hint`}>
      {hintParts(value, chips).map((part, index) =>
        part.kind === 'text' ? (
          part.text
        ) : (
          <button
            key={index}
            type="button"
            className="embed-editor_varconnect-token"
            title={`Inherited: ${part.chip.text}`}
            aria-label={`Inherited ${part.chip.name}: choose variable`}
            disabled={disabled}
            onMouseDown={(event) => event.preventDefault()}
            onClick={onPick}
          >
            <span
              className="embed-editor_varconnect-token-icon"
              // Glyphs are fixed application markup; names and expressions remain React text.
              dangerouslySetInnerHTML={{ __html: tokenGlyph(part.chip.type) }}
            />
            <span className="embed-editor_varconnect-token-name">{part.chip.name}</span>
          </button>
        ),
      )}
    </span>
  );
}

function hintParts(value: string, chips: readonly Chip[]): readonly HintPart[] {
  const parts: HintPart[] = [];
  let offset = 0;
  // Each catalog chip accounts for one substring, so the output is bounded by
  // twice the input chip count plus its trailing text.
  for (const chip of chips) {
    const start = value.indexOf(chip.text, offset);
    if (start < 0) {
      continue;
    }
    parts.push({ kind: 'text', text: value.slice(offset, start) }, { kind: 'chip', chip });
    offset = start + chip.text.length;
  }
  parts.push({ kind: 'text', text: value.slice(offset) });
  return parts;
}
