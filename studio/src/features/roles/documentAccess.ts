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
// A role whose editing options are limited (shared/properties/projectRoles.ts) is
// held to them here too: which named actions it may send (editorActions.ts), and,
// for an edit that arrives as text, that it only changes what the role may change
// (`assertEditorContentAllowed`, editorContent.ts).
//
// This module stays free of Node imports: the room that calls it is also
// type-checked for the browser demo.
import { assert } from '../../../vendor/stacki/shared/core/assert';
import { isDefaultsCanvas } from '../../../vendor/stacki/shared/properties/defaultsCanvas';
import { METADATA_FILES, type MetadataKind } from '../../../vendor/stacki/shared/properties/projectMetadata';
import { can, type AccessFeature, type RoleView } from '../../../vendor/stacki/shared/properties/projectRoles';
import { limitsEditing, readOnlyEditor } from '../../../vendor/stacki/shared/properties/projectRoles';
import { editorActionRefusal } from './editorActions';
import { checkEditorContent, type ContentRefusal } from './editorContent';
import { componentTextProps, printedLiterals, type SourceReader } from './editorFacts';
import type { TreeAction } from '../source/source';
import { assertClientAction, assertClientSourceChange } from './clientPolicy';
import { checkComponentImports, checkComponentInsert, type ComponentHiddenError } from './componentAccess';
import type { ComponentImport } from '../source/imports';

/** What each project settings file needs to be written. */
export const METADATA_ACCESS: Readonly<Record<MetadataKind, readonly AccessFeature[] | undefined>> = {
  // The component canvas's frames and preview values belong to whoever edits components.
  componentCanvas: ['component:edit'],
  componentSources: ['settings:folders'],
  components: ['component:edit'],
  folders: ['settings:folders'],
  // Column guides are a view preference kept with the project; anyone who sees the canvas sets them.
  guide: undefined,
  instructions: ['settings:instructions', 'instructions:edit'],
  // Ignoring an audit finding is part of working in the Audits panel.
  audits: ['panel:audits', 'settings:audits'],
  breakpoints: ['settings:breakpoints'],
  breakpointSync: ['settings:breakpoints'],
  pages: ['panel:pages'],
  publish: ['publish'],
  publishDestinations: ['publish'],
  roles: ['settings:roles'],
  styles: ['panel:selectors'],
  variables: ['panel:style'],
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
  // Adding a hidden component is refused whatever the role's other powers; its existing instances are not touched.
  assertComponentsAllowed(checkComponentImports(role, file, before, after, []));
  if (can(role, 'page:layout')) {
    return;
  }
  // Client mode, exactly as the browser enforces it before sending.
  assertClientSourceChange(file, before, after);
}

/** Throws when `role` may not insert the component `action` names, with the project's configured import paths to resolve it. */
export function assertComponentInsertAllowed(role: RoleView, file: string, action: TreeAction, configured: readonly ComponentImport[]): void {
  assertComponentsAllowed(checkComponentInsert(role, file, action, configured));
}

// The typed refusal becomes the room's thrown one at this edge, before any edit is applied.
function assertComponentsAllowed(checked: { readonly ok: true } | { readonly ok: false; readonly error: ComponentHiddenError }): void {
  if (!checked.ok) {
    throw new RoleRefusal(checked.error.message);
  }
}

/** Throws when `role` may not apply the structural `action` to `file` holding `source`. */
export function assertDocumentActionAllowed(role: RoleView, file: string, source: string, action: TreeAction): void {
  assert(source.length > 0, 'A structural action edits a non-empty source');
  assertDocumentWritable(role, file);
  const refusal = editorActionRefusal(role, file, source, action);
  if (refusal !== undefined) {
    throw new RoleRefusal(`Your role (${role.name}) ${refusal} Ask an admin for access.`);
  }
  if (can(role, 'page:layout')) {
    return;
  }
  if (!file.startsWith('src/pages/')) {
    throw new RoleRefusal('Component source is protected in Client mode.');
  }
  assertClientAction(source, action);
}

const CONTENT_REFUSALS: Readonly<Record<ContentRefusal, string>> = {
  text: 'cannot change text in this project.',
  images: 'cannot change images in this project.',
  structure: 'cannot add, remove or reorder elements this way in this project.',
  settings: 'cannot change styles or settings in this project.',
};

/**
 * Throws when a limited role's text edit of `file` changes more than its editing
 * options allow. Reads the page's components first, so it is not part of
 * `assertDocumentChangeAllowed`, and named actions do not pass through it: those
 * are judged by what they do (editorActions.ts).
 */
export async function assertEditorContentAllowed(
  role: RoleView,
  file: string,
  change: { readonly before: string; readonly after: string },
  read: SourceReader,
): Promise<void> {
  if (!limitsEditing(role.editorOff) || !file.endsWith('.astro')) {
    return;
  }
  assert(!role.isAdmin, 'Admin has no editing limits');
  // Without the panel, knowing of no component prop or printed string can only refuse more. So typing in the page's
  // own text and swapping a picture are accepted at once, and the components are read only for what that refuses.
  const unread = { off: role.editorOff, textProp: () => undefined, literals: { before: [], after: [] } };
  if (role.editorOff.has('sidePanel') && checkEditorContent(change.before, change.after, unread).ok) {
    return;
  }
  const textProp = await componentTextProps(file, [change.before, change.after], read);
  const checked = checkEditorContent(change.before, change.after, {
    off: role.editorOff,
    textProp,
    literals: {
      before: await printedLiterals(file, change.before, textProp),
      after: await printedLiterals(file, change.after, textProp),
    },
  });
  if (!checked.ok) {
    throw new RoleRefusal(`Your role (${role.name}) ${CONTENT_REFUSALS[checked.refusal]} Ask an admin for access.`);
  }
}

function assertDocumentWritable(role: RoleView, file: string): void {
  // A read only role writes nothing at all, the column guide included.
  if (readOnlyEditor(role.editorOff)) {
    throw roleRefusal(role);
  }
  // Under a limit, the only page files a role writes are the Astro pages the content check can read.
  if (limitsEditing(role.editorOff) && file.startsWith('src/pages/') && !file.endsWith('.astro')) {
    throw roleRefusal(role);
  }
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
