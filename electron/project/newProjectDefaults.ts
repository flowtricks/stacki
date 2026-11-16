// The `.stacki` settings a project made by Stacki starts with.
//
// A site started from a starter or from `create astro` gets `newStyleTag.isGlobal` on in
// `.stacki/styles.json`, so the first style the panel writes lands in a `<style is:global>` tag that
// reaches the elements it was written for. A project that already has the file keeps everything in
// it (shared/properties/styleKeepList.ts newProjectStylesSource); a project that never went through
// here (an existing site opened in Stacki, or given Studio by create-stacki) keeps the legacy
// behaviour, a plain `<style>`, until its owner turns the setting on.

import fs from 'fs';
import path from 'path';
import { newProjectStylesSource } from '../../shared/properties/styleKeepList';

/** Writes the new-project defaults into `directory`. Returns the reason when nothing was written. */
export function writeNewProjectDefaults(directory: string): { readonly written: true } | { readonly written: false; readonly reason: string } {
  const file = path.join(directory, '.stacki', 'styles.json');
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
  const source = newProjectStylesSource(existing);
  if (source === undefined) {
    return { written: false, reason: '.stacki/styles.json is not a styles file Stacki reads; it was left as it is.' };
  }
  if (source === existing) {
    return { written: true };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source, 'utf8');
  return { written: true };
}
