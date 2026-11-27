// The icon of a project row in the `@` picker (projectMentions.ts): one per group from the central icon
// set, a colour swatch for a colour variable, and for an image the Assets panel's own small copy
// (assetThumbnails.ts) in a tiny rounded box. The small copy is asked for only once the row is on screen
// (an IntersectionObserver says so), and until it is ready, or where it cannot be made, the image icon
// stands in: the picker never loads a full-size original.
import { useEffect, useRef, useState } from 'react';
import { sourceCandidates } from '../../../ui/AssetThumb';
import { useThumbnail } from '../../../ui/assetThumbnails';
import { FileTypeIcon } from '../../../ui/ElementIcons';
import { AssetManagerIcon, LayoutIcon, PagePanelIcon } from '../../../ui/Icons';
import type { MentionChip } from '../../../../shared/properties/ai/mentions';
import { CHIP_STYLE_ICONS, chipFilePath, chipStyleOf, type RowLook } from './mentionChips';
import './mentions.css';

const ICON_PX = 16;

/** A chip's own icon: a whole file wears its type's, anything else its look's (mentionChips.ts). */
export function ChipIcon({ chip, size }: { readonly chip: MentionChip; readonly size: number }) {
  const path = chipFilePath(chip);
  if (path !== undefined) {
    return <FileTypeIcon name={path} size={size} />;
  }
  const Icon = CHIP_STYLE_ICONS[chipStyleOf(chip)];
  return <Icon size={size} />;
}

export function MentionRowIcon({ look, chip }: { readonly look: RowLook; readonly chip: MentionChip }) {
  switch (look.kind) {
    case 'page':
      return <PagePanelIcon size={ICON_PX} />;
    case 'layout':
      return <LayoutIcon size={ICON_PX} />;
    case 'class': {
      const Icon = CHIP_STYLE_ICONS.class;
      return <Icon size={ICON_PX} />;
    }
    case 'video':
    case 'font':
      return <ChipIcon chip={chip} size={ICON_PX} />;
    case 'variable':
      return look.color === undefined ? (
        <VariableSwatchesIcon />
      ) : (
        <span className="mention-row-swatch" style={{ background: look.color }} aria-hidden="true" />
      );
    case 'image':
      return <ImageThumb abs={look.abs} thumbnailKey={look.key} />;
    default: {
      const exhaustive: never = look;
      return exhaustive;
    }
  }
}

function ImageThumb({ abs, thumbnailKey }: { readonly abs: string; readonly thumbnailKey: string }) {
  const box = useRef<HTMLSpanElement>(null);
  const [onScreen, setOnScreen] = useState(false);
  useEffect(() => {
    const element = box.current;
    // Without an observer (a test, an old engine) nothing is known to be on screen, so nothing is read.
    if (element === null || typeof IntersectionObserver !== 'function') {
      return undefined;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setOnScreen(true);
        observer.disconnect();
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const thumbnail = useThumbnail(thumbnailKey, onScreen ? sourceCandidates(abs)[0] : undefined, { wanted: onScreen });
  return (
    <span ref={box} className="mention-row-thumb" aria-hidden="true">
      {thumbnail.kind === 'ready' ? <img src={thumbnail.url} alt="" draggable={false} /> : <AssetManagerIcon size={ICON_PX} />}
    </span>
  );
}

// A variable with no colour draws the variable chip's own icon (the swatches), from the one table.
function VariableSwatchesIcon() {
  const Icon = CHIP_STYLE_ICONS.variable;
  return <Icon size={ICON_PX} />;
}
