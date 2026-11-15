import type { MetadataKind } from '../../../vendor/stacki/shared/properties/projectMetadata';

// Deployment configuration and the embedded CMS are deployed independently of
// the editable Astro draft. Advancing its baseline must not copy these files.
export function independentlyDeployed(file: string): boolean {
  return file.startsWith('studio/') || /^wrangler\.(jsonc?|toml)$/.test(file);
}

/**
 * Whether a GitHub sync may write each `.stacki` metadata file into a running
 * workspace. `live`: plain data the Studio server reads from disk on every use
 * (settings/projectMetadata.ts readMetadataSource), so a pulled change applies
 * at once. `restart`: read once when the container starts, so a pulled change would
 * leave the running workspace disagreeing with its own files.
 *
 * Keyed by every metadata kind, so a new kind fails to compile until someone decides
 * which it is. The paths repeat shared/properties/projectMetadata.ts METADATA_FILES
 * (a test holds them equal) to keep its parsers out of the Worker bundle.
 */
export const INCOMING_METADATA = {
  // The audits panel's ignore list, read when the panel loads (auditsBridge.ts).
  audits: { file: '.stacki/audits.json', sync: 'live' },
  // Preview breakpoint widths, read by the preview bar (projectBreakpoints.ts).
  breakpoints: { file: '.stacki/breakpoints.json', sync: 'live' },
  // Package component sources, read on each component scan (componentSources.ts).
  componentSources: { file: '.stacki/component-sources.json', sync: 'live' },
  // Insertion defaults, read on each defaults load (loadDefaults.ts).
  components: { file: '.stacki/components.json', sync: 'live' },
  // Restart: the component preview route's globs are written from these folders once,
  // at container start (server/integration.ts astro:config:setup).
  folders: { file: '.stacki/folders.json', sync: 'restart' },
  // Column guide preferences, read by the canvas on load.
  guide: { file: '.stacki/guide.json', sync: 'live' },
  // AI instructions, read when the instructions panel loads (instructionsBridge.ts).
  instructions: { file: '.stacki/instructions.json', sync: 'live' },
  // Page order, read by the pages panel.
  pages: { file: '.stacki/pages.json', sync: 'live' },
  // Publish settings, read on every publish and availability check (publish.ts).
  publish: { file: '.stacki/publish.json', sync: 'live' },
  // Project roles, read on every access check (roles/serverAccess.ts requestRole).
  // Until it syncs, a workspace created before the file existed runs everyone as admin.
  roles: { file: '.stacki/roles.json', sync: 'live' },
  // The selectors panel's keep list, read when the panel loads.
  styles: { file: '.stacki/styles.json', sync: 'live' },
  // Hidden-variable settings, read by the variables panel (hiddenVariables.ts).
  variables: { file: '.stacki/variables.json', sync: 'live' },
} as const satisfies Record<MetadataKind, { readonly file: `.stacki/${string}.json`; readonly sync: 'live' | 'restart' }>;

const LIVE_METADATA_FILES: ReadonlySet<string> = new Set(
  Object.values(INCOMING_METADATA)
    .filter((entry) => entry.sync === 'live')
    .map((entry) => entry.file),
);

/**
 * Whether a file GitHub changed can be written into the running workspace. Site
 * source under src/ and live metadata can; anything else (dependencies, Astro or
 * Vite configuration, public/ binaries, restart metadata) needs a fresh container
 * with dependencies installed.
 */
export function syncableIncomingFile(file: string): boolean {
  if (/^src\/.+\.(astro|json|md|mdx|css|ts|js)$/.test(file)) {
    return true;
  }
  return LIVE_METADATA_FILES.has(file);
}
