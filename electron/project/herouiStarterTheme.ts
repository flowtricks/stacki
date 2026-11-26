import { darkVariables, lightVariables, motionUtilities, sharedVariables, vibrantPaletteVariables } from './herouiStarterThemeInventory';

export const HEROUI_THEME_FILE = 'src/styles/theme.css';

const typography = {
  '--font-sans': 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  '--font-mono': 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
} as const;

// These are the documented component overrides. Keep them on the component
// because a global value would also change instances outside the intended scope.
// Skeleton and Tooltip inherit the shared defaults and can override them locally.
export const componentVariables = {
  '.avatar-group': { '--avatar-group-overlap': '0.5rem', '--avatar-group-seam': '2px' },
  '.switch__control': { '--switch-control-bg-checked': 'var(--accent)', '--switch-control-bg-checked-hover': 'var(--accent-hover)' },
  '.skeleton': { '--skeleton-animation': 'shimmer' },
  'html or a tooltip trigger': { '--tooltip-delay': '1500ms', '--tooltip-close-delay': '500ms' },
} as const;

export function heroUIThemeCSS(): string {
  const motionSettings = Object.fromEntries(Object.entries(motionUtilities).map(([name, value]) => [motionProperty(name), value]));
  const motionMapping = Object.fromEntries(Object.keys(motionUtilities).map((name) => [name, `var(${motionProperty(name)})`]));
  // The matching mode rule runs on the same element as the shared rule, so
  // aliases in the shared rule resolve to the current mode's source values.
  return `/* HeroUI 3.2.8 theme. Edit these values in Stacki's Variables panel or in this file. */

:root {
  /* Shared settings. */
${declarations(sharedVariables)}

  /* Typography. Used by the layout and Tailwind font utilities. */
${declarations(typography)}

  /* Motion. */
${declarations(motionSettings)}
}

:root[data-theme="light"] {
  color-scheme: light;
${declarations(lightVariables)}
}

:root[data-theme="dark"] {
  color-scheme: dark;
${declarations(darkVariables)}
}

/* Add data-vibrant-palette="true" to a section to use the saturated soft colors. */
[data-vibrant-palette="true"] {
${declarations(vibrantPaletteVariables)}
}

/* Keep the utility names used by HeroUI linked to the editable motion settings. */
@theme inline {
${declarations(motionMapping)}
}

/* The motion settings reference these names at runtime, outside Tailwind's keyframe pruning. */
@keyframes spin {
  to { transform: rotate(360deg); }
}

@keyframes skeleton {
  to { transform: translateX(calc(var(--skeleton-shimmer-direction, 1) * 200%)); }
}

@keyframes caret-blink {
  0%, 70%, 100% { opacity: 1; }
  20%, 50% { opacity: 0; }
}
`;
}

function motionProperty(utility: string): string {
  return `--motion-${utility.slice(2)}`;
}

function declarations(variables: Readonly<Record<string, string>>): string {
  return Object.entries(variables)
    .map(([name, value]) => `  ${name}: ${value};`)
    .join('\n');
}
