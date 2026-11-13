import { useId, useState } from 'react';
import './infoLabel.css';
import { useTranslate } from '../lib/i18n/useTranslate';

export function InfoLabel({ label, description }: { readonly label: string; readonly description: string }) {
  const translate = useTranslate();
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <span className="info-label" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <span>{label}</span>
      <button
        type="button"
        className="info-label-trigger"
        aria-label={translate('ui.infoLabel.about', { label })}
        aria-describedby={id}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={() => setOpen(true)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && open) {
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
          }
        }}
      >
        i
      </button>
      <span id={id} role="tooltip" className="info-label-tip" hidden={!open}>
        {description}
      </span>
    </span>
  );
}
