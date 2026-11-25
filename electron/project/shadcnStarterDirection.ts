import type { ShadcnBase } from '../../shared/ipc/shadcnStarter';

export const SHADCN_DIRECTION_STORAGE_PREFIX = 'shadcn-starter-direction:';
const DIRECTION_CHANGE_EVENT = 'shadcn-preview-direction';

// Restore direction in the head so CSS and portals inherit it before hydration.
// This runs only in previews whose root declares a scoped storage key.
export const SHADCN_DIRECTION_BOOTSTRAP = `
      const directionKey = root.dataset.previewDirectionKey;
      if (directionKey !== undefined) {
        const restoreDirection = () => {
          try {
            const direction = localStorage.getItem(directionKey) === "rtl" ? "rtl" : "ltr";
            if (root.dir !== direction) {
              root.dir = direction;
              window.dispatchEvent(new Event("${DIRECTION_CHANGE_EVENT}"));
            }
          } catch {
            // Keep the current direction if the browser blocks storage.
          }
        };
        restoreDirection();
        window.addEventListener("pageshow", (event) => {
          if (event.persisted) {
            restoreDirection();
          }
        });
        window.addEventListener("storage", (event) => {
          if (event.key === directionKey || event.key === null) {
            restoreDirection();
          }
        });
      }
`;

export function shadcnPreviewDirection(base: ShadcnBase): string {
  return `import { useSyncExternalStore, type ReactNode } from "react";
import { DirectionProvider } from "../ui/direction";

type Direction = "ltr" | "rtl";
const changeEvent = "${DIRECTION_CHANGE_EVENT}";

// Astro hydrates each example in its own React root. The document keeps them
// in sync and gives DOM outside the islands, including portals, the same direction.
export function usePreviewDirection(): Direction {
  return useSyncExternalStore(subscribe, readDirection, serverDirection);
}

export function PreviewDirectionProvider({ children }: { readonly children: ReactNode }) {
  const direction = usePreviewDirection();
  return <DirectionProvider ${directionProps(base)}>{children}</DirectionProvider>;
}

export function selectPreviewDirection(input: unknown) {
  if (input !== "ltr" && input !== "rtl") {
    return;
  }
  const root = document.documentElement;
  const key = root.dataset.previewDirectionKey;
  if (key === undefined || root.dir === input) {
    return;
  }
  root.dir = input;
  try {
    localStorage.setItem(key, input);
  } catch {
    // Direction can still change for this page.
  }
  window.dispatchEvent(new Event(changeEvent));
}

function readDirection(): Direction {
  return document.documentElement.dir === "rtl" ? "rtl" : "ltr";
}

function serverDirection(): Direction {
  return "ltr";
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(changeEvent, onChange);
  return () => window.removeEventListener(changeEvent, onChange);
}
`;
}

function directionProps(base: ShadcnBase): string {
  switch (base) {
    case 'base':
      return 'direction={direction}';
    case 'radix':
      return 'dir={direction}';
    case 'aria':
      // React Aria reads direction from the locale's script. Keep its labels in English.
      return 'locale={direction === "rtl" ? "en-Arab" : "en"}';
  }
}
