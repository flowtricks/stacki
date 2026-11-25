// A QR code as an SVG, drawn from the local encoder (src/lib/qr/qrEncode.ts): no image request, no network.
//
// The tile is light and the modules dark in both themes, with the standard's four-module quiet zone on
// every side. A camera reads dark-on-light; the inverted code a dark theme would suggest is one many
// phone scanners reject, so the tile keeps its own colours (phonePreview.css --phone-qr-*).
import { useMemo } from 'react';
import { assert } from '../../../../shared/core/assert';
import { QR_LIMITS, encodeQr, qrModuleDark, type QrCode } from '../../../lib/qr/qrEncode';

/** The rendered side of the tile, in CSS pixels (13rem): the popover's whole content width, so the code fills the popover with no empty bands, and big enough for a phone held at arm's length. */
export const QR_TILE_PX = 208;

/** The tile for `text`, or nothing when the text is longer than a code holds (the address is still shown beside it). */
export function QrCodeImage({ text, label }: { readonly text: string; readonly label: string }) {
  const code = useMemo(() => encodeQr(text), [text]);
  if (code === undefined) {
    return undefined;
  }
  const side = code.size + QR_LIMITS.quietZoneModules * 2;
  return (
    <svg
      className="phone-preview-qr"
      role="img"
      aria-label={label}
      width={QR_TILE_PX}
      height={QR_TILE_PX}
      viewBox={`0 0 ${side} ${side}`}
      shapeRendering="crispEdges"
      data-modules={code.size}
    >
      <rect className="phone-preview-qr-tile" width={side} height={side} />
      <path className="phone-preview-qr-modules" d={qrPath(code)} />
    </svg>
  );
}

/** One square per dark module, offset by the quiet zone: `M x y h1 v1 h-1 z` each. */
export function qrPath(code: QrCode): string {
  const parts: string[] = [];
  const offset = QR_LIMITS.quietZoneModules;
  for (let y = 0; y < code.size; y++) {
    for (let x = 0; x < code.size; x++) {
      if (qrModuleDark(code, x, y)) {
        parts.push(`M${x + offset} ${y + offset}h1v1h-1z`);
      }
    }
  }
  assert(parts.length > 0, 'qrPath: a code has dark modules');
  assert(parts.length < code.size * code.size, 'qrPath: a code has light modules');
  return parts.join('');
}
