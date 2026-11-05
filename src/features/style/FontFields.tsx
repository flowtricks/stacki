// Font family and weight: the web, Google and project fonts a family can be
// picked from, and the weights a font names (TypographySection.tsx).

import { useEffect, useState } from 'react';
import Select, { type SelectOption } from './components/Select';
import { getProjectFontFamilies } from './model/webflow';
import { displayOf, displayText } from './model/styleDisplay';
import { useStyleHint } from './model/computedStyle';
import { type Props, CUSTOM, PropLabel, LiveInput } from './TypographyKit';

// The Typography section of the style panel. Like the Size section, every control
// is always rendered and driven by the resolved model: a property is blue when the
// picked selector sets it, orange when another selector does (click the label for
// provenance), or empty when unset. Text fields update the CSS live as you type and
// commit authoritatively on blur. All writes target the picked selector.

// ─────────────────────────── Font family ───────────────────────────

// Webflow's built-in web fonts — real project fonts, so picking one applies natively
// (an arbitrary web-safe name Webflow doesn't stock would be dropped on the native write).
export const WEB_FONTS = ['Arial', 'Georgia', 'Impact', 'Palatino Linotype', 'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana', 'system-ui'];

// Webflow's Google fonts.
export const GOOGLE_FONTS = [
  'Bitter',
  'Changa One',
  'Droid Sans',
  'Droid Serif',
  'Exo',
  'Great Vibes',
  'Inconsolata',
  'Lato',
  'Merriweather',
  'Montserrat',
  'Open Sans',
  'Oswald',
  'PT Sans',
  'PT Serif',
  'Ubuntu',
  'Varela',
  'Varela Round',
  'Vollkorn',
];

// The primary family of a font-family value (first list entry, unquoted, lowered) —
// used to match a CSS value like `"General Sans", sans-serif` back to a menu option.
export function primaryFamily(value: string): string {
  const first = value.split(',')[0] ?? value;
  return first
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .toLowerCase();
}
// Quote a family name that needs it (spaces / non-identifier chars) when writing.
export function quoteFamily(name: string): string {
  return /^[a-zA-Z_-][a-zA-Z0-9_-]*$/.test(name) ? name : `"${name}"`;
}

export function FontFamilyField(props: Props) {
  const { read, busy, setProp, clearProp, liveSetProp, onProvenance, onSelectSelector } = props;
  const display = displayOf(read('font-family'));
  const [forceCustom, setForceCustom] = useState(false);
  const { options, byPrimary } = fontOptions(useProjectFonts());
  const computed = useStyleHint(display.present ? '' : 'font-family');
  const current = display.present ? display.value : computed;
  const matched = current ? byPrimary.get(primaryFamily(current)) : undefined;
  // A flagged value opens the custom field, whose text shows `!important` —
  // the convention every preset control in the panel follows.
  const customMode = forceCustom || (current.length > 0 && !matched) || display.important;

  const pick = (value: string) => {
    if (value === CUSTOM) {
      setForceCustom(true);
      return;
    }
    setForceCustom(false);
    if (!value) {
      clearProp('font-family');
      return;
    }
    setProp('font-family', quoteFamily(value), false);
  };
  const clear = () => {
    setForceCustom(false);
    clearProp('font-family');
  };

  return (
    <div className="embed-editor_size-row">
      <PropLabel
        label="Font"
        prop="font-family"
        display={display}
        contributors={read('font-family')?.contributors ?? []}
        busy={busy}
        onClear={clear}
        onProvenance={onProvenance}
        onSelectSelector={onSelectSelector}
      />
      <Select
        value={customMode ? CUSTOM : (matched ?? '')}
        options={options}
        onChange={pick}
        onPreview={(value) => {
          const previewed = value ?? undefined;
          const font = previewed && previewed !== CUSTOM ? quoteFamily(previewed) : undefined;
          liveSetProp('font-family', font, false);
        }}
        ariaLabel="Font family"
        disabled={busy}
        searchable
        searchPlaceholder="Search fonts…"
        customInput={
          customMode ? (
            <LiveInput
              // Start empty when switching to Custom from a NAMED font (so typing doesn't
              // append onto e.g. "Montserrat" → "Montserratunset"); keep the current value
              // when it's already a custom one being edited.
              value={forceCustom && matched && !display.important ? '' : displayText(display)}
              busy={busy}
              placeholder="font-family"
              ariaLabel="Font family"
              className="u-select-custom-input"
              prop="font-family"
              autoFocus={forceCustom}
              onCommit={(value, important) => setProp('font-family', value, important)}
              onLiveCommit={(value, important) => liveSetProp('font-family', value, important)}
              onClear={clear}
            />
          ) : undefined
        }
      />
    </div>
  );
}

