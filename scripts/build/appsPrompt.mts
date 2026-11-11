// docs/apps-prompt.md is the one source of the Apps panel's short "Build an app"
// prompt, which links to the full guide (docs/apps.md, the website's page). The
// panel cannot read a Markdown file at run time in every host (Desktop, Studio,
// the static demo), so this script writes it into a TypeScript module the panel
// imports. test/renderer/apps/appPrompt.test.js fails when the module and the
// Markdown differ, so the two cannot drift.
// Usage:
// `node scripts/build/appsPrompt.mts` writes the module, and with `--check` exits 1 when it is stale.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SOURCE = fileURLToPath(new URL('../../docs/apps-prompt.md', import.meta.url));
const TARGET = fileURLToPath(new URL('../../src/features/apps/generated/appsPrompt.ts', import.meta.url));
// Short on purpose: the prompt gets an agent started and links to the full guide.
const PROMPT_CHARS_MAX = 8_000;

/** The module's text for a guide. */
export function appsPromptModule(markdown: string): string {
  if (markdown.length === 0 || markdown.length > PROMPT_CHARS_MAX) {
    throw new Error(`docs/apps-prompt.md must be 1 to ${PROMPT_CHARS_MAX} characters`);
  }
  return [
    '// Generated from docs/apps-prompt.md by scripts/build/appsPrompt.mts. Do not edit:',
    '// change docs/apps-prompt.md and run `node scripts/build/appsPrompt.mts`.',
    `export const APPS_PROMPT: string = ${JSON.stringify(markdown)};`,
    '',
  ].join('\n');
}

const expected = appsPromptModule(readFileSync(SOURCE, 'utf8'));
if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(TARGET, 'utf8');
  } catch {
    current = '';
  }
  if (current !== expected) {
    console.error('src/features/apps/generated/appsPrompt.ts is stale: run node scripts/build/appsPrompt.mts');
    process.exit(1);
  }
} else {
  writeFileSync(TARGET, expected);
}
