import type { ShadcnBase } from '../../shared/ipc/shadcnStarter';

const STORAGE_KEY = 'shadcn-starter-theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

// The inline script and React island use the same key and query. The script
// applies the saved theme before first paint, then the island owns changes.
export const SHADCN_THEME_BOOTSTRAP = `
      let theme = "system";
      try {
        const saved = localStorage.getItem("${STORAGE_KEY}");
        if (saved === "light" || saved === "dark") {
          theme = saved;
        }
      } catch {
        // A blocked storage API still allows system and in-page theme changes.
      }
      const root = document.documentElement;
      root.dataset.previewTheme = theme;
      root.classList.toggle("dark", theme === "dark" || (theme === "system" && matchMedia("${DARK_QUERY}").matches));
`;

export function shadcnThemePicker(base: ShadcnBase, { rtl }: { readonly rtl: boolean }): string {
  const itemKey = base === 'aria' ? 'id' : 'value';
  const directionGroup = rtl ? shadcnDirectionGroup(base, itemKey) : '';
  return `import { useSyncExternalStore } from "react";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";
import { PreviewDirectionProvider${rtl ? ', selectPreviewDirection, usePreviewDirection' : ''} } from "./PreviewDirection";

const choices = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
] as const;

type Theme = (typeof choices)[number]["value"];

const storageKey = "${STORAGE_KEY}";
const darkQuery = "${DARK_QUERY}";
const changeEvent = "shadcn-preview-theme";

export function ThemePicker() {
  const theme = useSyncExternalStore(subscribe, readTheme, serverTheme);
${rtl ? '  const direction = usePreviewDirection();\n' : ''}  return (
    <PreviewDirectionProvider>
      <div className="flex flex-wrap items-center gap-2">
        <ToggleGroup
          ${shadcnSingleSelection(base, 'theme', 'selectTheme')}
          aria-label="Color theme"
          orientation="horizontal"
          variant="outline"
          size="sm"
          spacing={0}
        >
          {choices.map(({ value, label }) => (
            <ToggleGroupItem key={value} ${itemKey}={value}>{label}</ToggleGroupItem>
          ))}
        </ToggleGroup>${directionGroup}
      </div>
    </PreviewDirectionProvider>
  );
}

function serverTheme(): Theme {
  return "system";
}

function readTheme(): Theme {
  return parseTheme(document.documentElement.dataset.previewTheme) ?? "system";
}

function parseTheme(input: unknown): Theme | undefined {
  return choices.find(({ value }) => input === value)?.value;
}

function selectTheme(input: unknown) {
  const theme = parseTheme(input);
  // Base UI and Radix can emit an empty selection when the current item is pressed.
  if (theme === undefined) {
    return;
  }
  applyTheme(theme, matchMedia(darkQuery).matches);
  try {
    localStorage.setItem(storageKey, theme);
  } catch {
    // The applied theme still works for this page.
  }
  window.dispatchEvent(new Event(changeEvent));
}

function applyTheme(theme: Theme, systemDark: boolean) {
  const root = document.documentElement;
  root.dataset.previewTheme = theme;
  root.classList.toggle("dark", theme === "dark" || (theme === "system" && systemDark));
}

function subscribe(onChange: () => void): () => void {
  const system = matchMedia(darkQuery);
  const refreshSystem = () => applyTheme(readTheme(), system.matches);
  const refreshStoredTheme = () => {
    let theme = readTheme();
    try {
      theme = parseTheme(localStorage.getItem(storageKey)) ?? "system";
    } catch {
      // History restoration still updates the system preference.
    }
    applyTheme(theme, system.matches);
    onChange();
  };
  const storageChanged = (event: StorageEvent) => {
    if (event.key === storageKey || event.key === null) {
      refreshStoredTheme();
    }
  };
  refreshSystem();
  system.addEventListener("change", refreshSystem);
  window.addEventListener(changeEvent, onChange);
  window.addEventListener("pageshow", refreshStoredTheme);
  window.addEventListener("storage", storageChanged);
  return () => {
    system.removeEventListener("change", refreshSystem);
    window.removeEventListener(changeEvent, onChange);
    window.removeEventListener("pageshow", refreshStoredTheme);
    window.removeEventListener("storage", storageChanged);
  };
}
`;
}

function shadcnDirectionGroup(base: ShadcnBase, itemKey: 'id' | 'value'): string {
  return `
        <ToggleGroup
          ${shadcnSingleSelection(base, 'direction', 'selectPreviewDirection')}
          aria-label="Text direction"
          orientation="horizontal"
          variant="outline"
          size="sm"
          spacing={0}
        >
          <ToggleGroupItem ${itemKey}="ltr">LTR</ToggleGroupItem>
          <ToggleGroupItem ${itemKey}="rtl">RTL</ToggleGroupItem>
        </ToggleGroup>`;
}

function shadcnSingleSelection(base: ShadcnBase, selected: string, select: string): string {
  switch (base) {
    case 'base':
      return `value={[${selected}]} multiple={false} onValueChange={(value) => ${select}(value[0])}`;
    case 'aria':
      return `selectionMode="single" disallowEmptySelection selectedKeys={[${selected}]} onSelectionChange={(keys) => ${select}(keys.values().next().value)}`;
    case 'radix':
      return `type="single" value={${selected}} onValueChange={${select}}`;
  }
}
