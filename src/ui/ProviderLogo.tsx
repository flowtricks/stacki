// A provider's mark in a square tile: the vendored brand mark when there is one (providerLogos.tsx)
// or the caller passes one, else the provider's initial on a tint chosen from its name, so the same provider
// always looks the same and two providers rarely look alike. The tile is decorative: the name beside it is
// the accessible text.
import type { CSSProperties, ReactNode } from 'react';
import { assert } from '../../shared/core/assert';
import { markFill, providerMark } from './providerLogos';
import './providerLogo.css';

/** A letter and a hue for a provider with no licensed logo: the same name always draws the same tile. */
export function monogramOf(name: string): { readonly letter: string; readonly hue: number } {
  const trimmed = name.trim();
  const letter = trimmed.length === 0 ? '?' : (Array.from(trimmed)[0] ?? '?').toUpperCase();
  let hash = 7;
  for (const character of trimmed.toLowerCase()) {
    hash = (hash * 31 + (character.codePointAt(0) ?? 0)) % 360;
  }
  assert(hash >= 0, 'A hue is not negative');
  assert(hash < 360, 'A hue is a degree');
  return { letter, hue: hash };
}

export default function ProviderLogo({
  id,
  name,
  size = 28,
  logo,
}: {
  readonly id?: string | undefined;
  readonly name: string;
  readonly size?: number;
  /** A mark to draw instead of the monogram. */
  readonly logo?: ReactNode;
}) {
  const brand = providerMark(id);
  const mark: ReactNode =
    logo ??
    (brand === undefined ? undefined : (
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill={markFill(brand.hex)}>
        <path d={brand.path} />
      </svg>
    ));
  const { letter, hue } = monogramOf(name);
  const style: CSSProperties & Record<'--provider-hue', number> = { width: size, height: size, fontSize: Math.floor(size * 0.46), '--provider-hue': hue };
  return (
    <span className={`provider-logo${mark === undefined ? ' monogram' : ''}`} style={style} aria-hidden="true">
      {mark ?? letter}
    </span>
  );
}
