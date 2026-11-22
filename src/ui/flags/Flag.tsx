// One country flag as an inline svg, round. Decorative: the language's name beside it is the label, so it is hidden from assistive technology.
// The round clip is `border-radius` on the svg (`.ui-flag`), not a mask inside it, so many flags can share one document.
import type { FlagCountry } from '../../../shared/core/i18n/locales';
import { FLAG_SHAPES, FLAG_VIEW_BOX } from './flagPaths';

/** True when the vendored set holds the flag; the type already says so, this guards a value that crossed a boundary as a plain string. */
export function hasFlag(country: string): country is FlagCountry {
  return Object.hasOwn(FLAG_SHAPES, country);
}

export function Flag(props: { readonly country: FlagCountry; readonly size?: number }) {
  const size = props.size ?? 16;
  const shapes = FLAG_SHAPES[props.country];
  return (
    <svg className="ui-flag" width={size} height={size} viewBox={FLAG_VIEW_BOX} aria-hidden="true" focusable="false" data-flag={props.country}>
      {shapes.map((shape, index) =>
        shape.kind === 'path' ? (
          <path key={index} fill={shape.fill} d={shape.d} />
        ) : (
          <circle key={index} fill={shape.fill} cx={shape.cx} cy={shape.cy} r={shape.r} />
        ),
      )}
    </svg>
  );
}
