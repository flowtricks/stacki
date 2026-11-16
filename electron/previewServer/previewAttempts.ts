// The ways the preview route tries to draw one component, best first, and the key of the result. A real
// instance or insertion recipe is the truest picture; without one, the component gets sample props from its
// own types and sample content in its slots; when that throws, plainer inputs; the last attempt has no slot
// at all. The route renders them as nested guards (componentPreview.ts), so the first that renders wins and a
// throw in one costs a render, not a preview. Pure: it reads text and returns JSON.

import * as path from 'node:path';
import { assert } from '../../shared/core/assert';
import type { ComponentPropModel } from '../../shared/properties/propModel';
import { PREVIEW_ATTEMPT_LABELS, snapshotKey, type PreviewAttemptLabel } from '../../shared/properties/previewSnapshot';
import { parseSlots, defaultSlotInline } from '../parse/astroComponentApi';
import { sampleInputs, type PreviewJSON } from './previewSampleProps';
import { resolveImportFile, type PathAliases, type PreludeFiles } from './previewTypePrelude';

export const ATTEMPT_LIMITS = {
  /** Named slots filled with sample content; the generated page writes one position for each. */
  namedSlotsMax: 6,
  dependenciesMax: 64,
} as const;

/** Content for a component's slots when nothing real exists: a line of text, or a heading and a paragraph. */
export interface SampleSlot {
  readonly kind: 'sample';
  readonly html: string;
  readonly named: readonly { readonly name: string; readonly html: string }[];
}

export interface PreviewAttempt<S> {
  readonly label: PreviewAttemptLabel;
  readonly props: Readonly<Record<string, PreviewJSON>>;
  readonly slot: S | SampleSlot | { readonly kind: 'name' } | { readonly kind: 'none' };
}

export interface AttemptInputs<S> {
  readonly source: string;
  readonly name: string;
  readonly model: ComponentPropModel;
  /** What the route draws from a recipe or a real instance, when the project has one. */
  readonly authored: { readonly props: Readonly<Record<string, PreviewJSON>>; readonly slot: S; readonly complete: boolean } | undefined;
  /** The props the route always sets (design-mode switches, words for text props), with no instance behind them. */
  readonly baseProps: Readonly<Record<string, PreviewJSON>>;
}

export function buildPreviewAttempts<S extends { readonly kind: string }>(input: AttemptInputs<S>): readonly PreviewAttempt<S>[] {
  const attempts: PreviewAttempt<S>[] = [];
  const add = (attempt: PreviewAttempt<S>): void => {
    if (!attempts.some((existing) => JSON.stringify([existing.props, existing.slot]) === JSON.stringify([attempt.props, attempt.slot]))) {
      attempts.push(attempt);
    }
  };
  if (input.authored !== undefined && input.authored.complete) {
    add({ label: 'authored', props: input.authored.props, slot: input.authored.slot });
  }
  const required = sampleInputs(input.model, input.name, 'required').props;
  const illustrative = sampleInputs(input.model, input.name, 'illustrative').props;
  const real = input.authored?.props ?? input.baseProps;
  const hasSlot = /<slot\b/.test(input.source) || parseSlots(input.source).length > 0;
  const rich = hasSlot ? sampleSlot(input.source) : ({ kind: 'none' } as const);
  const realSlot = input.authored !== undefined && input.authored.slot.kind !== 'name' ? input.authored.slot : rich;
  add({ label: 'sample', props: { ...illustrative, ...real }, slot: realSlot });
  add({ label: 'sample-minimal', props: { ...required, ...input.baseProps }, slot: hasSlot ? { kind: 'name' } : { kind: 'none' } });
  add({ label: 'sample-bare', props: { ...required }, slot: { kind: 'none' } });
  assert(attempts.length <= PREVIEW_ATTEMPT_LABELS.length, 'There is at most one attempt per label');
  assert(attempts.length > 0, 'There is always an attempt');
  return attempts;
}

/** Sample content for a component's slots: text where the slot sits inside a line of text, blocks otherwise. */
export function sampleSlot(source: string): SampleSlot {
  const inline = defaultSlotInline(source);
  const named = parseSlots(source)
    .filter((slot) => slot !== 'default' && slot !== '')
    .slice(0, ATTEMPT_LIMITS.namedSlotsMax)
    .map((name) => ({ name, html: `<div>Sample ${escapeText(name)}</div>` }));
  const html = inline ? 'Sample text' : '<h3>Sample heading</h3><p>This is sample text that shows how the component lays out its content.</p>';
  return { kind: 'sample', html, named };
}

function escapeText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

const DEPENDENCY_FILE = /\.(astro|ts|tsx|mts|js|mjs|json|css|scss)$/;

/**
 * The text of the files a component imports, directly and through those files' own imports, in the order met.
 * They decide the key: editing a dependency changes how the component looks. Bounded by file count only.
 */
export function previewDependencySources(componentFile: string, source: string, aliases: PathAliases | undefined, files: PreludeFiles): readonly string[] {
  assert(path.isAbsolute(componentFile), 'Dependencies are read from an absolute component path');
  const texts: string[] = [];
  const seen = new Set<string>([componentFile]);
  const pending: { readonly file: string; readonly text: string }[] = [{ file: componentFile, text: source }];
  for (let step = 0; step < ATTEMPT_LIMITS.dependenciesMax * 2 && pending.length > 0 && texts.length < ATTEMPT_LIMITS.dependenciesMax; step += 1) {
    const entry = pending.shift();
    if (entry === undefined) {
      break;
    }
    for (const specifier of importSpecifiers(entry.text)) {
      const resolved = resolveImportFile(specifier, entry.file, aliases, files, DEPENDENCY_FILE);
      if (resolved === undefined || seen.has(resolved)) {
        continue;
      }
      seen.add(resolved);
      const text = files.read(resolved);
      if (text !== undefined && texts.length < ATTEMPT_LIMITS.dependenciesMax) {
        texts.push(text);
        pending.push({ file: resolved, text });
      }
    }
  }
  assert(texts.length <= ATTEMPT_LIMITS.dependenciesMax, 'Dependencies are bounded');
  return texts;
}

function importSpecifiers(text: string): readonly string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/(?:\bfrom\s*|\bimport\s*|@import\s*|@use\s*)['"]([^'"\n]+)['"]/g)) {
    const specifier = match[1];
    if (specifier !== undefined && found.length < 512) {
      found.push(specifier);
    }
  }
  return found;
}

/** The key of a component's snapshot: its source, its dependencies, the project's styles and the inputs drawn. */
export function previewKey(parts: {
  readonly source: string;
  readonly dependencies: readonly string[];
  readonly styles: string;
  readonly attempts: readonly unknown[];
}): string {
  return snapshotKey({ source: parts.source, dependencies: parts.dependencies, styles: parts.styles, inputs: JSON.stringify(parts.attempts), theme: '' });
}