// The project's discovered font families (variables + fonts used on any style),
// empty until they have loaded.
export function useProjectFonts(): string[] {
  const [fonts, setFonts] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    void getProjectFontFamilies().then((list) => {
      if (live) {
        setFonts(list);
      }
    });
    return () => {
      live = false;
    };
  }, []);
  return fonts;
}

// The dropdown's options, grouped under headings, and every named font by its
// primary family. The project's fonts minus the ones already listed under
// Google/Web are what's left: the project's own custom fonts.
export function fontOptions(fonts: string[]) {
  const builtInLower = new Set([...GOOGLE_FONTS, ...WEB_FONTS].map((font) => font.toLowerCase()));
  const customFonts = fonts.filter((font) => !builtInLower.has(font.toLowerCase()));
  const named = [...customFonts, ...GOOGLE_FONTS, ...WEB_FONTS];
  const byPrimary = new Map(named.map((font) => [primaryFamily(font), font]));
  const options: SelectOption<string>[] = [{ value: '', label: 'Default' }];
  const group = (heading: string, list: string[]) => {
    if (!list.length) {
      return;
    }
    options.push({ value: `__head_${heading}`, label: heading, heading: true });
    for (const font of list) {
      options.push({ value: font, label: font, indent: true });
    }
  };
  group('Custom fonts', customFonts);
  group('Google fonts', GOOGLE_FONTS);
  group('Web fonts', WEB_FONTS);
  options.push({ value: CUSTOM, label: 'Custom…' });
  return { options, byPrimary };
}

// ─────────────────────────── Font weight ───────────────────────────

export const WEIGHTS: ReadonlyArray<[string, string]> = [
  ['100', '100 - Thin'],
  ['200', '200 - Extra Light'],
  ['300', '300 - Light'],
  ['400', '400 - Normal'],
  ['500', '500 - Medium'],
  ['600', '600 - Semi Bold'],
  ['700', '700 - Bold'],
  ['800', '800 - Extra Bold'],
  ['900', '900 - Black'],
];
export const WEIGHT_VALUES = new Set(WEIGHTS.map(([weight]) => weight));
export const WEIGHT_OPTIONS: SelectOption<string>[] = [
  { value: '', label: 'Default' },
  ...WEIGHTS.map(([value, label]) => ({ value, label })),
  { value: CUSTOM, label: 'Custom…' },
];
// Map the CSS keywords onto the numeric scale so they select the right option.
export function normalizeWeight(value: string): string {
  const text = value.trim().toLowerCase();
  if (text === 'normal') {
    return '400';
  }
  if (text === 'bold') {
    return '700';
  }
  return text;
}

export function WeightField(props: Props) {
  const { read, busy, setProp, clearProp, liveSetProp, onProvenance, onSelectSelector } = props;
  const display = displayOf(read('font-weight'));
  const [forceCustom, setForceCustom] = useState(false);
  const computed = useStyleHint(display.present ? '' : 'font-weight');
  const normalized = normalizeWeight(display.present ? display.value : computed);
  const matched = WEIGHT_VALUES.has(normalized) ? normalized : undefined;
  // A flagged weight opens the custom field, which shows its `!important`.
  const customMode = forceCustom || (normalized.length > 0 && !matched) || display.important;

  const pick = (value: string) => {
    if (value === CUSTOM) {
      setForceCustom(true);
      return;
    }
    setForceCustom(false);
    if (!value) {
      clearProp('font-weight');
      return;
    }
    setProp('font-weight', value, false);
  };

  return (
    <div className="embed-editor_size-row">
      <PropLabel
        label="Weight"
        prop="font-weight"
        display={display}
        contributors={read('font-weight')?.contributors ?? []}
        busy={busy}
        onClear={() => {
          setForceCustom(false);
          clearProp('font-weight');
        }}
        onProvenance={onProvenance}
        onSelectSelector={onSelectSelector}
      />
      <Select
        value={customMode ? CUSTOM : (matched ?? '')}
        options={WEIGHT_OPTIONS}
        onChange={pick}
        onPreview={(value) => liveSetProp('font-weight', value === CUSTOM ? undefined : (value ?? undefined), false)}
        ariaLabel="Font weight"
        disabled={busy}
        customInput={
          customMode ? (
            <LiveInput
              value={displayText(display)}
              busy={busy}
              placeholder="font-weight"
              ariaLabel="Font weight"
              className="u-select-custom-input"
              prop="font-weight"
              autoFocus={forceCustom}
              onCommit={(value, important) => setProp('font-weight', value, important)}
              onLiveCommit={(value, important) => liveSetProp('font-weight', value, important)}
              onClear={() => {
                setForceCustom(false);
                clearProp('font-weight');
              }}
            />
          ) : undefined
        }
      />
    </div>
  );
}
