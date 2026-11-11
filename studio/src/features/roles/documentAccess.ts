// What a role may change in a shared document: the collaboration socket's half
// of project roles. The HTTP gate (serverAccess.ts) guards write routes; edits
// to an open document arrive over `/studio/sync` instead, so the room checks
// every `update` and `action` here before it applies one. The browser runs the
// same Client-mode policy (clientPolicy.ts) to keep a refused edit off the
// canvas, but only the server's check holds.
//
// Which feature a document needs follows the HTTP routes that write the same
// files: component source and defaults canvases need `component:edit`,
// stylesheets the Style, Selectors or Code feature, settings files the feature
// of their kind, collection entries `panel:cms` (or raw `code:edit`), and other
// code `code:edit`. Page files are open to every role, but a role without
// `page:layout` edits only inside the page layout (Client mode).
//
// This module stays free of Node imports: the room that calls it is also
// type-checked for the browser demo.
import { assert } from '../../../vendor/stacki/shared/core/assert';
import { isDefaultsCanvas } from '../../../vendor/stacki/shared/properties/defaultsCanvas';
import { METADATA_FILES, type MetadataKind } from '../../../vendor/stacki/shared/properties/projectMetadata';
import { can, type AccessFeature, type RoleView } from '../../../vendor/stacki/shared/properties/projectRoles';
import type { TreeAction } from '../source/source';
import { assertClientAction, assertClientSourceChange } from './clientPolicy';

/** What each project settings file needs to be written (Desktop's electron/handlers/channelAccess.ts holds the same). */
export const METADATA_ACCESS: Readonly<Record<MetadataKind, readonly AccessFeature[] | undefined>> = {
  componentSources: ['settings:folders'],
  components: ['component:edit'],
  folders: ['settings:folders'],
  // Column guides are a view preference kept with the project; anyone who sees the canvas sets them.
  guide: undefined,
  instructions: ['settings:instructions', 'instructions:edit'],
  // Ignoring an audit finding is part of working in the Audits panel.
  audits: ['panel:audits', 'settings:audits'],
  pages: ['panel:pages'],
  publish: ['publish'],
  roles: ['settings:roles'],
  styles: ['panel:selectors'],
};

/** A write refused for the sender's role: answered 403 over HTTP, an `error` message over the socket. */
export class RoleRefusal extends Error {
  override readonly name = 'RoleRefusal';
}

/** The refusal every gate words the same way. */
export function roleRefusal(role: RoleView): RoleRefusal {
  assert(!role.isAdmin, 'Admin is never refused');
  return new RoleRefusal(`Your role (${role.name}) cannot do this in this project. Ask an admin for access.`);
}

/** Stylesheets: the same features as `/studio/api/source`, which writes them over HTTP. */
const STYLE_FEATURES: readonly AccessFeature[] = ['panel:style', 'panel:selectors', 'code:edit'];
/** Collection entries and data files: the CMS panel edits them, raw code editing covers them too. */
const CONTENT_FEATURES: readonly AccessFeature[] = ['panel:cms', 'code:edit'];
const COMPONENT_FEATURES: readonly AccessFeature[] = ['component:edit'];
const CODE_FEATURES: readonly AccessFeature[] = ['code:edit'];

/**
 * The features that allow writing `file` (any one is enough), or undefined when
 * every role may write it: page files, whose Client-mode limit is checked per
 * edit, and the column guide.
 */
export function documentFeatures(file: string): readonly AccessFeature[] | undefined {
  assert(file.length > 0, 'A document names a file');
  if (file.startsWith('src/pages/')) {
    return undefined;
  }
  if (isDefaultsCanvas(file)) {
    return COMPONENT_FEATURES;
  }
  const metadata = Object.entries(METADATA_FILES).find(([, name]) => name === file);
  if (metadata !== undefined) {
    return METADATA_ACCESS[metadataKindOf(metadata[0])];
  }
  if (/\.astro$/i.test(file)) {
    return COMPONENT_FEATURES;
  }
  if (/\.(css|scss|sass|less)$/i.test(file)) {
    return STYLE_FEATURES;
  }
  if (/\.(json|md|mdx|mdoc|markdown|yaml|yml|toml|csv|ndjson)$/i.test(file)) {
    return CONTENT_FEATURES;
  }
  return CODE_FEATURES;
}

/** Throws when `role` may not change `file` from `before` to `after`. */
export function assertDocumentChangeAllowed(role: RoleView, file: string, before: string, after: string): void {
  assert(before !== after, 'Only a real change is checked');
  assertDocumentWritable(role, file);
  if (can(role, 'page:layout')) {
    return;
  }
  // Client mode, exactly as the browser enforces it before sending.
  assertClientSourceChange(file, before, after);
}

/** Throws when `role` may not apply the structural `action` to `file` holding `source`. */
export function assertDocumentActionAllowed(role: RoleView, file: string, source: string, action: TreeAction): void {
  assert(source.length > 0, 'A structural action edits a non-empty source');
  assertDocumentWritable(role, file);
  if (can(role, 'page:layout')) {
    return;
  }
  if (!file.startsWith('src/pages/')) {
    throw new RoleRefusal('Component source is protected in Client mode.');
  }
  assertClientAction(source, action);
}

function assertDocumentWritable(role: RoleView, file: string): void {
  const features = documentFeatures(file);
  if (features === undefined) {
    return;
  }
  assert(features.length > 0, 'A gated document names at least one feature');
  if (features.some((feature) => can(role, feature))) {
    return;
  }
  throw roleRefusal(role);
}

function metadataKindOf(name: string): MetadataKind {
  const kind = Object.keys(METADATA_ACCESS).find((key): key is MetadataKind => key === name);
  assert(kind !== undefined, 'Every metadata file has an access rule');
  return kind;
}
