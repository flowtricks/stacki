// The "Build an app" prompt the Apps panel copies: short on purpose, it gets an
// AI agent started (what an app is, the files, the API in brief, how to test)
// and links to the full guide (docs/apps.md). Its one source is
// docs/apps-prompt.md, through its generated module; test/renderer/apps/appPrompt.test.js
// holds the module to the Markdown.
import { assert } from '../../../shared/core/assert';
import { APPS_PROMPT } from './generated/appsPrompt';

/** The prompt, ready for the clipboard. */
export function appBuildPrompt(): string {
  assert(APPS_PROMPT.length > 0, 'The prompt is never empty');
  return APPS_PROMPT;
}

/** Copies the prompt; false when the clipboard refused. */
export async function copyAppBuildPrompt(): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(appBuildPrompt());
    return true;
  } catch {
    return false;
  }
}
